import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ContentPerformance, ContentProposals, ContentWinners, HealthAlert, PerformanceProperty, Post, Proposal } from '../../lib/content-api';
import { reconcileDecisions } from '../../hooks/useContentData';
import { badPages } from './HealthStrip';
import { HealthStrip } from './HealthStrip';
import { MeasurementTiles, latestCheck, purchaseSplit, sortPosts } from './Measurement';
import { PerformancePanel } from './PerformancePanel';
import { ApproveEditor, ProposalCard, QueryChips, approvalEdits, cleanQueries, queriesEditable } from './ProposalsQueue';
import { ALL_PROPERTIES } from './format';
import { WinnersPanel, targetsLine } from './WinnersPanel';

// Contract v1.9 (measurement by page, content_winners) and v1.10 (target
// queries, priority). Neutral fixtures only, shaped like Hermes's
// content_measure / content_winners output: this repo is public.
const META = { generated_at: '2026-10-12T10:30:00Z', age_seconds: 600, stale: false };
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LANDING = { sessions: 40, engagedSessions: 20, ecommercePurchases: 2, purchaseRevenue: 80, purchases_verified: false };

function post(n: number, over: Partial<Post> = {}): Post {
  return {
    post_id: `post-${n}`,
    origin: 'hermes',
    content_type: 'long',
    pillar: 'grit',
    distributed_at: `2026-10-0${n}T12:00:00Z`,
    excerpt: `Sample long-form post ${n}`,
    engagement: 1,
    social: null,
    utm: null,
    site_path: `/journal/sample-${n}`,
    site_path_kind: 'permalink',
    url: `https://example.com/journal/sample-${n}`,
    site: { clicks: n, impressions: 100 * n, position: 30 - n },
    landing: { ...LANDING, sessions: 10 * n },
    signup_sessions: null,
    score: n === 2 ? null : n * 1.5,
    ...over,
  };
}

const MEASURED: PerformanceProperty = {
  id: 'alpha',
  posts: [
    post(1, { target_queries: ['budget rig'], targets_hit: null }),
    post(2),
    post(3, {
      target_queries: ['budget rig', 'sample mount'],
      targets_hit: {
        '7': { queries: [{ query: 'budget rig', impressions: 0, position: null }], age_days: 7 },
        '28': {
          queries: [
            { query: 'budget rig', impressions: 32, position: 14.2 },
            { query: 'sample mount', impressions: 0, position: null },
          ],
          age_days: 28,
        },
      },
    }),
    post(4, { site_path: '/feed', site_path_kind: 'feed', site: null, landing: null, score: null, excerpt: 'Sample short post' }),
  ],
  g1: { counts: { APPROVED: 3 }, approval_rate: 1 },
  rollups: { pillar: [{ pillar: 'grit', posts: 3, avg_engagement: 1, sessions: 60, purchases: 6, site_clicks: 6, site_impressions: 600, scored: 2, score: 3.4 }] },
  lane_pages: [
    { site_path: '/feed', content_type: 'short', posts: 9, engagement: 12, site: { clicks: 3, impressions: 90 }, landing: LANDING, signup_sessions: null, score: 2.2 },
  ],
  measurement: {
    regime: 'early',
    gsc_clicks_28d: 6,
    purchases_28d: 6,
    purchases_verified: false,
    sources: { gsc: true, ga4: true },
    signup_sessions_28d: null,
    posts_with_path: 3,
    with_gsc: 3,
    with_landing: 3,
    lane_pages_with_gsc: 1,
    lane_pages_with_landing: 1,
    days_since_first_path: 9,
  },
};

const perf = (properties: PerformanceProperty[]): ContentPerformance => ({ ...META, run_at: '2026-10-12T10:30:00Z', properties });

const OLD_POST: Post = {
  post_id: 'post-old',
  origin: 'hermes',
  excerpt: 'Sample older post',
  site: { clicks: 1, impressions: 5 },
  utm: { sessions: 7 },
};

describe('purchases tile (v1.21 split)', () => {
  it('reads a plain number from an older row', () => {
    expect(purchaseSplit(6)).toEqual({ total: 6, organic: 6, paid: null });
    const html = renderToStaticMarkup(<MeasurementTiles m={{ purchases_28d: 6 }} />);
    expect(html).toContain('>6<');
    expect(html).toContain('from content landings');
    expect(html).not.toContain('[object Object]');
  });

  it('sums organic and paid, with the split as the sub-line when paid is non-zero', () => {
    expect(purchaseSplit({ organic: 4, paid: 2 })).toEqual({ total: 6, organic: 4, paid: 2 });
    const html = renderToStaticMarkup(<MeasurementTiles m={{ purchases_28d: { organic: 4, paid: 2 } }} />);
    expect(html).toContain('>6<');
    expect(html).toContain('organic 4, paid 2');
    expect(html).not.toContain('[object Object]');
  });

  it('shows no split when paid is zero', () => {
    const html = renderToStaticMarkup(<MeasurementTiles m={{ purchases_28d: { organic: 3, paid: 0 } }} />);
    expect(html).toContain('>3<');
    expect(html).not.toContain('paid');
  });
});

describe('performance by page (v1.9)', () => {
  it('shows the long-form table, lane pages, measurement tiles and unverified purchases', () => {
    const html = renderToStaticMarkup(<PerformancePanel performance={perf([MEASURED])} selectedProperty="alpha" />);
    expect(html).toContain('Long-form pages (3)');
    expect(html).toContain('/journal/sample-1');
    expect(html).toContain('Short-form feed pages, per lane');
    expect(html).toContain('>/feed<');
    expect(html).toContain('Search clicks (28 days)');
    expect(html).toContain('early scoring');
    expect(html).toContain('unverified');
    expect(html).toContain('Pages measured');
    expect(html).toContain('>Score<'); // rollup column
    expect(html).not.toContain('Sign-up sessions'); // no sign-up join for this property
  });

  it('sorts by score first, unscored posts last', () => {
    const html = renderToStaticMarkup(<PerformancePanel performance={perf([MEASURED])} selectedProperty="alpha" />);
    const table = html.slice(html.indexOf('Long-form pages'), html.indexOf('Short-form feed pages'));
    const order = [3, 1, 2].map((n) => table.indexOf(`/journal/sample-${n}<`));
    expect(order.every((at) => at > 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(table).toContain('aria-sort="descending"');
  });

  it('sorts position ascending and keeps missing values last', () => {
    const posts = [post(1), post(2, { site: null }), post(3)];
    expect(sortPosts(posts, 'position').map((p) => p.post_id)).toEqual(['post-3', 'post-1', 'post-2']);
    expect(sortPosts(posts, 'impressions').map((p) => p.post_id)).toEqual(['post-3', 'post-1', 'post-2']);
  });

  it('shows "did it rank?" at the latest checkpoint, or the queries still waiting', () => {
    const html = renderToStaticMarkup(<PerformancePanel performance={perf([MEASURED])} selectedProperty="alpha" />);
    expect(html).toContain('Targets, day 28:');
    expect(html).toContain('budget rig · pos 14.2 · 32 impr.');
    expect(html).toContain('sample mount · not shown');
    expect(html).toContain('Targets (first check at day 7):');
    expect(latestCheck(MEASURED.posts[2].targets_hit)?.day).toBe(28);
    expect(latestCheck(null)).toBeNull();
  });

  it('adds a sign-ups column and tile for a property with a sign-up join', () => {
    const withSignups: PerformanceProperty = {
      ...MEASURED,
      posts: MEASURED.posts.map((p) => ({ ...p, signup_sessions: 4 })),
      measurement: { ...MEASURED.measurement!, signup_sessions_28d: 11 },
    };
    const html = renderToStaticMarkup(<PerformancePanel performance={perf([withSignups])} selectedProperty="alpha" />);
    expect(html).toContain('Sign-up sessions (28 days)');
    expect(html).toContain('>Sign-ups<');
  });

  it('says nothing is joined yet when the feed measures by page but no post has a page', () => {
    const bare: PerformanceProperty = { ...MEASURED, posts: [{ ...OLD_POST }], lane_pages: [] };
    const html = renderToStaticMarkup(<PerformancePanel performance={perf([bare])} selectedProperty="alpha" />);
    expect(html).toContain('No post carries a page yet');
  });

  it('renders an older feed (no v1.9 keys) as before', () => {
    const old: PerformanceProperty = { id: 'alpha', posts: [OLD_POST], rollups: { pillar: [{ pillar: 'grit', posts: 1, avg_engagement: 0, sessions: 0, purchases: 0, site_clicks: 0 }] } };
    const html = renderToStaticMarkup(<PerformancePanel performance={perf([old])} selectedProperty="alpha" />);
    expect(html).toContain('Recent posts');
    expect(html).toContain('Sample older post');
    expect(html).toContain('>7<'); // utm sessions still shown
    for (const absent of ['Long-form pages', 'Short-form feed pages', 'Search clicks', 'No post carries a page', '>Score<', 'unverified']) {
      expect(html).not.toContain(absent);
    }
  });
});

const WINNERS: ContentWinners = {
  ...META,
  run_at: '2026-10-18T10:50:00Z',
  performance_run_at: '2026-10-18T10:30:00Z',
  window_days: 28,
  properties: [
    {
      id: 'alpha',
      top: [{ ...post(3), target_queries: MEASURED.posts[2].target_queries, targets_hit: MEASURED.posts[2].targets_hit }],
      bottom: [post(1)],
      long_form: 3,
      unmeasured: 1,
      regime: 'early',
      lane_pages: MEASURED.lane_pages,
      page_queries: {
        '/journal/sample-3': [{ query: 'sample gear list', clicks: 2, impressions: 40, position: 8.4 }],
        '/feed': [{ query: 'sample feed query', clicks: 1, impressions: 12, position: 22 }],
      },
      targets: {
        all: { all: 'all', posts: 1, queries: 2, hit: 1, top20: 1, hit_rate: 0.5 },
        by_pillar: [{ pillar: 'grit', posts: 1, queries: 2, hit: 1, top20: 1, hit_rate: 0.5 }],
      },
    },
    { id: 'beta', top: [], bottom: [], long_form: 0, unmeasured: 0, regime: 'early', lane_pages: [], page_queries: {} },
  ],
  errors: {},
};

describe('winners / laggards (v1.9-v1.10)', () => {
  it('shows winners, laggards, top queries per page and the target hit rate', () => {
    const html = renderToStaticMarkup(<WinnersPanel winners={WINNERS} selectedProperty="alpha" showProperty={false} />);
    expect(html).toContain('Winners / laggards');
    expect(html).toContain('Weekly · 28 days');
    expect(html).toContain('3 long-form posts, 1 not measured yet');
    expect(html).toContain('>Winners<');
    expect(html).toContain('>Laggards<');
    expect(html).toContain('Sample long-form post 3');
    expect(html).toContain('sample gear list');
    expect(html).toContain('Feed pages: top queries');
    expect(html).toContain('sample feed query');
    expect(html).toContain('Did it rank?');
    expect(html).toContain('1 of 2 target queries shown (50%) · 1 in the top 20, across 1 post');
    expect(html).toContain('grit: 1 of 2');
    expect(html).not.toContain('beta');
  });

  it('says when nothing is ranked yet, or the feed has not run', () => {
    expect(renderToStaticMarkup(<WinnersPanel winners={WINNERS} selectedProperty="beta" showProperty={false} />)).toContain(
      'No scored long-form posts yet.',
    );
    expect(renderToStaticMarkup(<WinnersPanel winners={null} selectedProperty={ALL_PROPERTIES} showProperty />)).toContain(
      'the first ranking hasn’t run yet',
    );
  });

  it('works without the v1.10 targets key', () => {
    const { targets: _drop, ...older } = WINNERS.properties[0];
    const html = renderToStaticMarkup(<WinnersPanel winners={{ ...WINNERS, properties: [older] }} selectedProperty="alpha" showProperty={false} />);
    expect(html).toContain('>Winners<');
    expect(html).not.toContain('Did it rank?');
    expect(targetsLine({ posts: 2, queries: 0, hit: 0, top20: 0, hit_rate: null })).toContain('(—)');
  });
});

describe('measurement health alerts (v1.9)', () => {
  const alerts: HealthAlert[] = [
    { property: 'alpha', kind: 'measurement_unjoined', severity: 'info', message: 'Sample: nothing joined in 14 days.' },
    {
      property: 'alpha',
      kind: 'measurement_tag_mismatch',
      severity: 'warn',
      message: 'Measurement check: sample failure.',
      pages: { apex: 'ok', long_form: 'no-permalink', shop: 'missing-id' },
    },
  ];

  it('renders both kinds like the others, warn first, with the failing pages', () => {
    const html = renderToStaticMarkup(<HealthStrip alerts={alerts} showProperty={false} />);
    expect(html).toContain('measurement tag mismatch');
    expect(html).toContain('measurement unjoined');
    expect(html.indexOf('tag mismatch')).toBeLessThan(html.indexOf('unjoined'));
    expect(html).toContain('shop: missing id');
    expect(html).not.toContain('long_form: no permalink');
    expect(badPages(alerts[0])).toEqual([]);
  });
});

function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: ID(1),
    property_id: 'alpha',
    lane: 'long',
    content_type: 'long',
    status: 'pending',
    topic: 'Sample topic about budget rigs',
    pillar_hint: 'grit',
    product_handle: null,
    created_at: '2026-10-12T10:45:00Z',
    note: null,
    target_queries: ['budget rig', 'sample mount'],
    priority: 3,
    ...over,
  };
}

describe('target queries and priority on proposals (v1.10)', () => {
  it('shows the queries and the priority on the card', () => {
    const html = renderToStaticMarkup(
      <ProposalCard proposal={proposal()} pillars={[]} showProperty={false} onApprove={vi.fn()} onReject={vi.fn()} />,
    );
    expect(html).toContain('Target queries');
    expect(html).toContain('>budget rig<');
    expect(html).toContain('priority 3');
  });

  it('shows the default priority when the feed says null, and nothing for an older feed', () => {
    const dflt = renderToStaticMarkup(
      <ProposalCard proposal={proposal({ priority: null, target_queries: null })} pillars={[]} showProperty={false} onApprove={vi.fn()} onReject={vi.fn()} />,
    );
    expect(dflt).toContain('priority 2');
    expect(dflt).not.toContain('Target queries');
    const { target_queries: _q, priority: _p, ...older } = proposal();
    const old = renderToStaticMarkup(<ProposalCard proposal={older} pillars={[]} showProperty={false} onApprove={vi.fn()} onReject={vi.fn()} />);
    expect(old).not.toContain('priority');
    expect(old).not.toContain('Target queries');
    const edit = renderToStaticMarkup(<ApproveEditor proposal={older} pillars={[]} onApprove={vi.fn()} onCancel={vi.fn()} />);
    expect(edit).not.toContain('aria-label="Priority"');
    expect(edit).not.toContain('Add a target query');
  });

  it('shows an "edit refused" note on a pending card', () => {
    const html = renderToStaticMarkup(
      <ProposalCard
        proposal={proposal({ note: 'edit refused: sample reason' })}
        pillars={[]}
        showProperty={false}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    expect(html).toContain('role="note"');
    expect(html).toContain('edit refused: sample reason');
  });

  it('edits queries as chips (3 at most) and priority as 1-3 in the editor', () => {
    const html = renderToStaticMarkup(<ApproveEditor proposal={proposal()} pillars={[]} onApprove={vi.fn()} onCancel={vi.fn()} />);
    expect(html).toContain('Remove budget rig');
    expect(html).toContain('Add a target query');
    expect(html).toContain('aria-label="Priority"');
    for (const l of ['1 low', '>2<', '3 high']) expect(html).toContain(l);
    const full = renderToStaticMarkup(<QueryChips queries={['a1', 'b2', 'c3']} onChange={vi.fn()} />);
    expect(full).toContain('3 at most');
    expect(full).not.toContain('Add a target query');
  });

  it('only offers query edits on long-form proposals or ones that already carry queries', () => {
    expect(queriesEditable(proposal())).toBe(true);
    expect(queriesEditable(proposal({ lane: 'short', target_queries: null }))).toBe(false);
    expect(queriesEditable(proposal({ lane: 'short', target_queries: ['budget rig'] }))).toBe(true);
    const { target_queries: _q, ...older } = proposal();
    expect(queriesEditable(older)).toBe(false);
  });

  it('sends only what changed', () => {
    const base = { topic: 'Sample topic about budget rigs', pillar: 'grit', product: '', note: '' };
    const p = proposal();
    expect(approvalEdits(p, { ...base, queries: [' Budget Rig ', 'sample mount'], priority: 3 })).toEqual({});
    expect(approvalEdits(p, { ...base, queries: ['budget rig', 'sample bag'], priority: 3 })).toEqual({
      target_queries: ['budget rig', 'sample bag'],
    });
    expect(approvalEdits(p, { ...base, queries: [], priority: 1 })).toEqual({ target_queries: [], priority: 1 });
    // A null priority is the default 2: choosing 2 is no change.
    expect(approvalEdits(proposal({ priority: null, target_queries: null }), { ...base, queries: [], priority: 2 })).toEqual({});
    // An older feed: no targeting fields at all.
    expect(approvalEdits(p, base)).toEqual({});
  });

  it('cleans queries the way Hermes stores them', () => {
    expect(cleanQueries([' Budget Rig ', 'budget rig', '', 'b', 'c', 'd'])).toEqual(['budget rig', 'b', 'c']);
    expect(cleanQueries(['x'.repeat(90)])[0]).toHaveLength(80);
  });
});

describe('a refused edit (v1.10)', () => {
  const feed = (note: string | null): ContentProposals => ({
    ...META,
    run_at: '2026-10-12T11:00:00Z',
    pending: [proposal({ note })],
    recent_decided: [],
    thesis_prompts: [],
  });

  it('drops the local approval at once and reports the refusal', () => {
    const local = { [ID(1)]: { action: 'approve' as const, at: 0, edits: { target_queries: ['sample'] }, priorNote: null } };
    expect(reconcileDecisions(feed('edit refused: sample reason'), local, 60_000)).toEqual({
      pending: {},
      lost: [],
      refused: ['edit refused: sample reason'],
    });
  });

  it('keeps waiting while the note is the one the proposal already had', () => {
    const local = { [ID(1)]: { action: 'approve' as const, at: 0, priorNote: 'edit refused: earlier' } };
    const r = reconcileDecisions(feed('edit refused: earlier'), local, 60_000);
    expect(Object.keys(r.pending)).toEqual([ID(1)]);
    expect(r.refused).toEqual([]);
  });
});
