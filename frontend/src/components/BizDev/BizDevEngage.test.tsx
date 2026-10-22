import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { sendRequest, type PipelineProspect, type Screen, type SendConfig, type Template } from '../../lib/bizdev-api';
import {
  charsChanged,
  engagementChips,
  engagementTimeline,
  footerPreview,
  mergeText,
  mergeValues,
  opensLabel,
  screenReason,
  shortName,
  templatesFor,
  withoutFooter,
} from '../../lib/bizdev-compose';
import { DraftComposer, initialRecipient, startingText } from './DraftComposer';
import { EngagementStatsBlock, sourceLabel } from './InsightsPanel';
import { EngagementChips } from './PipelineBoard';
import { EngagementTimeline } from './ProspectDrawer';
import { TemplatesPanel, templateProblem } from './Templates';

// Engagement and templates (hq 0018, Parts B and C). Neutral fixtures only:
// this repo is public.
const CONFIG: SendConfig = {
  enabled: true,
  sender_name: 'Sample Sender',
  sender_address: 'sender@example.org',
  reply_to: 'sender@example.org',
  sender_title: 'Founder',
  missing: [],
};
const FOOTER = '\n\n--\n[Your name]\nSample Org · [postal address]\nReply "no thanks" to stop.';
const SCREEN: Screen = {
  patterns: [
    { regex: '(?i)\\btrusted by\\b', reason: 'reference claim (rule 1)' },
    { regex: '(?i)no thanks', reason: 'never in the body' },
  ],
  footer: FOOTER,
};
const T = (over: Partial<Template>): Template => ({
  id: 1,
  name: 'Intro',
  touch: 1,
  subject: 'A note for {{short_name}}',
  body: 'Hi {{first_name}},\n\nOn {{platform}}.\n\n{{sender_name}}, {{sender_title}}',
  uses: 3,
  replies: 1,
  archived_at: null,
  ...over,
});
const TEMPLATES = [
  T({ id: 1 }),
  T({ id: 2, name: 'Any', touch: 'any', default_for_touch: 2 }),
  T({ id: 3, name: 'Second', touch: 2 }),
  T({ id: 4, name: 'Old', archived_at: '2026-10-19T00:00:00Z' }),
];

function card(over: Partial<PipelineProspect> = {}): PipelineProspect {
  return {
    id: 7,
    name: 'University of Example',
    association: 'NAIA',
    contacts: [
      { name: 'Dr. Ann Person', title: 'SID', email: 'a.person@example.edu' },
      { name: 'Bo', email: 'bo@example.edu' },
    ],
    signals: { platform: 'unknown / custom' },
    signal_notes: ['Posts box scores for soccer', 'second note'],
    fit_rationale: 'Basketball pages are thin.',
    draft: { subject: 'Hello', body: 'Hi Ann,\n\nA body.' + FOOTER },
    stage: 'drafted',
    ...over,
  };
}

describe('merge fields (contract v0.10, as Hermes resolves them)', () => {
  it('short_name drops "College of", "University of" and "University"', () => {
    expect(shortName('University of Sampleton')).toBe('Sampleton');
    expect(shortName('Sampleton University')).toBe('Sampleton');
    expect(shortName('College of the Hills')).toBe('the Hills');
    expect(shortName('University')).toBe('University');
  });

  it('values come from the card and the chosen contact; unknown platform stays unresolved', () => {
    const now = new Date('2026-10-20T12:00:00Z');
    const p = card({ touches: [{ n: 1, sent_at: '2026-10-10T09:00:00Z', subject: 'First one' }] });
    const v = mergeValues(p, 'A.Person@example.edu', CONFIG, undefined, now);
    expect(v).toMatchObject({
      first_name: 'Ann',
      last_name: 'Person',
      title: 'SID',
      institution: 'University of Example',
      short_name: 'Example',
      association: 'NAIA',
      platform: null,
      signal_1: 'Posts box scores for soccer',
      sport_hint: 'basketball', // the first in Hermes's list order, not in the text
      sender_name: 'Sample Sender',
      sender_title: 'Founder',
      first_subject: 'First one',
      days_since_first: '10',
    });
    expect(mergeValues(p, 'bo@example.edu', CONFIG).last_name).toBeNull();
    expect(mergeValues(p, 'bo@example.edu', CONFIG, 'S. Other').sender_name).toBe('S. Other');
  });

  it('a field the card cannot fill stays as {{field}}', () => {
    expect(mergeText('On {{platform}}, {{first_name}}', { first_name: 'Ann', platform: null })).toBe('On {{platform}}, Ann');
  });
});

describe('the screen and the footer', () => {
  it('reads (?i) patterns on the subject and body, never the footer', () => {
    expect(screenReason(SCREEN, 'Trusted by many', 'Hi.')).toBe('reference claim (rule 1)');
    expect(screenReason(SCREEN, 'Hello', 'Hi.' + FOOTER)).toBeNull();
    expect(screenReason(SCREEN, 'Hello', 'Hi. No thanks needed.')).toBe('never in the body');
    expect(screenReason({ patterns: [{ regex: '(?P<x>a)', reason: 'py only' }], footer: '' }, 'a', 'a')).toBeNull();
  });

  it('a saved template leaves the footer out', () => {
    expect(withoutFooter('Hi.' + FOOTER, SCREEN)).toBe('Hi.');
    expect(withoutFooter('Hi.\n', SCREEN)).toBe('Hi.');
  });

  it('counts the characters changed', () => {
    expect(charsChanged('Hello world', 'Hello world')).toBe(0);
    expect(charsChanged('Hello world', 'Hello there world')).toBe(6);
    expect(charsChanged('abc', 'xyz')).toBe(3);
    expect(charsChanged('', 'abcd')).toBe(4);
  });
});

describe('templates on a draft (Part C)', () => {
  it('lists current templates for the touch, then "any"; archived ones never', () => {
    expect(templatesFor(TEMPLATES, 1).map((g) => [g.label, g.items.map((t) => t.id)])).toEqual([
      ['Touch 1', [1]],
      ['Any touch', [2]],
    ]);
    expect(templatesFor(TEMPLATES, 2).map((g) => g.items.map((t) => t.id))).toEqual([[3], [2]]);
  });

  it('a template starts merged; the Hermes draft gets only the sender fields', () => {
    const v = mergeValues(card(), 'a.person@example.edu', CONFIG);
    const t = startingText('1', TEMPLATES, card().draft!, v);
    expect(t.source).toBe('template:1');
    expect(t.subject).toBe('A note for Example');
    expect(t.body).toBe('Hi Ann,\n\nOn {{platform}}.\n\nSample Sender, Founder');
    const h = startingText('hermes', TEMPLATES, { subject: 'S', body: 'Bye,\n{{sender_name}}', draft_source: 'template:2' }, v);
    expect(h).toEqual({ subject: 'S', body: 'Bye,\nSample Sender', source: 'template:2' });
  });

  it('the Hermes draft loses its footer in the editor; the footer shows filled, read-only', () => {
    const v = mergeValues(card(), 'a.person@example.edu', CONFIG);
    expect(startingText('hermes', [], card().draft!, v, SCREEN).body).toBe('Hi Ann,\n\nA body.');
    expect(footerPreview(SCREEN, 'Sample Sender')).toBe('--\nSample Sender\nSample Org · (your postal address)\nReply "no thanks" to stop.');
    expect(footerPreview({ patterns: [], footer: '' }, 'x')).toBeNull();
  });

  it("To starts at the contact Hermes wrote the draft for", () => {
    const contacts = card().contacts!;
    expect(initialRecipient(contacts, 'BO@example.edu')).toBe('bo@example.edu');
    expect(initialRecipient(contacts, 'someone@example.org')).toBe('a.person@example.edu');
    expect(initialRecipient(contacts, null)).toBe('a.person@example.edu');
    const html = renderToStaticMarkup(
      <DraftComposer
        prospect={card()}
        line={{ line: 'sample', screen: SCREEN, templates: [] }}
        touch={1}
        draft={{ ...card().draft!, to_email: 'bo@example.edu' }}
        sendConfig={CONFIG}
        onSend={async () => ({ fe_id: 'x', message_id: 'y', fe_status: 'queued', recorded: true })}
        onMarkSent={() => {}}
      />,
    );
    expect(html).toContain('<option value="bo@example.edu" selected="">');
    expect(html).toContain('aria-label="Footer added on send"');
    expect(html).not.toContain('[Your name]');
  });

  it('the composer offers "Hermes draft" first, then the grouped templates', () => {
    const html = renderToStaticMarkup(
      <DraftComposer
        prospect={card()}
        line={{ line: 'sample', screen: SCREEN, templates: TEMPLATES }}
        touch={1}
        draft={card().draft!}
        sendConfig={CONFIG}
        onSend={async () => ({ fe_id: 'x', message_id: 'y', fe_status: 'queued', recorded: true })}
        onMarkSent={() => {}}
        onSaveTemplate={async () => {}}
      />,
    );
    expect(html.indexOf('Hermes draft')).toBeLessThan(html.indexOf('label="Touch 1"'));
    expect(html).toContain('label="Any touch"');
    expect(html).toContain('Any (default)');
    expect(html).not.toContain('>Old<');
    expect(html).toContain('Save as template…');
  });

  it('a draft the screen withholds names the reason and disables Send', () => {
    const p = card({ draft: { subject: 'Trusted by schools', body: 'Hi.' } });
    const html = renderToStaticMarkup(
      <DraftComposer
        prospect={p}
        line={{ line: 'sample', screen: SCREEN, templates: [] }}
        touch={1}
        draft={p.draft!}
        sendConfig={CONFIG}
        onSend={async () => ({ fe_id: 'x', message_id: 'y', fe_status: 'queued', recorded: true })}
        onMarkSent={() => {}}
      />,
    );
    expect(html).toContain('Withheld by the screen: reference claim (rule 1)');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="Withheld by the screen: reference claim \(rule 1\)"/);
    expect(html).not.toContain('Template');
  });

  it('a send carries its draft source and the edit count', () => {
    expect(
      sendRequest({ touches: [] }, { touch: 1, to: 'a@example.edu', subject: 's', body: 'b', draftSource: 'template:3', draftEdited: 5 }),
    ).toMatchObject({ draft_source: 'template:3', draft_edited: 5 });
    expect(sendRequest({ touches: [] }, { touch: 1, to: 'a@example.edu', subject: 's', body: 'b' })).not.toHaveProperty('draft_edited');
  });

  it('the editor refuses what Hermes would refuse', () => {
    const base = { line: 'sample', name: 'X', touch: 1 as const, subject: 's', body: 'b' };
    expect(templateProblem(base)).toBeNull();
    expect(templateProblem({ ...base, name: ' ' })).toMatch(/name/);
    expect(templateProblem({ ...base, body: 'Hi {{nickname}}' })).toBe('Unknown merge field: {{nickname}}');
    expect(templateProblem({ ...base, subject: 'Re: {{first_subject}}', default_for_touch: 1 })).toMatch(/touch-1 default/);
    expect(templateProblem({ ...base, body: 'x'.repeat(6001) })).toMatch(/over 6000/);
  });

  it('the Templates tab lists uses and replies, archived ones folded away', () => {
    const html = renderToStaticMarkup(
      <TemplatesPanel line="sample" templates={TEMPLATES} onSave={async () => {}} onArchive={async () => {}} />,
    );
    expect(html).toContain('3 uses · 1 replies');
    expect(html).toContain('default for touch 2');
    expect(html).toContain('Archived (1)');
    expect(html).toContain('New template');
    expect(html.match(/data-template="/g)?.length).toBe(4);
  });
});

describe('engagement (Part B)', () => {
  const sent = { n: 1, sent_at: '2026-10-20T10:00:00Z', to_email: 'a.person@example.edu', fe_status: 'sent' as const, opens: 3 };

  it('Opened needs a non-proxy open; the other chips follow the engagement', () => {
    expect(engagementChips({ opens: 2, proxy_opens: 2 })).toEqual([]);
    expect(engagementChips({ opens: 3, proxy_opens: 2 })).toEqual(['opened']);
    expect(engagementChips({ reply_kind: 'reply_other_sender' })).toEqual(['referred']);
    // Bounced follows the stage (v0.10.7): a bounce_kind alone isn't one.
    expect(engagementChips({ reply_kind: 'auto_reply', bounce_kind: 'soft' })).toEqual(['auto_reply']);
    expect(engagementChips({ bounce_kind: 'hard' }, 'bounced')).toEqual(['bounced']);
    expect(engagementChips({ reply_kind: 'reply', unsubscribed_at: '2026-10-21T00:00:00Z' })).toEqual(['replied', 'unsubscribed']);
    const chips = renderToStaticMarkup(<EngagementChips p={{ engagement: { opens: 3, proxy_opens: 1, reply_kind: 'reply' } }} />);
    expect(chips).toContain('Opened');
    expect(chips).toContain('Replied');
  });

  it('marks proxy opens', () => {
    expect(opensLabel(3, 0)).toBe('Opened ×3');
    expect(opensLabel(3, 2)).toBe('Opened ×3 (2 proxy)');
    expect(opensLabel(1, 1)).toBe('Opened ×1 (proxy)');
  });

  it('the timeline runs in time order, sends first', () => {
    const events = engagementTimeline({
      touches: [sent],
      engagement: {
        opens: 3,
        proxy_opens: 1,
        first_open_at: '2026-10-20T10:05:00Z',
        last_open_at: '2026-10-21T08:00:00Z',
        replied_at: '2026-10-21T09:00:00Z',
        replied_touch: 1,
        time_to_reply_h: 23,
        reply_kind: 'reply',
        auto_reply_at: '2026-10-20T10:01:00Z',
        followup_hold_until: '2026-10-27T10:01:00Z',
      },
    });
    expect(events.map((e) => e.label)).toEqual(['Touch 1 sent', 'Auto-reply', 'Opened ×3 (1 proxy)', 'Last opened', 'Replied']);
    expect(events[1].detail).toBe('follow-ups held until 2026-10-27');
    expect(events[4].detail).toBe('23 h after touch 1');
    const html = renderToStaticMarkup(<EngagementTimeline prospect={{ touches: [sent], engagement: {} }} />);
    expect(html).toContain('data-touch="1"');
    expect(html).toContain('opened ×3');
  });

  it('Insights shows the engagement numbers, sources by template name, slots only when present', () => {
    const e = {
      pulled_at: '2026-10-20T22:00:44Z',
      sends: 12,
      delivery_rate: 0.92,
      open_rate_nonproxy: 0.5,
      reply_rate_by_touch: { '1': 0.25, '2': null, '3': null },
      reply_rate_by_draft_source: { hermes: 0.2, 'template:3': 0.5 },
      median_time_to_reply_h: 30,
      bounce_rate_week: 0,
      reply_rate_by_send_slot: [],
    };
    expect(sourceLabel('template:3', TEMPLATES)).toBe('Second');
    expect(sourceLabel('template:99', TEMPLATES)).toBe('template:99');
    const html = renderToStaticMarkup(<EngagementStatsBlock e={e} templates={TEMPLATES} />);
    expect(html).toContain('92%');
    expect(html).toContain('Second replies 50%');
    expect(html).toContain('Hermes draft replies 20%');
    expect(html).toContain('30 h');
    expect(html).not.toContain('<table');
    const slots = renderToStaticMarkup(
      <EngagementStatsBlock e={{ ...e, reply_rate_by_send_slot: [{ dow: 'Tue', hour_bucket: '09-12', sent: 31, replied: 4 }] }} />,
    );
    expect(slots).toContain('Tue 09-12');
  });
});
