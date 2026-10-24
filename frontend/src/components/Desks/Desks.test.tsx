import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeskCardsView, DeskThreadHeader, OutcomeLine, runCard, type CardDeps } from './DeskCards';
import { DesksView, SoulEditor, type DesksViewProps } from './DesksView';
import { deskTrace } from '../../pages/DesksPage';
import { proposalContext } from '../../pages/ContentPage';
import { prospectContext } from '../../pages/BizDevPage';
import { groupConversations } from '../Sidebar/ConversationList';
import { ProposalCard } from '../Content/ProposalsQueue';
import { DraftComposer } from '../BizDev/DraftComposer';
import { ProspectDrawer } from '../BizDev/ProspectDrawer';
import { DecisionsView, findCardBox } from '../Waiting/DecisionsDrawer';
import { parseCards, validateCard, type DeskCard } from '../../lib/desk-cards';
import { CONTEXT_MAX, DESK_DEFAULTS, contextBlock, type DeskInfo } from '../../lib/desks-api';
import type { Proposal } from '../../lib/content-api';
import type { PipelineProspect, SendConfig } from '../../lib/bizdev-api';
import type { DecisionBox, Decisions } from '../../lib/waiting-api';
import type { Conversation } from '../../types';
import app from '../../App.tsx?raw';
import sidebar from '../Sidebar/Sidebar.tsx?raw';

// The app store reads localStorage when it loads; node has none.
vi.hoisted(() => {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> }).localStorage ??= {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  };
});

// Desks (hq 0020 P2). Neutral fixtures only: this repo is public.
const UUID = '0b6d2c1e-1111-4222-8333-444455556666';
const content = DESK_DEFAULTS.content;
const bd = DESK_DEFAULTS.bd;
const fence = (obj: unknown) => '```card\n' + JSON.stringify(obj) + '\n```';

afterEach(() => vi.restoreAllMocks());

describe('cards: parse and validate', () => {
  it('each kind validates on the Content desk', () => {
    const reply = [
      'Here is what I suggest.',
      fence({ kind: 'open', label: 'Open it', target: { page: '/content', focus: UUID } }),
      fence({ kind: 'tick', label: 'Tick D1', target: { file: 'openjarvis/sample-brief.md', box: 'D1' }, body: { note: 'app' } }),
      fence({
        kind: 'proposal_decision',
        label: 'Approve with a sharper topic',
        target: { id: UUID },
        body: { decision: 'approve', topic: 'A sharper sample topic', note: 'from the desk', priority: 2 },
      }),
      fence({ kind: 'ruling', label: 'Remember this', body: { text: 'Prefer  short\nhooks.' } }),
    ].join('\n\n');
    const { text, cards, dropped } = parseCards(reply, content);
    expect(text).toBe('Here is what I suggest.');
    expect(dropped).toEqual([]);
    expect(cards.map((c) => c.kind)).toEqual(['open', 'tick', 'proposal_decision', 'ruling']);
    expect(cards[1]).toMatchObject({ file: 'openjarvis/sample-brief.md', box: 1, note: 'app' });
    expect(cards[2]).toMatchObject({ id: UUID, decision: 'approve', fields: { topic: 'A sharper sample topic', priority: 2 } });
    expect(cards[3]).toMatchObject({ text: 'Prefer short hooks.' });
  });

  it('an unknown kind or a bad target is dropped visibly', () => {
    const reply = [
      fence({ kind: 'send', label: 'Send it' }),
      fence({ kind: 'open', label: 'Trading', target: { page: '/trading', focus: 'x' } }),
      fence({ kind: 'tick', label: 'Tick', target: { file: '../etc/passwd', box: 'D1' } }),
      fence({ kind: 'proposal_decision', label: 'Bad id', target: { id: 'nope' }, body: { decision: 'approve' } }),
      fence({ kind: 'ruling', label: 'Too long', body: { text: 'x'.repeat(501) } }),
      '```card\n{not json\n```',
    ].join('\n');
    const { cards, dropped } = parseCards(reply, content);
    expect(cards).toEqual([]);
    expect(dropped.map((d) => d.reason)).toEqual([
      'unknown kind “send”',
      "this desk can't open /trading",
      'not an inbox brief (<folder>/<name>.md)',
      'not a proposal id',
      'a ruling is at most 500 characters',
      'not valid JSON',
    ]);
    const html = renderToStaticMarkup(<DeskCardsView cards={cards} dropped={dropped} />);
    expect(html).toContain('Dropped a card “Send it”: unknown kind “send”.');
  });

  it('the BD desk may only open /bizdev (with a draft) and record rulings', () => {
    expect(validateCard({ kind: 'tick', label: 't', target: { file: 'a/b.md', box: 'D1' } }, bd)).toEqual({
      dropped: { label: 't', reason: "tick cards aren't allowed on this desk" },
    });
    expect('dropped' in validateCard({ kind: 'proposal_decision', target: { id: UUID }, body: { decision: 'reject' } }, bd)).toBe(true);
    expect(validateCard({ kind: 'open', label: 'Follow up', target: { page: '/bizdev', focus: 12 }, body: { draft: 'Hi there' } }, bd)).toEqual({
      card: { kind: 'open', label: 'Follow up', page: '/bizdev', focus: '12', draft: 'Hi there' },
    });
    expect('dropped' in validateCard({ kind: 'open', target: { page: '/bizdev', focus: 'abc' } }, bd)).toBe(true);
    // /content has no text field for a draft.
    const r = validateCard({ kind: 'open', label: 'o', target: { page: '/content', focus: UUID }, body: { draft: 'x' } }, content);
    expect(r).toEqual({ dropped: { label: 'o', reason: '/content has no text field for a draft' } });
  });

  it('a card still streaming is hidden, not shown raw', () => {
    const { text, cards } = parseCards('Answer.\n\n```card\n{"kind": "ruling", "bo', content);
    expect(text).toBe('Answer.');
    expect(cards).toEqual([]);
  });
});

describe('card clicks go through the existing controls', () => {
  function deps(): CardDeps & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      navigate: vi.fn((to: string) => void calls.push(`navigate ${to}`)),
      setHandoff: vi.fn((h) => void calls.push(`handoff ${h.kind}`)),
      addOutcome: vi.fn((_t: string, text: string) => void calls.push(`outcome ${text}`)),
      openDecisions: vi.fn(() => void calls.push('decisions')),
      addRuling: vi.fn(async () => void calls.push('ruling')),
    };
  }

  it('open navigates and prefills, and never calls a send route', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const d = deps();
    const card: DeskCard = { kind: 'open', label: 'o', page: '/bizdev', focus: '12', draft: 'Hi there' };
    await runCard(card, 'thread-1', 'bd', d);
    expect(d.calls).toEqual([
      'handoff draft',
      'navigate /bizdev?focus=12',
      'outcome Opened /bizdev (12), draft in the message field',
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(d.addRuling).not.toHaveBeenCalled();
  });

  it('proposal_decision only opens the editor: nothing is submitted', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const d = deps();
    await runCard({ kind: 'proposal_decision', label: 'a', id: UUID, decision: 'approve', fields: { topic: 't' } }, 'th', 'content', d);
    expect(d.calls[0]).toBe('handoff proposal_decision');
    expect(d.calls[1]).toBe(`navigate /content?focus=${UUID}`);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('tick opens the Decisions drawer for its two-click confirm', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const d = deps();
    await runCard({ kind: 'tick', label: 't', file: 'openjarvis/sample.md', box: 1, note: '' }, 'th', 'content', d);
    expect(d.calls).toEqual(['handoff tick', 'decisions']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('ruling records one ruling and says so in the thread', async () => {
    const d = deps();
    await runCard({ kind: 'ruling', label: 'r', text: 'Prefer short hooks.' }, 'th', 'content', d);
    expect(d.addRuling).toHaveBeenCalledWith('content', 'Prefer short hooks.', 'th');
    expect(d.calls).toEqual(['ruling', 'outcome Ruling recorded']);
  });
});

describe('the tick card meets the Decisions drawer', () => {
  const box: DecisionBox = {
    file: 'openjarvis/sample.md', folder: 'openjarvis', title: 'Sample brief', modified_at: '2026-10-24T00:00:00Z',
    number: 1, ticked: false, decision: 'Soul editing in the app', default: 'app', alternative: 'file',
    text: 'D1', decided_note: null, line: 9, hash: 'a'.repeat(64),
  };
  const decisions: Decisions = { open: [box], waiting_briefs: [], recently_decided: [] };

  it('finds the open box by brief and number, or nothing', () => {
    expect(findCardBox(decisions, 'openjarvis/sample.md', 1)).toBe(box);
    expect(findCardBox(decisions, 'openjarvis/sample.md', 2)).toBeNull();
  });

  it('marks the box without arming it', () => {
    const html = renderToStaticMarkup(
      <DecisionsView
        decisions={decisions} loading={false} error={null} states={{}} notes={{ 'openjarvis/sample.md:9': 'from the desk' }}
        message={null} now={Date.now()} onNote={vi.fn()} onArm={vi.fn()} onTick={vi.fn()}
        highlight="openjarvis/sample.md:9"
      />,
    );
    expect(html).toContain('A desk proposed this tick.');
    expect(html).toContain('Tick D1');
    expect(html).not.toContain('Confirm tick');
    expect(html).toContain('value="from the desk"');
  });
});

describe('Ask the desk: page context', () => {
  it('is one fenced context block within 8 KB, with no secret-looking keys', () => {
    const block = contextBlock({ id: 1, topic: 'Sample', api_key: 'sample-secret', nested: { token: 'x', ok: 1 }, big: 'y'.repeat(20000) });
    expect(block.startsWith('```context\n')).toBe(true);
    const json = JSON.parse(block.slice('```context\n'.length, block.lastIndexOf('\n```')));
    expect(json).toEqual({ id: 1, topic: 'Sample', nested: { ok: 1 }, _trimmed: true });
    expect(new TextEncoder().encode(JSON.stringify(json)).length).toBeLessThanOrEqual(CONTEXT_MAX);
  });

  it('a proposal goes as the card shows it', () => {
    const p = { id: UUID, property_id: 'alpha', lane: 'short', content_type: 'short', status: 'pending', topic: 'A sample topic',
      pillar_hint: 'grit', product_handle: null, created_at: '2026-10-24T00:00:00Z', note: null } as Proposal;
    const ctx = proposalContext(p);
    expect(ctx.label).toBe('proposal “A sample topic”');
    expect(ctx.block).toContain('"kind":"proposal"');
    expect(ctx.block).toContain(UUID);
    expect(ctx.block).not.toContain('product_handle');
  });

  it('a prospect goes without its contacts or draft', () => {
    const p = {
      id: 12, name: 'Sample College', stage: 'sent', contacts: [{ name: 'A Person', email: 'a@example.edu' }],
      draft: { subject: 's', body: 'b' },
    } as PipelineProspect;
    const ctx = prospectContext(p);
    expect(ctx.label).toBe('Sample College');
    expect(ctx.block).toContain('"stage":"sent"');
    expect(ctx.block).not.toContain('example.edu');
    expect(ctx.block).not.toContain('"draft"');
  });
});

describe('the drafts land in the existing fields', () => {
  it("a proposal_decision card opens the approve editor filled in, unsent", () => {
    const p = { id: UUID, property_id: 'alpha', lane: 'short', content_type: 'short', status: 'pending', topic: 'Old topic',
      pillar_hint: 'grit', product_handle: null, created_at: '2026-10-24T00:00:00Z', note: null } as Proposal;
    const onApprove = vi.fn();
    const html = renderToStaticMarkup(
      <ProposalCard
        proposal={p} pillars={['grit']} showProperty={false} onApprove={onApprove} onReject={vi.fn()}
        deskDecision={{ id: UUID, decision: 'approve', fields: { topic: 'A sharper topic', note: 'desk note' }, nonce: 1 }}
      />,
    );
    expect(html).toContain('Filled in from the Content desk’s card.');
    expect(html).toContain('A sharper topic');
    expect(html).toContain('desk note');
    expect(onApprove).not.toHaveBeenCalled();
    const reject = renderToStaticMarkup(
      <ProposalCard
        proposal={p} pillars={[]} showProperty={false} onApprove={vi.fn()} onReject={vi.fn()}
        deskDecision={{ id: UUID, decision: 'reject', fields: { note: 'off brand' }, nonce: 2 }}
      />,
    );
    expect(reject).toContain('Reject permanently');
    expect(reject).toContain('off brand');
  });

  it('shows Ask the desk on a proposal when wired', () => {
    const p = { id: UUID, property_id: 'alpha', lane: 'short', content_type: 'short', status: 'pending', topic: 'T',
      pillar_hint: null, product_handle: null, created_at: '2026-10-24T00:00:00Z', note: null } as Proposal;
    const html = renderToStaticMarkup(
      <ProposalCard proposal={p} pillars={[]} showProperty={false} onApprove={vi.fn()} onReject={vi.fn()} onAskDesk={vi.fn()} />,
    );
    expect(html).toContain('Ask the desk');
  });

  it("an open card's draft starts the BD message body", () => {
    const config: SendConfig = {
      enabled: true, sender_name: 'Sample Sender', sender_address: 'sender@example.org', reply_to: 'sender@example.org',
      sender_title: 'Founder', missing: [],
    };
    const prospect = {
      id: 12, name: 'Sample College', stage: 'sent', contacts: [{ name: 'A Person', email: 'a.person@example.edu' }],
      draft: { subject: 'Hello', body: 'The stored body.' },
    } as PipelineProspect;
    const html = renderToStaticMarkup(
      <DraftComposer
        prospect={prospect} line={null} touch={2} draft={{ subject: 'Following up', body: 'The stored body.' }}
        sendConfig={config} onSend={async () => ({ fe_id: 'x', message_id: 'y', fe_status: 'queued', recorded: true })}
        onMarkSent={() => {}} prefillBody="The desk's follow-up text."
      />,
    );
    expect(html).toContain('The desk&#x27;s follow-up text.');
    expect(html).not.toContain('The stored body.');
  });
});

describe('the BD drawer', () => {
  it("shows the due follow-up's touch with the desk's draft in it, and Ask the desk", () => {
    const prospect = {
      id: 12, name: 'Sample College', stage: 'sent', contacts: [{ name: 'A Person', email: 'a.person@example.edu' }],
      draft: { subject: 'Hello', body: 'Touch one body.' },
    } as PipelineProspect;
    const html = renderToStaticMarkup(
      <ProspectDrawer
        prospect={prospect} onClose={() => {}} onMove={() => {}} onRecheck={() => {}} recheckDisabled={false}
        rechecksToday={0} recheckCap={5}
        followUp={{ prospect_id: 12, touch: 2, due: '2026-10-24', draft: { subject: 'Re: Hello', body: 'Stored follow-up.' } }}
        deskDraft="The desk draft." onAskDesk={() => {}}
      />,
    );
    expect(html).toContain('Draft: follow-up, touch 2');
    expect(html).toContain('data-composer-touch="2"');
    expect(html).toContain('The desk draft.');
    expect(html).toContain('Nothing is sent until you press Send.');
    expect(html).toContain('Ask the desk');
  });
});

describe('Chat: desk threads', () => {
  const conv = (over: Partial<Conversation>): Conversation => ({
    id: 'c', title: 'T', createdAt: 0, updatedAt: 0, model: 'auto', messages: [], ...over,
  });

  it('the conversation list groups threads by desk, chats after', () => {
    const groups = groupConversations([
      conv({ id: '1', title: 'chat' }),
      conv({ id: '2', desk: 'bd' }),
      conv({ id: '3', desk: 'content' }),
    ]);
    expect(groups.map((g) => [g.key, g.label, g.items.map((c) => c.id)])).toEqual([
      ['content', 'Content desk', ['3']],
      ['bd', 'BD desk', ['2']],
      ['chats', 'Chats', ['1']],
    ]);
    expect(groupConversations([conv({ id: '1' })])).toEqual([{ key: 'chats', label: null, items: [conv({ id: '1' })] }]);
  });

  it('the header names the desk and its default route; outcomes read as system lines', () => {
    expect(renderToStaticMarkup(<DeskThreadHeader desk="bd" context="Sample College" />)).toContain('Hermes by default');
    expect(renderToStaticMarkup(<DeskThreadHeader desk="content" />)).toContain('local by default');
    expect(renderToStaticMarkup(<OutcomeLine text="Ruling recorded" />)).toContain('Ruling recorded');
  });

  it('the trace collects this desk’s tool calls, newest first', () => {
    const call = (tool: string) => ({ id: tool, tool, arguments: '{}', status: 'success' as const });
    const rows = deskTrace(
      [
        conv({ id: 'a', desk: 'content', messages: [
          { id: 'm1', role: 'assistant', content: '', timestamp: 1, toolCalls: [call('brand_context')], telemetry: { route: 'local' } },
          { id: 'm2', role: 'assistant', content: '', timestamp: 5, toolCalls: [call('episode')] },
        ] }),
        conv({ id: 'b', desk: 'bd', messages: [{ id: 'm3', role: 'assistant', content: '', timestamp: 9, toolCalls: [call('panel_feed')] }] }),
      ],
      'content',
    );
    expect(rows.map((r) => r.call.tool)).toEqual(['episode', 'brand_context']);
    expect(rows[1].route).toBe('local');
  });
});

describe('the Desks page at /agents', () => {
  const desk = (over: Partial<DeskInfo> = {}): DeskInfo => ({
    id: 'content', name: 'Content desk', default_route: 'local', pages: ['/content'],
    local_tools: ['brand_context', 'episode', 'studio_status', 'panel_feed'], panel_feeds: ['content_proposals'],
    hermes_tools: ['content_proposals', 'web_search'], card_kinds: ['open', 'tick', 'proposal_decision', 'ruling'],
    cost_note: 'Local turns cost nothing.', soul: { exists: true, hash: 'h', chars: 12, max: 8000 }, rulings: 1, ...over,
  });
  const props = (over: Partial<DesksViewProps> = {}): DesksViewProps => ({
    desks: [desk(), desk({ id: 'bd', name: 'BD desk', default_route: 'hermes', pages: ['/bizdev'], local_tools: ['panel_feed'],
      card_kinds: ['open', 'ruling'], cost_note: 'A Hermes turn measured a sample cost.', soul: { exists: false, hash: null, chars: 0, max: 8000 }, rulings: 0 })],
    loading: false, error: null, dataConfigured: true, selected: 'content', onSelect: vi.fn(),
    soul: { exists: true, text: 'A sample soul', hash: 'h', chars: 13, max: 8000 }, soulDraft: 'A sample soul', onSoulDraft: vi.fn(),
    onSaveSoul: vi.fn(), onReloadSoul: vi.fn(), soulStatus: null, soulSaving: false,
    rulings: [{ id: 1, text: 'Prefer short hooks.', created_at: '2026-10-24T01:00:00Z', updated_at: '2026-10-24T01:00:00Z', thread: null }],
    rulingsError: null, onAddRuling: vi.fn(), onEditRuling: vi.fn(), onDeleteRuling: vi.fn(),
    threads: [{ id: 't1', title: 'Quote rule 2', updatedAt: 0, turns: 2 }], onOpenThread: vi.fn(), onNewThread: vi.fn(),
    trace: [{ key: 'k', thread: 't1', at: 0, route: 'local', call: { id: 'x', tool: 'brand_context', arguments: '{}', status: 'success' } }],
    live: false, now: 60_000, ...over,
  });

  it('renders the roster and the selected desk: soul, route, tools, rulings, threads and trace', () => {
    const html = renderToStaticMarkup(<DesksView {...props()} />);
    expect(html).toContain('Desk roster');
    expect(html).toContain('Content desk');
    expect(html).toContain('BD desk');
    expect(html).toContain('A Hermes turn measured a sample cost.');
    expect(html).toContain('no soul yet');
    expect(html).toContain('13 / 8,000 characters');
    expect(html).toContain('brand_context');
    expect(html).toContain('Prefer short hooks.');
    expect(html).toContain('Quote rule 2');
    expect(html).toContain('Tool trace');
    // Nothing from the upstream Agents page.
    expect(html).not.toContain('Create agent');
    expect(html).not.toContain('Channels');
  });

  it('the soul editor refuses over 8,000 characters and an unchanged save', () => {
    const over = renderToStaticMarkup(
      <SoulEditor soul={null} draft={'x'.repeat(8001)} onDraft={vi.fn()} onSave={vi.fn()} onReload={vi.fn()} status={null} saving={false} />,
    );
    expect(over).toContain('8,001 / 8,000 characters');
    expect(over).toMatch(/<button[^>]*disabled=""[^>]*>Save soul/);
    const same = renderToStaticMarkup(
      <SoulEditor soul={{ exists: true, text: 'same', hash: 'h', chars: 4, max: 8000 }} draft="same" onDraft={vi.fn()}
        onSave={vi.fn()} onReload={vi.fn()} status={null} saving={false} />,
    );
    expect(same).toMatch(/<button[^>]*disabled=""[^>]*>Save soul/);
  });

  it('says so when the data folder is not configured', () => {
    expect(renderToStaticMarkup(<DesksView {...props({ dataConfigured: false })} />)).toContain('isn’t configured');
  });
});

describe('routing', () => {
  it('/agents renders Desks; the upstream Agents page is routed nowhere', () => {
    expect(app).toContain('<Route path="agents" element={<DesksPage />} />');
    expect(app).not.toMatch(/<AgentsPage|from '\.\/pages\/AgentsPage'/);
    expect(sidebar).toContain("{ path: '/agents', icon: Bot, label: 'Desks' }");
  });
});
