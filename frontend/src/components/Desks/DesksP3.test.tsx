import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeskThreadHeader, runCard, type CardDeps } from './DeskCards';
import { deskIcon } from './deskIcon';
import { openUrl, validateCard, type DeskCard } from '../../lib/desk-cards';
import { DESK_DEFAULTS, LOCAL_ONLY, isDeskId, runPrecheck, type PrecheckResult } from '../../lib/desks-api';
import { PrecheckResultView, PrecheckWidget } from '../Commerce/PrecheckWidget';
import { CompliancePanel } from '../Commerce/CompliancePanel';
import { RecommendationCard } from '../Commerce/RecommendationsQueue';
import { KpiStrip } from '../Commerce/KpiStrip';
import { StackHealthDrawer } from '../Sidebar/StackHealthDrawer';
import { health, row } from '../Sidebar/stackHealthFixtures';
import { stackContext } from '../Sidebar/StackHealthDock';
import { precheckContext, recContext } from '../../pages/CommercePage';
import type { ComplianceFindings, DailyStore, LedgerItem } from '../../lib/commerce-api';

// The app store reads localStorage when it loads; node has none.
vi.hoisted(() => {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> }).localStorage ??= {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  };
});

// Desks P3 (hq 0020 P3, contract v1.19). Neutral fixtures only: this repo is public.
afterEach(() => vi.restoreAllMocks());
const { commerce, ops, compliance } = DESK_DEFAULTS;

describe('the three P3 desks', () => {
  it('are desks, with their pages, and ops and compliance are local only', () => {
    for (const id of ['commerce', 'ops', 'compliance']) expect(isDeskId(id)).toBe(true);
    expect(isDeskId('trading')).toBe(false);
    expect(commerce.pages).toEqual(['/commerce', '/commerce#fixes']);
    expect(ops.pages).toEqual(['/stack', '/logs']);
    expect(compliance.pages).toEqual(['/commerce']);
    expect(LOCAL_ONLY).toEqual(['ops', 'compliance']);
    for (const d of [commerce, ops, compliance]) expect(d.card_kinds).toEqual(['open', 'ruling']);
  });

  it('a local-only desk thread says so in its header', () => {
    expect(renderToStaticMarkup(<DeskThreadHeader desk="ops" />)).toContain('local only');
    expect(renderToStaticMarkup(<DeskThreadHeader desk="commerce" />)).toContain('Hermes by default');
    expect(deskIcon('compliance')).not.toBe(deskIcon('ops'));
  });
});

describe('open cards on the P3 pages', () => {
  const ok = (raw: unknown, desk = ops) => validateCard(raw, desk);

  it('the Stack drawer and /logs need no focus; /commerce#fixes does', () => {
    expect(ok({ kind: 'open', label: 'Stack', target: { page: '/stack' } })).toEqual({
      card: { kind: 'open', label: 'Stack', page: '/stack', focus: '' },
    });
    expect('card' in ok({ kind: 'open', target: { page: '/logs', focus: '' } })).toBe(true);
    expect(ok({ kind: 'open', target: { page: '/commerce#fixes' } }, commerce)).toEqual({
      dropped: { label: 'Open', reason: 'no item to focus' },
    });
    expect('card' in ok({ kind: 'open', target: { page: '/commerce#fixes', focus: 'abc123' } }, commerce)).toBe(true);
  });

  it('a desk opens only its own pages, and never a send or a fix', () => {
    expect(ok({ kind: 'open', target: { page: '/bizdev', focus: '7' } }, compliance)).toEqual({
      dropped: { label: 'Open', reason: "this desk can't open /bizdev" },
    });
    expect(ok({ kind: 'tick', target: { file: 'a/b.md', box: 'D1' } }, ops)).toEqual({
      dropped: { label: 'Tick', reason: "tick cards aren't allowed on this desk" },
    });
    expect(ok({ kind: 'open', target: { page: '/commerce', focus: 'x' }, body: { draft: 'hi' } }, commerce)).toEqual({
      dropped: { label: 'Open', reason: '/commerce has no text field for a draft' },
    });
  });

  it('openUrl keeps the hash after the focus', () => {
    expect(openUrl('/commerce#fixes', 'abc123')).toBe('/commerce?focus=abc123#fixes');
    expect(openUrl('/commerce', 'a1')).toBe('/commerce?focus=a1');
    expect(openUrl('/logs', '')).toBe('/logs');
  });

  function deps(): CardDeps & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      navigate: vi.fn((to: string) => void calls.push(`navigate ${to}`)),
      setHandoff: vi.fn((h) => void calls.push(`handoff ${h.kind}`)),
      addOutcome: vi.fn((_t: string, text: string) => void calls.push(`outcome ${text}`)),
      openDecisions: vi.fn(() => void calls.push('decisions')),
      openStack: vi.fn(() => void calls.push('stack')),
      addRuling: vi.fn(async () => void calls.push('ruling')),
    };
  }

  it('an Ops card to /stack opens the drawer; Run now stays its button', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const d = deps();
    const card: DeskCard = { kind: 'open', label: 'Stack', page: '/stack', focus: '' };
    await runCard(card, 't1', 'ops', d);
    expect(d.calls).toEqual(['stack', 'outcome Opened the Stack drawer']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a Commerce card to a fix navigates to its Fixes card', async () => {
    const d = deps();
    await runCard({ kind: 'open', label: 'Fix', page: '/commerce#fixes', focus: 'abc123' }, 't1', 'commerce', d);
    expect(d.calls).toEqual(['navigate /commerce?focus=abc123#fixes', 'outcome Opened /commerce#fixes (abc123)']);
  });
});

const HITS: PrecheckResult = {
  propertyId: 'sample-prop',
  ok: false,
  judged: false,
  hits: [
    { kind: 'banned-word', rule: 'kernel/brand.json bannedWords', sentence: 'Buy the sample now.', match: 'buy' },
    { kind: 'web-address', rule: 'Sample rule: no web address', sentence: 'See example.com today.', match: 'example.com' },
    { kind: 'banned-word', rule: 'kernel/brand.json bannedWords', sentence: 'A cheap sample.', match: 'cheap' },
  ],
};

describe('paste-and-check', () => {
  it('shows hits by kind, the rule verbatim and the match marked', () => {
    const html = renderToStaticMarkup(<PrecheckResultView result={HITS} />);
    expect(html).toContain('3 hits');
    expect(html.match(/data-kind=/g)).toHaveLength(2);
    expect(html).toContain('banned word · 2');
    expect(html).toContain('kernel/brand.json bannedWords');
    // React's server render separates adjacent text nodes with <!-- -->.
    expect(html.replace(/<!-- -->/g, '')).toMatch(/<mark data-match="true"[^>]*>Buy<\/mark> the sample now\./);
    expect(html).toMatch(/<mark data-match="true"[^>]*>example\.com<\/mark>/);
  });

  it('unavailable is shown as not a pass, never as clean', () => {
    const html = renderToStaticMarkup(
      <PrecheckResultView result={{ propertyId: 'p', ok: false, hits: [], unavailable: true, error: 'pre-check unavailable: exit 1' }} />,
    );
    expect(html).toContain('pre-check unavailable: exit 1');
    expect(html).toContain('Not a pass');
    expect(html).not.toContain('No hits');
  });

  it('a clean deterministic check says the judge was not run', () => {
    const html = renderToStaticMarkup(<PrecheckResultView result={{ propertyId: 'p', ok: true, judged: false, hits: [] }} />);
    expect(html).toContain('No hits');
    expect(html).toContain('the judge adds compliance.md');
  });

  it('the widget offers a property, the text box and both checks', () => {
    const html = renderToStaticMarkup(
      <PrecheckWidget properties={['prop-a', 'prop-b']} onCheck={async () => HITS} onAskDesk={() => {}} />,
    );
    expect(html).toContain('Paste and check');
    expect(html).toContain('<option value="prop-b">prop-b</option>');
    expect(html).toContain('<textarea');
    expect(html).toContain('Check with judge');
    expect(html).toContain('Ask the desk');
    expect(html).toContain('0 / 20,000');
  });

  it('with no readable bundle it says so instead of offering a check', () => {
    const html = renderToStaticMarkup(<PrecheckWidget properties={[]} onCheck={async () => HITS} />);
    expect(html).toContain('isn’t readable');
    expect(html).not.toContain('<textarea');
  });

  it('the widget posts to the one pre-check route the desk tool shares', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(HITS), { status: 200 }));
    const out = await runPrecheck('sample-prop', 'Some text.', true);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('/api/desks/compliance/precheck');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ propertyId: 'sample-prop', text: 'Some text.', judge: true });
    expect(out.hits).toHaveLength(3);
  });

  it('a failed route call is unavailable, not a pass', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 500 }));
    const out = await runPrecheck('sample-prop', 'Some text.', false);
    expect(out.ok).toBe(false);
    expect(out.unavailable).toBe(true);
  });
});

const FINDINGS: ComplianceFindings = {
  counts: { open: 1, new: 0, open_by_property: { 'prop-a': 1 } },
  open_findings: [{ id: 'f1234567', property: 'prop-a', location: 'sample page', quote: 'a quote', readings: { flagged: 2, of: 3 } }],
  advisory_findings: [],
} as unknown as ComplianceFindings;

describe('Ask the desk entry points on /commerce', () => {
  it('the compliance panel has the widget, the desk on the panel and on a finding', () => {
    const html = renderToStaticMarkup(
      <CompliancePanel
        findings={FINDINGS}
        onAskDesk={() => {}}
        precheck={{ properties: ['prop-a'], onCheck: async () => HITS }}
      />,
    );
    expect(html).toContain('data-precheck');
    expect(html).toContain('data-ask-finding="f1234567"');
    expect(html).toContain('Ask the desk');
  });

  it('without the P3 props the compliance panel is as before', () => {
    const html = renderToStaticMarkup(<CompliancePanel findings={FINDINGS} />);
    expect(html).not.toContain('data-precheck');
    expect(html).not.toContain('Ask the desk');
    expect(html).not.toContain('data-ask-finding');
  });

  const item: LedgerItem = {
    id: 'abcdef123456',
    created_at: '2026-01-01T00:00:00Z',
    store: 'sample-store',
    category: 'seo_technical',
    priority: 2,
    title: 'A sample recommendation',
    detail: {
      id: 'abcdef123456',
      store: 'sample-store',
      category: 'seo_technical',
      priority: 2,
      title: 'A sample recommendation',
      rationale: 'Because of a sample source.',
    },
    status: 'open',
    decided_at: null,
    note: null,
  } as LedgerItem;

  it('a recommendation card asks the Commerce desk; its own buttons stay', () => {
    const html = renderToStaticMarkup(
      <RecommendationCard item={item} storeName="Sample" productTitles={{}} onDecide={() => {}} onAskDesk={() => {}} />,
    );
    expect(html).toContain('Ask the desk');
    expect(html).toContain('Accept');
    expect(renderToStaticMarkup(<RecommendationCard item={item} storeName="Sample" productTitles={{}} onDecide={() => {}} />)).not.toContain(
      'Ask the desk',
    );
    const ctx = recContext(item);
    expect(ctx.label).toBe('recommendation “A sample recommendation”');
    expect(ctx.block).toContain('"id":"abcdef123456"');
    expect(ctx.block).toContain('Because of a sample source.');
  });

  it('the KPI panel asks the Commerce desk', () => {
    const stores = [{ slug: 'sample-store', display_name: 'Sample' }] as unknown as DailyStore[];
    expect(renderToStaticMarkup(<KpiStrip stores={stores} onAskDesk={() => {}} />)).toContain('Ask the desk');
    expect(renderToStaticMarkup(<KpiStrip stores={stores} />)).not.toContain('Ask the desk');
  });

  it('pasted copy goes to the Compliance desk with its hits', () => {
    const ctx = precheckContext('sample-prop', 'Buy the sample now.', HITS);
    expect(ctx.block).toContain('"kind":"precheck"');
    expect(ctx.block).toContain('Buy the sample now.');
    expect(ctx.block).toContain('banned-word');
  });
});

describe('the Stack drawer asks the Ops desk', () => {
  const h = health({
    counts: { OK: 3, WARN: 1, FAIL: 1, SKIP: 0 },
    failing: [row('web', 'site-a', 'FAIL', 'down')],
    warning: [row('local', 'disk', 'WARN', 'disk at 91 %')],
  });

  it('shows Ask the desk only when wired, beside Run now', () => {
    const base = { health: h, now: 0, run: { state: 'idle' as const, detail: null }, onRun: () => {}, onClose: () => {} };
    expect(renderToStaticMarkup(<StackHealthDrawer {...base} onAskDesk={() => {}} />)).toContain('Ask the desk');
    expect(renderToStaticMarkup(<StackHealthDrawer {...base} />)).not.toContain('Ask the desk');
  });

  it('the context carries the FAIL and WARN lines', () => {
    const ctx = stackContext(h);
    expect(ctx.label).toBe('stack health (1 FAIL, 1 WARN)');
    expect(ctx.block).toContain('down');
    expect(ctx.block).toContain('disk at 91 %');
  });
});
