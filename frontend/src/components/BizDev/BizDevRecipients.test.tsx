import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/api', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '../../lib/api';
import {
  addContact,
  contactProblem,
  moveProspect,
  nextTouch,
  recipientsOf,
  sendBlock,
  sendRequest,
  type BdPipeline,
  type EngagementStats,
  type FollowUp,
  type PipelineProspect,
  type SendConfig,
  type Touch,
} from '../../lib/bizdev-api';
import { engagementChips, engagementTimeline, mergeValues, proposesMeeting, touchTiming } from '../../lib/bizdev-compose';
import { MEETING_NOTE, watchContacts } from '../../hooks/useBizDevData';
import { DraftComposer, initialRecipient } from './DraftComposer';
import { FollowUpsStrip, followUpRecipient } from './FollowUpsStrip';
import { EngagementStatsBlock } from './InsightsPanel';
import { EngagementChips, MeetingChip } from './PipelineBoard';
import { AddRecipientForm, EngagementTimeline, ProspectDrawer } from './ProspectDrawer';

// Add recipient and several recipients per card (hq 0018 A3 + A2, contract
// v0.10.7), and Part D (v0.10.6). Neutral fixtures only: this repo is public.
const fetchMock = vi.mocked(apiFetch);
afterEach(() => fetchMock.mockReset());

const CONFIG: SendConfig = {
  enabled: true,
  sender_name: 'Sample Sender',
  sender_address: 'sender@example.org',
  reply_to: 'sender@example.org',
  missing: [],
};
const A = 'a.person@example.edu';
const B = 'b.person@example.edu';
const C = 'c.person@example.org';
const CONTACTS = [
  { name: 'Ann Person', title: 'SID', email: A, source: 'hermes' as const },
  { name: 'Bo Person', title: 'Director', email: B, source: 'operator' as const, added_at: '2026-10-22T12:00:00Z' },
];

const sent = (n: number, to: string, over: Partial<Touch> = {}): Touch => ({
  n,
  sent_at: `2026-10-2${n}T15:00:00Z`,
  fe_id: `fe-${n}-${to[0]}`,
  fe_status: 'sent',
  to_email: to,
  message_id: `<bd-7-${n}-0000000${to[0] === 'a' ? 1 : 2}@example.org>`,
  ...over,
});

function card(over: Partial<PipelineProspect> = {}): PipelineProspect {
  return {
    id: 7,
    name: 'Example College 7',
    stage: 'drafted',
    contacts: CONTACTS,
    draft: { subject: 'Sample subject', body: 'Hello,\nSample body.', to_email: A },
    ...over,
  };
}

function drawer(p: PipelineProspect, extra: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    <ProspectDrawer
      prospect={p}
      onClose={() => {}}
      onMove={() => {}}
      onRecheck={() => {}}
      recheckDisabled={false}
      rechecksToday={0}
      recheckCap={5}
      sendConfig={CONFIG}
      onSend={async () => ({ fe_id: 'x', message_id: 'y', fe_status: 'queued', recorded: true })}
      onAddContact={async () => {}}
      {...extra}
    />,
  );
}

function composer(p: PipelineProspect, touch = 1, to?: string) {
  return renderToStaticMarkup(
    <DraftComposer
      prospect={p}
      line={{ line: 'sample', templates: [] }}
      touch={touch}
      draft={{ ...p.draft!, ...(to ? { to_email: to } : {}) }}
      sendConfig={CONFIG}
      onSend={async () => ({ fe_id: 'x', message_id: 'y', fe_status: 'queued', recorded: true })}
      onMarkSent={() => {}}
    />,
  );
}

const sendButton = (html: string) => /<button([^>]*)>(?:(?!<\/button>).)*Send<\/button>/s.exec(html)?.[1] ?? '';

describe('Add recipient (A3)', () => {
  it('is open on a card with no contacts and behind a link otherwise', () => {
    expect(drawer(card({ contacts: [] }))).toContain('data-add-recipient="open"');
    const html = drawer(card());
    expect(html).toContain('data-add-recipient="collapsed"');
    expect(html).toContain('Add recipient');
    expect(drawer(card(), { onAddContact: undefined })).not.toContain('data-add-recipient');
  });

  it('is off at 3 contacts of any source, with the reason', () => {
    const three = [...CONTACTS, { name: 'Cy', email: C }];
    const html = renderToStaticMarkup(<AddRecipientForm contacts={three} onAdd={async () => {}} />);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Add recipient/s);
    expect(html).toContain('3 contacts is the most a card holds.');
  });

  it('tags the operator’s contacts and a hard-bounced one', () => {
    const html = drawer(card({ contacts: [{ ...CONTACTS[0], bounce_hard_at: '2026-10-21T00:00:00Z' }, CONTACTS[1]] }));
    expect(html).toContain('added by you');
    expect(html).toContain('>bounced<');
  });

  it('checks the address before Save', () => {
    expect(contactProblem({ email: '' })).toBe('An email address is required');
    expect(contactProblem({ email: 'two@example.edu, three@example.edu' })).toBe('Enter one valid email address');
    expect(contactProblem({ email: `${'a'.repeat(243)}@example.edu` })).toMatch(/over 254/);
    expect(contactProblem({ email: A, name: 'n'.repeat(121) })).toMatch(/name is over 120/);
    expect(contactProblem({ email: A, title: 'Director' })).toBeNull();
  });

  it('Save posts once, trimmed, to the contact route', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: 7, action: 'contact', queued: true }), { status: 202 }));
    await addContact(7, { name: ' Cy Person ', title: '', email: ` ${C} ` });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe('/api/bizdev/prospects/7/contact');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ email: C, name: 'Cy Person' });
  });

  it('a refusal from the server surfaces its reason', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ detail: 'Enter one valid email address' }), { status: 422 }));
    await expect(addContact(7, { email: 'x@example.edu' })).rejects.toThrow('Enter one valid email address');
  });

  it('says "not accepted" after two late refreshes without the contact', () => {
    const pipeline = (contacts: PipelineProspect['contacts']): BdPipeline => ({
      generated_at: '',
      age_seconds: 0,
      stale: false,
      run_at: '',
      lines: [
        {
          line: 'sample',
          display_name: 'Sample',
          suppressed_count: 0,
          follow_ups_due: [],
          stages: { new: [], drafted: [card({ contacts })], sent: [], replied: [], meeting: [], won: [], lost: [] },
        },
      ],
    });
    const w0 = { 7: { email: C, at: 0, refreshes: 0, state: 'saved' as const } };
    // Too soon after the save: not counted.
    expect(watchContacts(pipeline(CONTACTS), w0, 30_000).watch[7].refreshes).toBe(0);
    const w1 = watchContacts(pipeline(CONTACTS), w0, 120_000);
    expect(w1.watch[7]).toMatchObject({ refreshes: 1, state: 'saved' });
    expect(w1.failed).toBe(false);
    const w2 = watchContacts(pipeline(CONTACTS), w1.watch, 240_000);
    expect(w2.watch[7].state).toBe('not_accepted');
    expect(w2.failed).toBe(true);
    // Published (in any case): the watch ends.
    expect(watchContacts(pipeline([...CONTACTS, { name: 'Cy', email: C.toUpperCase() }]), w1.watch, 240_000).watch).toEqual({});
    expect(drawer(card(), { contactNote: 'not_accepted' })).toContain('Hermes did not accept this address');
    expect(drawer(card(), { contactNote: 'saved' })).toContain('Saved; appears after the next refresh (about 2 minutes).');
  });
});

describe('recipient selector on Send (A2)', () => {
  it('To starts at the draft’s contact, else the first; a bounced one is listed disabled', () => {
    expect(initialRecipient(CONTACTS, B)).toBe(B);
    expect(initialRecipient(CONTACTS, 'other@example.org')).toBe(A);
    const bounced = [{ ...CONTACTS[0], bounce_hard_at: '2026-10-21T00:00:00Z' }, CONTACTS[1]];
    expect(initialRecipient(bounced, A)).toBe(B);
    const html = composer(card({ contacts: bounced }));
    expect(html).toMatch(/<option value="a.person@example.edu" disabled="">Ann Person -- SID &lt;a.person@example.edu&gt; \(bounced\)<\/option>/);
    expect(html).toMatch(/<option value="b.person@example.edu" selected="">Bo Person -- Director &lt;b.person@example.edu&gt;<\/option>/);
  });

  it('a card with no address yet offers one once Hermes publishes it', () => {
    const html = composer(card({ contacts: [], draft: { subject: 's', body: 'b' } }));
    expect(sendButton(html)).toContain('No contact email on file');
  });

  it('counts touches per recipient: A then B both send touch 1, A again sends touch 2', () => {
    const afterA = card({ stage: 'sent', touches: [sent(1, A)] });
    expect(nextTouch(afterA, A)).toBe(2);
    expect(nextTouch(afterA, B)).toBe(1);
    expect(sendBlock(afterA, B, 1)).toBeNull();
    expect(sendBlock(afterA, A, 1)).toBe('Touch 1 was sent to this address');
    const afterB = card({ stage: 'sent', touches: [sent(1, A), sent(1, B)] });
    expect(sendBlock(afterB, A, 2)).toBeNull();
    expect(sendRequest(afterB, { touch: 2, to: A, subject: 's', body: 'b' })).toMatchObject({
      to_email: A,
      touch: 2,
      in_reply_to_message_id: '<bd-7-1-00000001@example.org>',
    });
    expect(sendRequest(afterB, { touch: 2, to: B, subject: 's', body: 'b' }).in_reply_to_message_id).toBe('<bd-7-1-00000002@example.org>');
    // The drawer's touch-1 draft stays open for B after A was sent.
    expect(sendButton(composer(afterA, 1, B))).not.toContain('disabled=""');
    expect(sendButton(composer(afterA, 1, A))).toContain('Touch 1 was sent to this address');
  });

  it('a bare touch (an old stage move) counts for the first recipient', () => {
    const p = card({ stage: 'sent', touches: [{ n: 1, sent_at: 'x' }] });
    expect(recipientsOf(p)).toEqual([A]);
    expect(nextTouch(p, A)).toBe(2);
    expect(nextTouch(p, B)).toBe(1);
  });

  it('a rejected send is replaced for that pair only', () => {
    const p = card({ stage: 'sent', touches: [sent(1, A, { fe_status: 'rejected' }), sent(1, B)] });
    expect(sendBlock(p, A, 1)).toBeNull();
    expect(sendBlock(p, B, 1)).toBe('Touch 1 was sent to this address');
  });

  it('Send is off for a 4th recipient and for a bounced contact', () => {
    const D = 'd.person@example.org';
    const four = [...CONTACTS, { name: 'Cy', email: C }, { name: 'Di', email: D }];
    const p = card({ stage: 'sent', contacts: four, touches: [sent(1, A), sent(1, B), sent(1, C)] });
    expect(sendBlock(p, D, 1)).toBe('This card already went to 3 recipients');
    expect(sendButton(composer(p, 1, D))).toContain('This card already went to 3 recipients');
    const bounced = card({ contacts: [{ ...CONTACTS[0], bounce_hard_at: '2026-10-21T00:00:00Z' }, CONTACTS[1]] });
    expect(sendBlock(bounced, A, 1)).toBe('This address hard-bounced');
  });

  it('merge fields come from the selected recipient, first_subject from its own touch 1', () => {
    const p = card({ stage: 'sent', touches: [sent(1, A, { subject: 'To Ann' }), sent(1, B, { subject: 'To Bo' })] });
    const forB = mergeValues(p, B, CONFIG, undefined, new Date('2026-10-23T15:00:00Z'));
    expect(forB).toMatchObject({ first_name: 'Bo', last_name: 'Person', title: 'Director', first_subject: 'To Bo', days_since_first: '2' });
    expect(mergeValues(p, A, CONFIG).first_subject).toBe('To Ann');
  });

  it('the follow-up goes to its recipient; an older one to the card’s first', () => {
    const p = card({ stage: 'sent', touches: [sent(1, A), sent(1, B)] });
    const f: FollowUp = { prospect_id: 7, touch: 2, due: '2026-10-29', draft: { subject: 'Re', body: 'Again.' }, to_email: B };
    expect(followUpRecipient(f, p)).toBe(B);
    expect(followUpRecipient({ ...f, to_email: null }, p)).toBe(A);
    const html = renderToStaticMarkup(
      <FollowUpsStrip followUps={[f]} prospectsById={new Map([[7, p]])} onMarkSent={() => {}} sendConfig={CONFIG} onSend={async () => ({ fe_id: 'x', message_id: 'y', fe_status: 'queued', recorded: true })} />,
    );
    expect(html).toContain('to Bo Person');
    expect(html).toMatch(/<option value="b.person@example.edu" selected="">/);
    expect(sendButton(html)).not.toContain('disabled=""');
  });
});

describe('card and timeline by recipient', () => {
  const two = card({
    stage: 'sent',
    contacts: [CONTACTS[0], { ...CONTACTS[1], bounce_hard_at: '2026-10-23T09:00:00Z' }],
    touches: [sent(1, A, { send_dow: 'Wed', send_hour: 1, send_latency_h: 2, draft_edited: 12 }), sent(1, B)],
    engagement: {
      bounce_kind: 'hard',
      bounced_at: '2026-10-23T09:00:00Z',
      replied_at: '2026-10-24T10:00:00Z',
      reply_kind: 'reply',
      replied_to_email: A,
      recipients: [
        { to_email: A, touches: 1, opens: 2, replied_at: '2026-10-24T10:00:00Z' },
        { to_email: B, touches: 1, bounce_hard_at: '2026-10-23T09:00:00Z' },
      ],
    },
  });

  it('groups touches under each recipient, then the card’s own events', () => {
    const html = renderToStaticMarkup(<EngagementTimeline prospect={two} />);
    expect(html.match(/data-recipient="/g)?.length).toBe(2);
    const a = html.slice(html.indexOf('data-recipient="a.person'), html.indexOf('data-recipient="b.person'));
    expect(a).toContain('Ann Person');
    expect(a).toContain('>replied<');
    expect(a).toContain('Wed 01:00 CT · drafted → sent 2.0 h · edited 12 chars');
    const b = html.slice(html.indexOf('data-recipient="b.person'));
    expect(b).toContain('>bounced<');
    expect(b).toContain('Bounced (hard)');
    expect(html).toContain('to Ann Person');
    // The card-level hard bounce repeats Bo's; it isn't listed twice.
    expect(engagementTimeline(two).filter((e) => e.label.startsWith('Bounced'))).toHaveLength(1);
  });

  it('a sent card with one bounced recipient has no card Bounced chip', () => {
    expect(engagementChips(two.engagement, two.stage)).not.toContain('bounced');
    const chips = renderToStaticMarkup(<EngagementChips p={two} />);
    expect(chips).not.toContain('>Bounced<');
    expect(chips).toContain('2 recipients');
    expect(chips).toContain('title="Reply to Ann Person"');
  });

  it('timing lines show only the fields Hermes published', () => {
    expect(touchTiming({ send_dow: 'Mon', send_hour: 14 })).toEqual(['Mon 14:00 CT']);
    expect(touchTiming({ send_latency_h: 0.25, draft_edited: 0 })).toEqual(['drafted → sent 0.3 h']);
    expect(touchTiming({})).toEqual([]);
    expect(renderToStaticMarkup(<EngagementTimeline prospect={{ touches: [sent(1, A)], engagement: {} }} />)).not.toContain('data-timing');
  });
});

describe('Part D: meeting on the calendar', () => {
  const replied = card({
    stage: 'replied',
    proposed_stage: 'meeting',
    engagement: { meeting_detected: { event_start: '2026-10-30T15:00:00Z', domain: 'example.edu' } },
  });

  it('the chip shows only on a replied card Hermes marks meeting', () => {
    expect(proposesMeeting(replied)).toBe(true);
    expect(proposesMeeting({ ...replied, stage: 'sent' })).toBe(false);
    expect(proposesMeeting({ ...replied, proposed_stage: null })).toBe(false);
    expect(renderToStaticMarkup(<MeetingChip p={replied} />)).toContain('Meeting on the calendar? Fri, Oct 30 · example.edu');
    expect(renderToStaticMarkup(<MeetingChip p={{ ...replied, proposed_stage: null }} />)).toBe('');
  });

  it('the drawer offers Confirm next to it; nothing without a proposal', () => {
    const html = drawer(replied, { onConfirmMeeting: async () => {} });
    expect(html).toContain('data-meeting-proposal');
    expect(html).toContain('Confirm');
    expect(drawer({ ...replied, proposed_stage: null }, { onConfirmMeeting: async () => {} })).not.toContain('data-meeting-proposal');
  });

  it('Confirm posts the existing stage move with the calendar note', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 202 }));
    await moveProspect(7, 'meeting', MEETING_NOTE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe('/api/bizdev/prospects/7/meeting');
    expect(JSON.parse(String(init?.body))).toEqual({ note: 'meeting confirmed from the calendar match' });
  });
});

describe('Insights (v0.10.6 + v0.10.7)', () => {
  const base: EngagementStats = { sends: 12, reply_rate_by_touch: {}, reply_rate_by_draft_source: {} };

  it('hides the new rows without their keys', () => {
    const html = renderToStaticMarkup(<EngagementStatsBlock e={base} />);
    expect(html).not.toContain('data-engagement-v0106');
    expect(html).not.toContain('more than one recipient');
  });

  it('shows them when present, "n/a" while the edited rates are null', () => {
    const html = renderToStaticMarkup(
      <EngagementStatsBlock
        e={{ ...base, cards_multi_recipient: 2, reply_rate_by_draft_edited: { sends: 12, edited: null, unedited: null }, median_send_latency_h: 410.2 }}
      />,
    );
    expect(html).toContain('Cards with more than one recipient 2');
    expect(html).toContain('Reply rate, edited vs unedited drafts n/a until 30 sends');
    expect(html).toContain('Median draft-to-send 17.1 d');
    const rates = renderToStaticMarkup(
      <EngagementStatsBlock e={{ ...base, reply_rate_by_draft_edited: { sends: 40, edited: 0.25, unedited: 0.1 } }} />,
    );
    expect(rates).toContain('25% vs 10%');
  });
});
