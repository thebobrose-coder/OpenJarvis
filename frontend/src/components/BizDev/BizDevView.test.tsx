import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { BdPipeline, BdProspects, BdStats, BoardStage, PipelineProspect } from '../../lib/bizdev-api';
import { applyMoves, reconcileMoves, type BizDevFeedStates } from '../../hooks/useBizDevData';
import { BizDevView, type BizDevViewProps } from './BizDevView';
import { MAILTO_MAX, buildMailto } from './mail';
import { NO_FILTERS, boardOrder, matches } from './PipelineBoard';
import { SuppressionConfirm } from './ProspectDrawer';

// Neutral fixtures only: this repo is public, and real prospect data
// includes people's names and work emails.
const META = { generated_at: '2026-09-28T12:00:00Z', age_seconds: 3600, stale: false };

function prospect(id: number, stage: BoardStage, over: Partial<PipelineProspect> = {}): PipelineProspect {
  return {
    id,
    line: 'line-a',
    name: `Example College ${id}`,
    association: 'Example Association',
    division: 'D-I',
    state: 'EX',
    website: 'https://example.edu',
    signals: { platform: 'SamplePlatform', directory_found: true },
    signal_notes: ['Sample signal note'],
    fit_score: 4,
    fit_rationale: 'Sample rationale for the fit.',
    contacts: [{ name: 'A. Person', title: 'Sports Information Director', email: 'a.person@example.edu' }],
    draft: { to_role: 'SID', subject: 'Sample subject', body: 'Hello,\nSample body.' },
    stage,
    days_in_stage: 3,
    history: [{ stage: 'drafted', at: '2026-09-27T10:00:00', note: 'Sample history note' }],
    ...over,
  };
}

const EMPTY_STAGES = { new: [], drafted: [], sent: [], replied: [], meeting: [], won: [], lost: [] } as Record<BoardStage, PipelineProspect[]>;

const PIPELINE: BdPipeline = {
  ...META,
  run_at: '2026-09-28T07:30:00',
  lines: [
    {
      line: 'line-a',
      display_name: 'Line A',
      stages: {
        ...EMPTY_STAGES,
        new: [prospect(1, 'new', { contacts: [], draft: null, fit_score: 2 })],
        drafted: [prospect(2, 'drafted')],
        sent: [prospect(3, 'sent')],
      },
      suppressed_count: 4,
      follow_ups_due: [{ prospect_id: 3, touch: 2, due: '2026-09-28', draft: { subject: 'Sample follow-up', body: 'Following up.' } }],
    },
  ],
};

const STATS: BdStats = {
  ...META,
  run_at: '2026-09-28T06:00:00',
  lines: [
    {
      line: 'line-a',
      universe: 539,
      researched: 112,
      coverage_pct: 20.8,
      by_stage: { new: 1, drafted: 1, sent: 1 },
      conversion: { sent_to_replied: null, replied_to_meeting: null, meeting_to_won: null },
      cost: { week_usd: 0.4, month_usd: 1.25, by_engine: { qwen_local: 0, sonnet: 1.25 } },
      signal_insights: [],
    },
  ],
};

const PROSPECTS: BdProspects = {
  ...META,
  run_at: '2026-09-28T07:30:00',
  week: '2026-W40',
  counts: { surfaced: 3, with_contacts: 2, with_draft: 2 },
  prospects: [],
  skipped: [{ name: 'Example Skipped College', reason: 'robots.txt disallows the directory' }],
  errors: [{ name: 'Example Blocked College', error: 'site blocked the request' }],
};

function feeds(over: Partial<BizDevFeedStates> = {}): BizDevFeedStates {
  const s = <T,>(data: T | null) => ({ data, loading: false, error: null });
  return { bd_pipeline: s(PIPELINE), bd_stats: s(STATS), bd_prospects: s(PROSPECTS), ...over };
}

function render(over: Partial<BizDevViewProps> = {}) {
  return renderToStaticMarkup(
    <BizDevView
      feeds={feeds()}
      pending={{}}
      selectedLine={null}
      onSelectLine={vi.fn()}
      openProspectId={null}
      onOpenProspect={vi.fn()}
      onMove={vi.fn()}
      onRecheck={vi.fn()}
      recheckDisabled={false}
      rechecksToday={1}
      recheckCap={5}
      onResearch={vi.fn()}
      researchStatus="idle"
      {...over}
    />,
  );
}

describe('BizDevView', () => {
  it('renders the header, board columns, follow-ups, insights and log', () => {
    const html = render();

    expect(html).toContain('Line A');
    expect(html).toContain('112 of 539 researched (21%)');
    expect(html).toContain('qwen: free / local');
    expect(html).toContain('sonnet: $1.25');
    expect(html).toContain('1 extra batch a week');
    for (const col of ['New', 'Drafted', 'Sent', 'Replied', 'Meeting', 'Won', 'Lost']) {
      expect(html).toContain(`aria-label="${col}"`);
    }
    expect(html).toContain('Example College 2');
    expect(html).toContain('no contacts'); // prospect 1
    expect(html).toContain('4 suppressed');
    expect(html).toContain('touch 2');
    expect(html).toContain('Sample follow-up');
    expect(html).toContain('Signal insights appear once');
    expect(html).toContain('Skipped (1)');
    expect(html).toContain('Errors (1)');
    // The board never shows suppressed prospects, only the count; no drawer yet.
    expect(html).not.toContain('role="dialog"');
  });

  it('opens the drawer with the draft, contacts, outcomes and history', () => {
    const html = render({ openProspectId: 2 });

    expect(html).toContain('role="dialog"');
    expect(html).toContain('Sample rationale for the fit.');
    expect(html).toContain('a.person@example.edu');
    expect(html).toContain('value="Sample subject"');
    expect(html).toContain('Open in mail');
    expect(html).toContain('Copy subject');
    expect(html).toContain('Copy body');
    for (const outcome of ['Replied', 'Meeting', 'Won', 'Lost', 'Not interested', 'Do not contact', 'Bounced']) {
      expect(html).toContain(`>${outcome}<`);
    }
    expect(html).toContain('1 of 5 re-checks used today');
    expect(html).toContain('Sample history note');
  });

  it('disables re-check at the daily cap', () => {
    const html = render({ openProspectId: 2, recheckDisabled: true });
    expect(html).toContain('Daily re-check cap reached');
  });

  it('shows "no data yet" before Hermes publishes the pipeline and stats', () => {
    const html = render({ feeds: feeds({ bd_pipeline: { data: null, loading: false, error: null }, bd_stats: { data: null, loading: false, error: null } }) });
    expect(html).toContain('No pipeline yet');
    expect(html).toContain('No stats yet');
    expect(html).not.toContain('var(--color-error)');
  });

  it('shows an optimistic move before the pipeline catches up', () => {
    const html = render({ pending: { 2: { stage: 'replied', at: Date.now() } } });
    const replied = html.slice(html.indexOf('aria-label="Replied"'), html.indexOf('aria-label="Meeting"'));
    expect(replied).toContain('Example College 2');
  });
});

describe('suppression confirmation', () => {
  it('says the outcome is permanent', () => {
    const html = renderToStaticMarkup(
      <SuppressionConfirm stage="do_not_contact" name="Example College 9" onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('do not contact');
    expect(html).toContain('permanent');
    expect(html).toContain('Yes, permanently');
    expect(html).toContain('Cancel');
  });
});

describe('buildMailto', () => {
  it('encodes subject and body, with CRLF line breaks', () => {
    const m = buildMailto('a.person@example.edu', 'Hi & welcome?', 'Line one\nLine two');
    expect(m).toEqual({
      ok: true,
      href: 'mailto:a.person@example.edu?subject=Hi%20%26%20welcome%3F&body=Line%20one%0D%0ALine%20two',
    });
  });

  it('falls back to copy when the link would be too long', () => {
    const m = buildMailto('a.person@example.edu', 'Sample subject', 'x'.repeat(MAILTO_MAX));
    expect(m.ok).toBe(false);
    expect(m).toMatchObject({ reason: 'too_long' });
  });

  it('needs an address', () => {
    expect(buildMailto('', 's', 'b')).toEqual({ ok: false, reason: 'no_address' });
    expect(buildMailto(null, 's', 'b')).toEqual({ ok: false, reason: 'no_address' });
  });
});

describe('move reconciliation', () => {
  const line = PIPELINE.lines[0];

  it('moves a suppressed prospect off the board into the count', () => {
    const { stages, suppressed } = applyMoves(line, { 2: { stage: 'bounced', at: 1 } });
    expect(stages.drafted).toEqual([]);
    expect(suppressed).toBe(5);
  });

  it('hides a follow-up once its touch is marked sent', () => {
    expect(applyMoves(line, { 3: { stage: 'sent', at: 1, touch: 2 } }).followUps).toEqual([]);
  });

  it('drops local moves the pipeline shows, and gives up after 10 minutes', () => {
    const moved: BdPipeline = {
      ...PIPELINE,
      lines: [{ ...line, stages: { ...line.stages, drafted: [], replied: [prospect(2, 'replied')] } }],
    };
    expect(reconcileMoves(moved, { 2: { stage: 'replied', at: 0 } }, 1000).pending).toEqual({});
    const stale = reconcileMoves(PIPELINE, { 2: { stage: 'replied', at: 0 } }, 11 * 60_000);
    expect(stale).toEqual({ pending: {}, lost: [2] });
    const fresh = reconcileMoves(PIPELINE, { 2: { stage: 'replied', at: 0 } }, 60_000);
    expect(fresh.pending).toEqual({ 2: { stage: 'replied', at: 0 } });
  });
});

describe('re-check note', () => {
  const kept = {
    at: '2026-09-29T09:15:00',
    kept_previous: true,
    fit_score: 1,
    contacts: 0,
    has_draft: false,
    triage: { engine: 'local', score: 1, reason: 'Sample triage reason', disqualify: null },
    disqualify_reason: 'No staff directory found',
    draft_problems: [],
  };

  function withRecheck(recheck?: PipelineProspect['recheck']): BizDevFeedStates {
    const line = PIPELINE.lines[0];
    return feeds({
      bd_pipeline: {
        data: { ...PIPELINE, lines: [{ ...line, stages: { ...line.stages, drafted: [prospect(2, 'drafted', { recheck })] } }] },
        loading: false,
        error: null,
      },
    });
  }

  it('shows nothing before the first re-check', () => {
    const html = render({ feeds: withRecheck(undefined), openProspectId: 2 });
    expect(html).not.toContain('Re-checked');
    expect(html).not.toContain('>re-checked<');
  });

  it('explains a kept-previous re-check, with the new fit, contacts and reason', () => {
    const html = render({ feeds: withRecheck(kept), openProspectId: 2 });
    expect(html).toContain('Re-checked ');
    expect(html).toContain('New result was worse, so the earlier research was kept.');
    expect(html).toContain('New result: fit 1, 0 contacts -- No staff directory found');
    // A muted note, not an error; and the board card is marked.
    expect(html).not.toContain('var(--color-error)');
    expect(html).toContain('>re-checked<');
  });

  it('falls back to the triage reasons in order', () => {
    const noDisq = { ...kept, disqualify_reason: null, triage: { ...kept.triage, disqualify: 'Sample disqualify' } };
    expect(render({ feeds: withRecheck(noDisq), openProspectId: 2 })).toContain('-- Sample disqualify');
    const onlyReason = { ...kept, disqualify_reason: '  ', triage: { ...kept.triage, disqualify: null } };
    expect(render({ feeds: withRecheck(onlyReason), openProspectId: 2 })).toContain('-- Sample triage reason');
  });

  it('shows only the date when the new research replaced the old', () => {
    const html = render({ feeds: withRecheck({ ...kept, kept_previous: false, fit_score: 4, contacts: 2 }), openProspectId: 2 });
    expect(html).toContain('Re-checked ');
    expect(html).not.toContain('earlier research was kept');
    expect(html).not.toContain('New result:');
    expect(html).not.toContain('>re-checked<');
  });
});

describe('rank', () => {
  const penalized = prospect(21, 'drafted', {
    name: 'Example College Penalized',
    affiliation: 'NJCAA',
    fit_score: 4,
    signals: { platform: 'SamplePlatform', directory_found: true },
    rank: { score: 1, base: 4, division_factor: 1, platform_factor: 0.25, affiliation: 'NJCAA', platform: 'SamplePlatform', excluded: false },
  });
  const neutral = prospect(22, 'drafted', {
    name: 'Example College Neutral',
    affiliation: 'NAIA',
    fit_score: 3,
    rank: { score: 4, base: 4, division_factor: 1, platform_factor: 1, affiliation: 'NAIA', platform: null, excluded: false },
  });
  const unranked = prospect(23, 'drafted', { name: 'Example College Unranked', fit_score: 5 });

  function withDrafted(drafted: PipelineProspect[]): BizDevFeedStates {
    const line = PIPELINE.lines[0];
    return feeds({
      bd_pipeline: { data: { ...PIPELINE, lines: [{ ...line, stages: { ...line.stages, drafted } }] }, loading: false, error: null },
    });
  }

  it('shows the rank chip with its factors, and the affiliation', () => {
    const html = render({ feeds: withDrafted([neutral, penalized]) });
    // Penalized: fit 4 is the base, so "fit"; the platform factor names the platform.
    expect(html).toContain(
      'title="base 4 (fit) × division 1.0 (NJCAA) × platform 0.25 (SamplePlatform)">rank 1.0</span>',
    );
    // Neutral: the base differs from the fit score, so it came from triage; accent at rank >= 3.
    expect(html).toMatch(/color:var\(--color-accent\)[^>]*title="base 4 \(triage\) × division 1\.0 \(NAIA\) × platform 1\.0">rank 4\.0</);
    expect(html).toContain('>NJCAA<');
    expect(html).toContain('>NAIA<');
    expect(html).toContain('Affiliation');
    expect(html).toContain('Rank ≥');
  });

  it('shows no rank chip on a card without rank', () => {
    const html = render({ feeds: withDrafted([unranked]) });
    expect(html).toContain('Example College Unranked');
    expect(html).not.toContain('>rank ');
  });

  it('keeps the order Hermes sent, with unranked cards last', () => {
    // Deliberately not score-sorted: the board must not re-sort.
    const html = render({ feeds: withDrafted([unranked, penalized, neutral]) });
    const drafted = html.slice(html.indexOf('aria-label="Drafted"'), html.indexOf('aria-label="Sent"'));
    const at = (name: string) => drafted.indexOf(name);
    expect(at('Example College Penalized')).toBeLessThan(at('Example College Neutral'));
    expect(at('Example College Neutral')).toBeLessThan(at('Example College Unranked'));
    expect(boardOrder([unranked, penalized, neutral]).map((p) => p.id)).toEqual([21, 22, 23]);
  });

  it('filters by minimum rank (hiding unranked) and by affiliation', () => {
    const f = { ...NO_FILTERS, minRank: 3 };
    expect([penalized, neutral, unranked].filter((p) => matches(p, f)).map((p) => p.id)).toEqual([22]);
    expect([penalized, neutral, unranked].filter((p) => matches(p, NO_FILTERS)).length).toBe(3);
    expect([penalized, neutral].filter((p) => matches(p, { ...NO_FILTERS, affiliation: 'NJCAA' })).map((p) => p.id)).toEqual([21]);
  });

  it('shows the breakdown in the drawer', () => {
    const html = render({ feeds: withDrafted([penalized]), openProspectId: 21 });
    expect(html).toContain('Rank 1.0: base 4 (fit) × division 1.0 (NJCAA) × platform 0.25 (SamplePlatform)');
  });
});
