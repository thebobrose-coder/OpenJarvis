import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ContentProposals, ContentSeedbank, Lane, Proposal, ThesisPrompt } from '../../lib/content-api';
import type { ContentFeedStates } from '../../hooks/useContentData';
import { ContentView, type ContentViewProps } from './ContentView';
import { ALL_PROPERTIES } from './format';
import { DecidedItem, lanePositionOf } from './ProposalsQueue';
import {
  SeedComposer,
  SeedSent,
  VerifyLine,
  draftFromPrompt,
  emptyDraft,
  queriesAllowed,
  seedBody,
  seedProblems,
  seedProperties,
  seedTitle,
  seedableLanes,
  type SeedForm,
} from './SeedComposer';

// Neutral fixtures only: this repo is public, and real seeds name the
// operator's properties, pillars, products and topics.
const META = { generated_at: '2026-10-22T12:00:00Z', age_seconds: 60, stale: false };
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = Date.parse('2026-10-22T12:00:00Z');

function lane(over: Partial<Lane>): Lane {
  return {
    lane: 'short',
    content_type: 'short',
    cadence_per_week: 7,
    seedable: true,
    operator_only: false,
    feed_lane: false,
    queued: 3,
    in_flight: 0,
    pending: 0,
    runway_days: 3,
    status: 'ok',
    ...over,
  };
}

const SEEDBANK: ContentSeedbank = {
  ...META,
  run_at: '2026-10-22T05:30:00Z',
  target_runway_days: 7,
  properties: [
    {
      id: 'alpha',
      lanes: [
        lane({ lane: 'short' }),
        lane({ lane: 'long', content_type: 'thesis', operator_only: true, status: 'operator-only' }),
      ],
      pillars: [
        { id: 'grit', name: 'Sample Grit' },
        { id: 'craft', name: 'Sample Craft' },
      ],
      storefront: { store: 'sample-store', host: 'shop.example.com' },
      thesis_lane: {
        lane: 'long',
        cadence_per_week: 1,
        queued: 2,
        in_flight: 0,
        runway_days: 14,
        approvals_pending: 0,
        next_up: null,
        queue: [{ signal_id: 'sig-1', lane_position: 3, title: 'Sample', summary: null, template_id: null, pillar_hint: null, product_handle: null, source: 'operator:x', created_at: null, est_weeks_out: 3 }],
        posts: [],
        flags: [],
      },
    },
    {
      id: 'beta',
      lanes: [
        lane({ lane: 'short' }),
        lane({ lane: 'long', content_type: 'debrief' }),
        lane({ lane: 'feed:sample', content_type: 'debrief', seedable: false, feed_lane: true, status: 'feed' }),
      ],
      pillars: [{ id: 'field', name: 'Sample Field' }],
      storefront: null,
    },
    { id: 'gamma', lanes: [lane({ lane: 'feed:x', seedable: false, feed_lane: true })], pillars: [] },
    { id: 'delta', lanes: [lane({})], active: false },
  ],
};

const PROMPT: ThesisPrompt = {
  id: ID(9),
  property_id: 'alpha',
  status: 'open',
  signal: 'Sample signal headline',
  why_it_matters: 'Sample reason it matters.',
  links: ['http://example.com/plain', 'https://example.com/first'],
  created_at: '2026-10-22T06:00:00Z',
  seeded_proposal_id: null,
};

function form(over: Partial<SeedForm> = {}): SeedForm {
  return { property_id: 'beta', text: 'Sample title\n\nSample body', pillar: '', product: '', url: '', queries: [], priority: 2, ...over };
}

const beta = SEEDBANK.properties[1];
const betaLong = beta.lanes[1];
const alphaThesis = SEEDBANK.properties[0].lanes[1];

describe('seed helpers', () => {
  it('offers seedable and operator-only lanes, never a feed lane, on active properties only', () => {
    expect(seedableLanes(beta).map((l) => l.lane)).toEqual(['short', 'long']);
    expect(seedProperties(SEEDBANK).map((p) => p.id)).toEqual(['alpha', 'beta']);
  });

  it('allows target queries on long-form only, never on an operator-only thesis', () => {
    expect(queriesAllowed(betaLong)).toBe(true);
    expect(queriesAllowed(beta.lanes[0])).toBe(false);
    expect(queriesAllowed(alphaThesis)).toBe(false);
  });

  it('takes the title from line 1, at most 120 characters', () => {
    expect(seedTitle('  First line  \nsecond')).toBe('First line');
    expect(seedTitle('x'.repeat(200))).toHaveLength(120);
  });

  it('pre-fills Seed this: property, thesis lane, signal + why, first https link, prompt id', () => {
    expect(draftFromPrompt(PROMPT, SEEDBANK)).toEqual({
      property_id: 'alpha',
      lane: 'long',
      text: 'Sample signal headline\n\nSample reason it matters.',
      url: 'https://example.com/first',
      source_prompt_id: ID(9),
    });
  });

  it('opens New seed on the selected property, else the first', () => {
    expect(emptyDraft(SEEDBANK)).toEqual({ property_id: 'alpha', lane: 'short', text: '', url: '' });
    expect(emptyDraft(SEEDBANK, 'beta').property_id).toBe('beta');
  });

  it('sends only the bridge keys, the lane content type and no empty fields', () => {
    expect(seedBody(form(), betaLong)).toEqual({
      property_id: 'beta',
      content_type: 'debrief',
      text: 'Sample title\n\nSample body',
      priority: 2,
    });
    const full = seedBody(
      form({ pillar: 'field', product: 'sample-mount', url: 'https://example.com/a', queries: [' Budget Rig ', 'budget rig'], priority: 3 }),
      betaLong,
    );
    expect(full).toEqual({
      property_id: 'beta',
      content_type: 'debrief',
      text: 'Sample title\n\nSample body',
      pillar_hint: 'field',
      product_handle: 'sample-mount',
      url: 'https://example.com/a',
      target_queries: ['budget rig'],
      priority: 3,
    });
    expect(Object.keys(full).every((k) => !k.startsWith('motion') && k !== 'video_asset_key')).toBe(true);
  });

  it('drops target queries where the lane takes none, and carries the prompt id', () => {
    const body = seedBody(form({ property_id: 'alpha', queries: ['sample query'], source_prompt_id: ID(9) }), alphaThesis);
    expect(body.target_queries).toBeUndefined();
    expect(body.content_type).toBe('thesis');
    expect(body.source_prompt_id).toBe(ID(9));
  });

  it('blocks Queue on empty or long text, a bad handle, a non-https url, or a handle the store lacks', () => {
    expect(seedProblems(form(), betaLong, null)).toEqual([]);
    expect(seedProblems(form({ text: '  ' }), betaLong, null)).toHaveLength(1);
    expect(seedProblems(form({ text: 'x'.repeat(6001) }), betaLong, null)).toHaveLength(1);
    expect(seedProblems(form({ product: 'Sample Mount' }), betaLong, null)).toHaveLength(1);
    expect(seedProblems(form({ url: 'http://example.com' }), betaLong, null)).toHaveLength(1);
    expect(seedProblems(form({ product: 'sample-mount' }), betaLong, { state: 'not_found' })).toHaveLength(1);
    // "Couldn't check" still allows Queue: the intake checks again.
    expect(seedProblems(form({ product: 'sample-mount' }), betaLong, { state: 'unchecked', reason: 'x' })).toEqual([]);
    expect(seedProblems(form(), undefined, null)).toHaveLength(1);
  });
});

function composer(over: Partial<Parameters<typeof SeedComposer>[0]> = {}) {
  return renderToStaticMarkup(
    <SeedComposer
      seedbank={SEEDBANK}
      draft={draftFromPrompt(PROMPT, SEEDBANK)}
      onQueue={vi.fn()}
      onVerify={vi.fn()}
      onClose={vi.fn()}
      {...over}
    />,
  );
}

describe('SeedComposer', () => {
  it('opens a prompt pre-filled on the operator-only thesis lane, without target queries', () => {
    const html = composer();
    expect(html).toContain('Seed this prompt');
    expect(html).toContain('Sample signal headline');
    expect(html).toContain('https://example.com/first');
    expect(html).toContain('operator-only');
    expect(html).toContain('Title: <strong');
    expect(html).toContain('Sample Grit');
    expect(html).not.toContain('Target queries');
    expect(html).not.toContain('Feed ·');
    expect(html).toContain('Long · thesis');
    expect(html).toContain('The prompt is marked used');
    expect(html).toContain('&quot;source_prompt_id&quot;: &quot;' + ID(9));
    expect(html).toMatch(/\d+ \/ 6000/);
    expect(html).not.toContain('motion');
  });

  it('shows target queries on a long-form lane and hides the title on short-form', () => {
    const long = composer({ draft: { property_id: 'beta', lane: 'long', text: 'Sample title', url: '' } });
    expect(long).toContain('Target queries');
    expect(long).toContain('New seed');
    const short = composer({ draft: { property_id: 'beta', lane: 'short', text: 'Sample title', url: '' } });
    expect(short).not.toContain('Target queries');
    expect(short).not.toContain('Title: <strong');
  });

  it('shows the sent state with the proposal id', () => {
    const html = composer({ initialSent: ID(5) });
    expect(html).toContain('sent');
    expect(html).toContain(ID(5));
    expect(html).toContain('within about 2 minutes');
  });

  it('says what verify found', () => {
    expect(renderToStaticMarkup(<VerifyLine verify={{ state: 'found', title: 'Sample Mount', source: 'bundle' }} />)).toContain('Found: Sample Mount (bundle)');
    expect(renderToStaticMarkup(<VerifyLine verify={{ state: 'not_found' }} />)).toContain('Not found');
    const unchecked = renderToStaticMarkup(<VerifyLine verify={{ state: 'unchecked', reason: 'storefront did not answer' }} />);
    expect(unchecked).toContain('Couldn’t check');
    expect(unchecked).toContain('you can still queue');
  });
});

function seedProposal(over: Partial<Proposal>): Proposal {
  return {
    id: ID(5),
    property_id: 'alpha',
    lane: 'long',
    content_type: 'thesis',
    status: 'approved',
    topic: 'Sample title',
    created_at: '2026-10-22T12:00:00Z',
    proposed_by: 'operator',
    source_prompt_id: ID(9),
    ...over,
  };
}

describe('seed status', () => {
  it('follows the sent item: queued with its lane position', () => {
    const queued = seedProposal({ status: 'queued', result: { signalId: 'sig-1', reasons: [] } });
    const html = renderToStaticMarkup(<SeedSent proposalId={ID(5)} proposal={queued} lanePositions={{ 'sig-1': 3 }} />);
    expect(html).toContain('queued in Foundry');
    expect(html).toContain('lane position 3');
    expect(lanePositionOf(queued, { 'sig-1': 3 })).toBe(3);
    expect(lanePositionOf(seedProposal({ status: 'submitted' }), { 'sig-1': 3 })).toBeNull();
  });

  it('shows a refusal and intake reasons', () => {
    const refused = seedProposal({ status: 'rejected', note: 'seed refused: unknown-pillar: sample' });
    expect(renderToStaticMarkup(<SeedSent proposalId={ID(5)} proposal={refused} />)).toContain('seed refused: unknown-pillar');
    const rejected = seedProposal({ status: 'intake_rejected', result: { reasons: ['product-not-found'] } });
    expect(renderToStaticMarkup(<SeedSent proposalId={ID(5)} proposal={rejected} />)).toContain('product not found');
  });

  it('marks operator items in the decided list and shows a seed refusal as such', () => {
    const html = renderToStaticMarkup(
      <ul>
        <DecidedItem proposal={seedProposal({ status: 'rejected', note: 'seed refused: lane-not-available' })} showProperty={false} />
      </ul>,
    );
    expect(html).toContain('operator');
    expect(html).toContain('seed refused');
    expect(html).toContain('seed refused: lane-not-available');
    expect(html).not.toContain('“seed refused');
    const hermes = renderToStaticMarkup(
      <ul>
        <DecidedItem proposal={seedProposal({ status: 'queued', proposed_by: 'content-strategist' })} showProperty={false} />
      </ul>,
    );
    expect(hermes).not.toContain('>operator<');
  });
});

const PROPOSALS: ContentProposals = {
  ...META,
  run_at: '2026-10-22T06:00:00Z',
  pending: [],
  recent_decided: [seedProposal({ status: 'queued', result: { signalId: 'sig-1', reasons: [] } })],
  thesis_prompts: [PROMPT],
};

function view(over: Partial<ContentViewProps> = {}) {
  const s = <T,>(data: T | null) => ({ data, loading: false, error: null });
  const feeds: ContentFeedStates = {
    content_seedbank: s(SEEDBANK),
    content_proposals: s(PROPOSALS),
    content_performance: s(null),
    content_health: s(null),
    content_winners: s(null),
  };
  return renderToStaticMarkup(
    <ContentView
      feeds={feeds}
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
      onQueueSeed={vi.fn()}
      onVerifyProduct={vi.fn()}
      onRunIntake={vi.fn()}
      initialTab="decided"
      {...over}
    />,
  );
}

describe('ContentView with seeds', () => {
  it('shows New seed, Run intake now and Seed this; the queued seed with its lane position', () => {
    const html = view();
    expect(html).toContain('New seed');
    expect(html).toContain('Run intake now');
    expect(html).toContain('Seed this');
    expect(html).toContain('lane position 3');
    expect(html).toContain('>operator<');
  });

  it('hides the seed controls without the handlers', () => {
    const html = view({ onQueueSeed: undefined, onVerifyProduct: undefined, onRunIntake: undefined });
    expect(html).not.toContain('New seed');
    expect(html).not.toContain('Run intake now');
    expect(html).not.toContain('Seed this');
  });

  it('disables Run intake now during the cooldown and says when it is back', () => {
    const html = view({ intakeStatus: 'started', intakeAvailableAt: NOW + 60_000 });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="Run Foundry/);
    expect(html).toContain('Intake started');
    expect(html).toContain('again from');
    expect(view({ intakeStatus: 'ran_recently', intakeAvailableAt: NOW + 60_000 })).toContain('Intake ran under 2 minutes ago');
    expect(view()).not.toMatch(/<button[^>]*disabled=""[^>]*title="Run Foundry/);
  });

  it('renders the composer when open, and marks a prompt whose seed was sent', () => {
    const html = view({ initialComposer: draftFromPrompt(PROMPT, SEEDBANK), seededPrompts: [ID(9)] });
    expect(html).toContain('Seed this prompt');
    expect(html).toContain('seed sent');
  });
});
