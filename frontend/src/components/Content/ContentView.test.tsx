import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type {
  ContentHealth,
  ContentPerformance,
  ContentProposals,
  ContentSeedbank,
  Lane,
  Proposal,
  ThesisLane as ThesisLaneData,
  ThesisQueueItem,
} from '../../lib/content-api';
import { applyDecisions, reconcileDecisions, type ContentFeedStates } from '../../hooks/useContentData';
import { ContentView, type ContentViewProps } from './ContentView';
import { ALL_PROPERTIES } from './format';
import { sortAlerts } from './HealthStrip';
import { socialLine } from './PerformancePanel';
import { ThesisLane, laneQueue, queueGroups, weeksOut } from './ThesisLane';
import { ApproveEditor, RejectConfirm, approvalEdits } from './ProposalsQueue';

// Neutral fixtures only: this repo is public, and real proposals name the
// operator's properties, products, pillars and topics.
const META = { generated_at: '2026-09-29T12:00:00Z', age_seconds: 600, stale: false };
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = Date.parse('2026-09-29T12:00:00Z');

function lane(over: Partial<Lane>): Lane {
  return {
    lane: 'short',
    content_type: 'short',
    cadence_per_week: 7,
    seedable: true,
    operator_only: false,
    feed_lane: false,
    queued: null,
    in_flight: 0,
    pending: 2,
    runway_days: null,
    status: 'unknown',
    ...over,
  };
}

const SEEDBANK: ContentSeedbank = {
  ...META,
  run_at: '2026-09-29T05:30:00Z',
  target_runway_days: 7,
  bundle: { commit: 'abc', age_days: 0.5, stale: false },
  snapshot: { present: false, generated_at: null, age_hours: null },
  properties: [
    {
      id: 'alpha',
      channels: ['sample-channel'],
      lanes: [
        lane({ lane: 'short' }),
        lane({ lane: 'long', content_type: 'long', status: 'operator-only', operator_only: true }),
        lane({ lane: 'feed:sample', content_type: 'news', status: 'feed', seedable: false, feed_lane: true }),
      ],
    },
    { id: 'beta', lanes: [lane({ lane: 'short', status: 'low', queued: 3, runway_days: 2.5 })] },
  ],
};

function proposal(n: number, over: Partial<Proposal> = {}): Proposal {
  return {
    id: ID(n),
    property_id: 'alpha',
    lane: 'short',
    content_type: 'short',
    status: 'pending',
    topic: `Sample topic about budget rigs ${n}`,
    rationale: 'Sample rationale.',
    signal_type: 'sample_signal',
    pillar_hint: 'grit',
    product_handle: 'sample-mount',
    source_links: ['https://example.com/source'],
    evidence: { candidates: [{ kind: 'sample_kind', text: 'Sample evidence text', link: 'https://example.com/e', fit: 5 }] },
    created_at: `2026-09-2${n}T08:00:00Z`,
    decided_at: null,
    note: null,
    approval: null,
    result: null,
    ...over,
  };
}

const PROPOSALS: ContentProposals = {
  ...META,
  run_at: '2026-09-29T06:00:00Z',
  pending: [proposal(1), proposal(2, { property_id: 'beta', pillar_hint: 'craft' })],
  recent_decided: [
    proposal(3, { status: 'intake_rejected', decided_at: '2026-09-28T10:00:00Z', result: { reasons: ['sample_reason_code'] } }),
    proposal(4, { status: 'queued', decided_at: '2026-09-28T09:00:00Z', note: 'Sample decision note' }),
  ],
  thesis_prompts: [],
  counts_30d: { pending: 2, queued: 1 },
  cost: { week_usd: 0.05, month_usd: 0.12, by_engine: { qwen_local: 0, sonnet: 0.12 } },
};

const PERFORMANCE_EMPTY: ContentPerformance = { ...META, run_at: '2026-09-29T05:00:00Z', properties: [] };

const HEALTH: ContentHealth = {
  ...META,
  run_at: '2026-09-29T05:00:00Z',
  alerts: [
    { property: 'alpha', kind: 'sample_info', severity: 'info', message: 'Sample info message' },
    { property: 'beta', kind: 'sample_warn', severity: 'warn', message: 'Sample warn message' },
  ],
};

function feeds(over: Partial<ContentFeedStates> = {}): ContentFeedStates {
  const s = <T,>(data: T | null) => ({ data, loading: false, error: null });
  return {
    content_seedbank: s(SEEDBANK),
    content_proposals: s(PROPOSALS),
    content_performance: s(PERFORMANCE_EMPTY),
    content_health: s(HEALTH),
    ...over,
  };
}

function render(over: Partial<ContentViewProps> = {}) {
  return renderToStaticMarkup(
    <ContentView
      feeds={feeds()}
      pending={{}}
      selectedProperty={ALL_PROPERTIES}
      onSelectProperty={vi.fn()}
      onApprove={vi.fn()}
      onReject={vi.fn()}
      onPrompt={vi.fn()}
      onResearch={vi.fn()}
      researchStatus="idle"
      researchAvailableAt={null}
      now={NOW}
      {...over}
    />,
  );
}

describe('ContentView', () => {
  it('renders the header, switcher, seedbank, queue and costs', () => {
    const html = render();
    expect(html).toContain('aria-label="Property"');
    for (const label of ['>All<', '>alpha<', '>beta<']) expect(html).toContain(label);
    expect(html).toContain('Foundry snapshot · not received yet');
    expect(html).toContain('Bundle · updated');
    expect(html).toContain('qwen: free / local');
    expect(html).toContain('sonnet: $0.12');
    expect(html).toContain('Capped at 1 extra run a day');
    expect(html).toContain('Target 7-day runway');
    expect(html).toContain('Pending (2)');
    expect(html).toContain('Recently decided (2)');
    expect(html).toContain('Sample topic about budget rigs 1');
    expect(html).toContain('Evidence (1)');
    expect(html).toContain('Sample evidence text');
    expect(html).toContain('fit 5');
  });

  it('lists pending proposals newest first', () => {
    const html = render();
    expect(html.indexOf('budget rigs 2')).toBeLessThan(html.indexOf('budget rigs 1'));
  });

  it('shows the seedbank statuses, including unknown, operator-only and feed', () => {
    const html = render();
    expect(html).toContain('data-status="unknown"');
    expect(html).toContain('Waiting for Foundry’s snapshot');
    expect(html).toContain('Queued </span><span class="tabular-nums" style="color:var(--color-text)">unknown');
    expect(html).toContain('data-status="operator-only"');
    expect(html).toContain('Yours: Hermes offers prompts only');
    expect(html).toContain('data-status="feed"');
    expect(html).toContain('Automatic (RSS)');
    expect(html).toContain('Feed · sample');
    expect(html).toContain('data-status="low"');
    expect(html).toContain('2.5 d');
  });

  it('filters by property', () => {
    const html = render({ selectedProperty: 'beta' });
    expect(html).toContain('budget rigs 2');
    expect(html).not.toContain('budget rigs 1');
    expect(html).not.toContain('Waiting for Foundry’s snapshot');
    expect(html).not.toContain('Sample info message');
    expect(html).toContain('Sample warn message');
  });

  it('shows recently decided statuses with intake reasons', () => {
    const html = render({ initialTab: 'decided' });
    expect(html).toContain('intake rejected');
    expect(html).toContain('Intake reasons: sample reason code');
    expect(html).toContain('queued in Foundry');
    expect(html).toContain('Sample decision note');
  });

  it('moves a local decision out of the queue before the feed catches up', () => {
    const html = render({ pending: { [ID(1)]: { action: 'reject', at: NOW, note: 'Sample reject note' } } });
    expect(html).toContain('Pending (1)');
    expect(html).toContain('Recently decided (3)');
  });

  it('shows thesis prompts only when there are any', () => {
    expect(render()).not.toContain('Thesis prompts');
    const withPrompts = feeds({
      content_proposals: {
        data: {
          ...PROPOSALS,
          thesis_prompts: [
            {
              id: ID(9),
              property_id: 'alpha',
              status: 'open',
              signal: 'Sample thesis signal',
              why_it_matters: 'Sample reason it matters',
              links: ['https://example.com/t'],
              created_at: '2026-09-29T06:00:00Z',
            },
          ],
        },
        loading: false,
        error: null,
      },
    });
    const html = render({ feeds: withPrompts });
    expect(html).toContain('Thesis prompts');
    expect(html).toContain('Prompts for you; Hermes doesn’t write theses.');
    expect(html).toContain('Sample thesis signal');
    expect(html).toContain(' Used</button>');
    expect(html).toContain(' Dismiss</button>');
    // Marked locally: gone again.
    expect(render({ feeds: withPrompts, pending: { [ID(9)]: { action: 'dismissed', at: NOW } } })).not.toContain('Thesis prompts');
  });

  it('shows the performance empty state', () => {
    expect(render()).toContain('Measurement starts when Foundry’s daily snapshot arrives.');
  });

  it('shows performance: G1 rate, rollups and recent posts', () => {
    const perf: ContentPerformance = {
      ...META,
      run_at: '2026-09-29T05:00:00Z',
      properties: [
        {
          id: 'alpha',
          posts: [
            {
              post_id: 'p1',
              origin: 'hermes',
              content_type: 'short',
              pillar: 'grit',
              distributed_at: '2026-09-28T15:00:00Z',
              excerpt: 'Sample post excerpt',
              g1: 'APPROVED',
              social: { likes: 12, comments: 1 },
              engagement: 4.2,
              site: { clicks: 3 },
              utm: { sessions: 5 },
            },
          ],
          g1: { counts: { APPROVED: 9, TIMED_OUT: 1 }, approval_rate: 0.9 },
          rollups: {
            pillar: [{ pillar: 'grit', posts: 1, avg_engagement: 4.2, sessions: 5, purchases: 0, site_clicks: 3 }],
            origin: [{ origin: 'hermes', posts: 1, avg_engagement: 4.2, sessions: 5, purchases: 0, site_clicks: 3 }],
            content_type: [],
          },
        },
      ],
    };
    const html = render({ feeds: feeds({ content_performance: { data: perf, loading: false, error: null } }), selectedProperty: 'alpha' });
    expect(html).toContain('90%');
    expect(html).toContain('9 approved · 1 timed out');
    expect(html).toContain('By pillar');
    expect(html).toContain('By origin');
    expect(html).toContain('By content type');
    expect(html).toContain('Sample post excerpt');
    expect(html).toContain('12 likes · 1 comment');
    expect(html).not.toContain('Measurement starts');
  });

  it('orders health alerts warn before info', () => {
    const html = render();
    expect(html.indexOf('Sample warn message')).toBeLessThan(html.indexOf('Sample info message'));
    expect(sortAlerts(HEALTH.alerts).map((a) => a.severity)).toEqual(['warn', 'info']);
  });

  it('shows "no data yet" before Hermes publishes, not an error', () => {
    const none = { data: null, loading: false, error: null };
    const html = render({ feeds: feeds({ content_seedbank: none, content_proposals: none, content_performance: none, content_health: none }) });
    expect(html).toContain('No seedbank yet');
    expect(html).toContain('No proposals yet');
    expect(html).not.toContain('var(--color-error)');
  });
});

describe('Research more', () => {
  it('is disabled for 24 hours after use', () => {
    const html = render({ researchAvailableAt: NOW + 3600_000 });
    expect(html).toContain('Used today; available again');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="One extra ideation run -- capped at 1 a day"/);
  });

  it('is enabled once the lock has passed', () => {
    const html = render({ researchAvailableAt: NOW - 1 });
    expect(html).toContain('Capped at 1 extra run a day');
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*title="One extra ideation run/);
  });

  it('says when it is queued', () => {
    expect(render({ researchStatus: 'queued' })).toContain('Queued -- new proposals appear within a few minutes');
  });
});

describe('approve with edits', () => {
  const p = proposal(1);

  it('renders the editor with topic, pillar choices, product and note', () => {
    const html = renderToStaticMarkup(<ApproveEditor proposal={p} pillars={['grit', 'craft']} onApprove={vi.fn()} onCancel={vi.fn()} />);
    expect(html).toContain('aria-label="Edit before approving"');
    expect(html).toContain('Sample topic about budget rigs 1</textarea>');
    expect(html).toContain('<option value="grit" selected="">grit</option>');
    expect(html).toContain('>craft<');
    expect(html).toContain('Other…');
    expect(html).toContain('value="sample-mount"');
    expect(html).toContain('Optional note');
  });

  it('sends only what changed', () => {
    const same = { topic: p.topic, pillar: 'grit', product: 'sample-mount', note: '' };
    expect(approvalEdits(p, same)).toEqual({});
    expect(approvalEdits(p, { ...same, topic: '  Sample edited topic ', pillar: 'craft', note: ' Sample note ' })).toEqual({
      topic: 'Sample edited topic',
      pillar_hint: 'craft',
      note: 'Sample note',
    });
    expect(approvalEdits(p, { ...same, product: 'sample-other' })).toEqual({ product_handle: 'sample-other' });
  });

  it('shows the approved edits in the optimistic move', () => {
    const { pending, recent } = applyDecisions(PROPOSALS, {
      [ID(1)]: { action: 'approve', at: NOW, edits: { topic: 'Sample edited topic', note: 'Sample note' } },
    });
    expect(pending.map((x) => x.id)).toEqual([ID(2)]);
    expect(recent[0]).toMatchObject({ id: ID(1), status: 'approved', topic: 'Sample edited topic', note: 'Sample note' });
  });
});

describe('reject confirmation', () => {
  it('warns that it is final and offers a note', () => {
    const html = renderToStaticMarkup(<RejectConfirm onReject={vi.fn()} onCancel={vi.fn()} />);
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('Final:');
    expect(html).toContain('Hermes won’t propose this again');
    expect(html).toContain('Optional note');
    expect(html).toContain('Reject permanently');
    expect(html).toContain('Cancel');
  });
});

describe('decision reconciliation', () => {
  it('drops decisions the feed applied and gives up after 10 minutes', () => {
    const applied = { ...PROPOSALS, pending: [proposal(2)] };
    expect(reconcileDecisions(applied, { [ID(1)]: { action: 'approve', at: 0 } }, 1000).pending).toEqual({});
    expect(reconcileDecisions(PROPOSALS, { [ID(1)]: { action: 'approve', at: 0 } }, 11 * 60_000)).toEqual({
      pending: {},
      lost: [ID(1)],
    });
    const fresh = reconcileDecisions(PROPOSALS, { [ID(1)]: { action: 'approve', at: 0 } }, 60_000);
    expect(Object.keys(fresh.pending)).toEqual([ID(1)]);
  });
});

describe('socialLine', () => {
  it('leaves out zeros and missing counts', () => {
    expect(socialLine({ likes: 1, comments: 0, saves: 2 })).toBe('1 like · 2 saves');
    expect(socialLine({})).toBe('—');
    expect(socialLine(null)).toBe('—');
  });
});

describe('ThesisLane', () => {
  const item = (n: number, over: Partial<ThesisQueueItem> = {}): ThesisQueueItem => ({
    signal_id: `sig-${n}`,
    lane_position: n,
    title: `Sample thesis ${n}`,
    summary: `Sample summary ${n}`,
    template_id: null,
    pillar_hint: 'grit',
    product_handle: 'sample-mount',
    source: 'sample',
    created_at: '2026-09-20T08:00:00Z',
    est_weeks_out: Math.ceil(n / 2),
    ...over,
  });
  const LANE: ThesisLaneData = {
    lane: 'long',
    cadence_per_week: 2,
    queued: 4,
    in_flight: 0,
    runway_days: 14,
    approvals_pending: 3,
    next_up: item(1, { template_id: 'tpl-a' }),
    // Out of order on purpose: the panel sorts by lane_position.
    queue: [
      item(3, { template_id: 'tpl-b' }),
      item(1, { template_id: 'tpl-a' }),
      item(4, { template_id: 'tpl-a', title: null, summary: 'Sample summary fallback' }),
      item(2, { template_id: 'tpl-b' }),
    ],
    posts: [
      { post_id: 'post-1', title: 'Sample posted title', excerpt: 'x', pillar: 'grit', product_handle: null, distributed_at: '2026-09-25T15:00:00Z', source: 'sample' },
      { post_id: 'post-2', title: null, excerpt: 'Sample older excerpt', pillar: 'craft', product_handle: null, distributed_at: '2026-08-01T15:00:00Z', source: 'sample' },
    ],
    flags: [
      { kind: 'runway_low', severity: 'warn', message: 'Sample runway message' },
      { kind: 'possible_repeat', severity: 'info', message: 'Sample repeat message', signal_id: 'sig-2', post_id: 'post-1' },
    ],
  };
  const withLane = (alpha: ThesisLaneData | null | undefined, beta: ThesisLaneData | null | undefined = null) =>
    feeds({
      content_seedbank: {
        data: {
          ...SEEDBANK,
          properties: SEEDBANK.properties.map((p) => {
            const lane = p.id === 'alpha' ? alpha : beta;
            if (lane === undefined) return p;
            return { ...p, thesis_lane: lane };
          }),
        },
        loading: false,
        error: null,
      },
    });
  const panel = (html: string) => html.slice(html.indexOf('data-thesis-lane='), html.indexOf('Performance'));
  const section = (html: string, name: string) => {
    const start = html.indexOf(`data-section="${name}"`);
    const next = html.indexOf('data-section="', start + 1);
    return html.slice(start, next < 0 ? undefined : next);
  };

  it('renders once, for the property whose thesis_lane is set', () => {
    const html = render({ feeds: withLane(LANE, null) });
    expect(html.match(/data-thesis-lane=/g)).toHaveLength(1);
    expect(html).toContain('data-thesis-lane="alpha"');
    expect(html).toContain('14 days at 2 a week');
    expect(html).toContain('G1 waiting (all lanes):');
    expect(html).toMatch(/Next up: <\/span><span[^>]*>Sample thesis 1</);
    expect(html).toContain('Posted (90 days) · 2');
  });

  it('orders the queue by lane_position, groups by template, and falls back to the summary', () => {
    const queue = section(panel(render({ feeds: withLane(LANE) })), 'queue');
    const order = [...queue.matchAll(/data-thesis-queue="(sig-\d)"/g)].map((m) => m[1]);
    expect(order).toEqual(['sig-1', 'sig-4', 'sig-2', 'sig-3']);
    expect([...queue.matchAll(/data-template="([^"]*)"/g)].map((m) => m[1])).toEqual(['tpl-a', 'tpl-b']);
    expect(queue).toContain('Sample summary fallback');
    expect(queueGroups([item(2), item(1)])).toEqual([{ template: null, items: [item(1), item(2)] }]);
    expect(laneQueue([item(2), item(9, { lane_position: null }), item(1)]).map((i) => i.signal_id)).toEqual(['sig-1', 'sig-2', 'sig-9']);
  });

  it('words est_weeks_out as an estimate and shows no date in the queue', () => {
    const queue = section(panel(render({ feeds: withLane(LANE) })), 'queue');
    expect(queue).toContain('about 1 week out');
    expect(queue).toContain('about 2 weeks out');
    expect(queue).not.toMatch(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w* \d/);
    expect(queue).not.toMatch(/\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}/);
    expect(weeksOut(null)).toBeNull();
    // Posts carry their own date; the excerpt stands in for a missing title.
    const posts = section(panel(render({ feeds: withLane(LANE) })), 'posts');
    expect(posts).toContain('Sample posted title');
    expect(posts).toContain('Sample older excerpt');
    expect(posts).toMatch(/Sep 25|25 Sep/);
  });

  it('shows the flags and highlights the rows a repeat names', () => {
    const html = panel(render({ feeds: withLane(LANE) }));
    expect(html).toContain('data-flag="runway_low"');
    expect(html).toContain('Sample runway message');
    expect(html).toMatch(/data-thesis-queue="sig-2" data-repeat="true"/);
    expect(html).toMatch(/data-thesis-post="post-1" data-repeat="true"/);
    expect(html).not.toMatch(/data-thesis-queue="sig-1" data-repeat/);
    expect(html).not.toMatch(/data-thesis-post="post-2" data-repeat/);
  });

  it('says "Nothing queued" for an empty queue', () => {
    const html = panel(render({ feeds: withLane({ ...LANE, queued: 0, queue: [], next_up: null, flags: [] }) }));
    expect(html).toContain('Nothing queued');
  });

  it('hides the panel for a seedbank without the key, and when nothing is set', () => {
    for (const f of [withLane(undefined, undefined), withLane(null, null)]) {
      const html = render({ feeds: f });
      expect(html).not.toContain('data-thesis-lane');
      expect(html).not.toContain('Thesis lane');
    }
  });

  it('has no enabled button, link or form', () => {
    // DashboardPanel's title is a disabled <button> when it has no onTitleClick.
    const html = renderToStaticMarkup(<ThesisLane properties={[{ id: 'alpha', lanes: [], thesis_lane: LANE }]} showProperty />);
    expect(html).toContain('data-thesis-lane="alpha"');
    expect(html.match(/<button[^>]*>/g) ?? []).toEqual([expect.stringContaining('disabled')]);
    expect(html).not.toMatch(/<a |<form|href=/i);
  });
});
