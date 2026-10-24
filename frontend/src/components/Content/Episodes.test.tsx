import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ContentSeedbank, Lane, ThesisPrompt } from '../../lib/content-api';
import type { Claim, EpisodeDetail, EpisodeSummary, Manifest, StudioStatus } from '../../lib/studio-api';
import { EpisodeDrawer, EpisodeDrawerView, type EpisodeActions } from './EpisodeDrawer';
import { EpisodesPanel } from './EpisodesPanel';
import { g0Notes, isEpisodeId, parseTags, publishEditable, publishProblems, scriptSections, stageNotes } from './episodes';
import {
  SeedComposer,
  episodeDraftFromPrompt,
  isEpisode,
  parseSources,
  promptEpisodeClass,
  queriesAllowed,
  seedBody,
  seedProblems,
  seedVideoAllowed,
  type SeedForm,
} from './SeedComposer';
import { ThesisPrompts } from './ThesisPrompts';
import { ALL_PROPERTIES } from './format';

// Invented fixtures only: this repo is public.
const NOW = Date.parse('2026-10-24T06:00:00Z');
const EID = '01ABCDEFGHJKMNPQRSTVWXYZ00';

const CLAIMS: Claim[] = [
  { id: 'c1', beat: 1, text: 'A sample fact.', source: 'https://example.com/a', kind: 'fact' },
  { id: 'c2', beat: 2, text: 'An uncited sample fact.', source: 'unsourced', kind: 'fact' },
];
const SCRIPT = '## [Beat 1: ONE]\n\nSample one.\n\n## [Beat 2: TWO]\n\nSample two.\n';

function manifest(over: Partial<Manifest> = {}): Manifest {
  return {
    episodeId: EID,
    propertyId: 'alpha',
    stage: 'awaiting-g0',
    episodeClass: 'sample-class',
    targetMinutes: 8,
    sources: ['https://example.com/a'],
    topic: 'Sample topic about budget rigs',
    title: 'SAMPLE TITLE',
    stages: [
      { stage: 'scripted', at: '2026-10-24T05:50:00Z', ok: true, note: '1 pass; for G0: beat 1: it ran 226 words; keep it under 145; beat 2: too long' },
      { stage: 'awaiting-g0', at: '2026-10-24T05:50:00Z', ok: true },
    ],
    prescreen: { passes: 1, verdict: 'pass', reasons: [] },
    cloud: { capEpisodeUsd: 2, spentUsd: 0, omniAllowed: false, items: [] },
    gpuMinutes: 3.5,
    rewrites: 0,
    ...over,
  };
}

function summary(over: Partial<EpisodeSummary> = {}): EpisodeSummary {
  return {
    episodeId: EID,
    propertyId: 'alpha',
    stage: 'awaiting-g0',
    since: '2026-10-24T05:50:00Z',
    updatedAt: '2026-10-24T05:50:00Z',
    title: 'SAMPLE TITLE',
    topic: 'Sample topic',
    episodeClass: 'sample-class',
    targetMinutes: 8,
    gpuMinutes: 3.5,
    spentUsd: 0,
    durationSeconds: null,
    youtubeVisibility: null,
    postId: null,
    stoppedReason: null,
    stageNote: null,
    rewrites: 0,
    g0Pending: false,
    ...over,
  };
}

function detail(over: Partial<EpisodeDetail> = {}, m: Partial<Manifest> = {}): EpisodeDetail {
  return {
    summary: summary({ stage: m.stage ?? 'awaiting-g0' }),
    manifest: manifest(m),
    script: SCRIPT,
    claims: CLAIMS,
    plan: {
      beats: [
        { beat: 1, heading: 'ONE', words: 120, visual: { kind: 'still', prompt: 'A sample still.' }, sound: 'rain', claimIds: ['c1'] },
        { beat: 2, heading: 'TWO', visual: { kind: 'kinetic', lines: ['Line one.', 'Line two.'] }, claimIds: ['c2'] },
      ],
    },
    chapters: null,
    publish: null,
    narration: null,
    g0Pending: null,
    g0History: [],
    media: { cut: null, short: null, thumbs: [] },
    version: 'v1',
    edited: false,
    channel: null,
    visibility: { visibility: 'unlisted', number: 1, first: 5 },
    paused: false,
    sourceIndex: null,
    ...over,
  };
}

const ACTIONS: EpisodeActions = {
  onSaveScript: vi.fn(async () => undefined),
  onG0: vi.fn(async () => ({ decision: 'approve' as const, at: '', omni: false, claimsChecked: [], edited: false })),
  onSavePublish: vi.fn(async () => undefined),
  loadMedia: vi.fn(async () => 'blob:x'),
};

const STATUS: StudioStatus = {
  generatedAt: '2026-10-24T05:55:00Z',
  paused: { alpha: false, beta: true },
  lanes: [
    { propertyId: 'alpha', queued: 0, inProduction: 1, published30d: 0, runwayDays: 7 },
    { propertyId: 'beta', queued: 0, inProduction: 0, published30d: 0, runwayDays: 0 },
  ],
  inFlight: [],
  spend: { month: '2026-10', alpha: { usd: 0.4, capUsd: 20, gpuMinutes: 21.7 } },
  lastRun: { at: '2026-10-24T05:55:00Z', ok: true, advanced: 1 },
  published: { alpha: 0, beta: 0 },
  channels: {
    alpha: { channelName: 'SAMPLE CHANNEL', lanePerWeek: 1, cloudCapUsdPerEpisode: 2, cloudCapUsdPerMonth: 20, gpuMinutesCap: 45, firstUnlisted: 5, episodeClasses: [] },
  },
  age_seconds: 300,
  stale: false,
};

const panel = (over: Partial<Parameters<typeof EpisodesPanel>[0]> = {}) =>
  renderToStaticMarkup(
    <EpisodesPanel
      status={STATUS}
      episodes={[summary()]}
      selectedProperty={ALL_PROPERTIES}
      showProperty
      loading={false}
      error={null}
      now={NOW}
      onOpen={() => undefined}
      onRun={() => undefined}
      onPause={() => undefined}
      {...over}
    />,
  );

describe('episodes helpers', () => {
  it('reads the G0 quality notes off the scripted stage', () => {
    expect(g0Notes(manifest())).toEqual(['beat 1: it ran 226 words; keep it under 145', 'beat 2: too long']);
    expect(g0Notes(manifest({ stages: [{ stage: 'scripted', at: '', ok: true, note: '1 pass' }] }))).toEqual([]);
  });

  it('collects the notes since the current stage began', () => {
    const m = manifest({
      stages: [
        { stage: 'scripted', at: '', ok: true, note: 'old' },
        { stage: 'awaiting-g0', at: '', ok: true },
        { stage: 'awaiting-g0', at: '', ok: false, note: 'G0 approve refused: claims not checked: c2' },
      ],
    });
    expect(stageNotes(m)).toEqual(['G0 approve refused: claims not checked: c2']);
  });

  it('counts beat headings and checks ids, tags and publish fields', () => {
    expect(scriptSections(SCRIPT)).toBe(2);
    expect(isEpisodeId(EID)).toBe(true);
    expect(isEpisodeId('00000000-0000-4000-8000-000000000000')).toBe(false);
    expect(parseTags(' one, ,two ')).toEqual(['one', 'two']);
    const ok = { title: 'A title', description: '', tags: [], thumbnail: 'thumb-1.jpg' };
    expect(publishProblems(ok, ['thumb-1.jpg'])).toEqual([]);
    expect(publishProblems({ ...ok, title: 'x', thumbnail: 'thumb-9.jpg' }, ['thumb-1.jpg'])).toHaveLength(2);
    expect(publishProblems({ ...ok, description: 'a <b>' }, ['thumb-1.jpg'])).toHaveLength(1);
    expect(publishEditable({ stage: 'assembling' })).toBe(true);
    expect(publishEditable({ stage: 'at-g1' })).toBe(false);
    expect(publishEditable({ stage: 'stopped', executionArn: 'arn' })).toBe(false);
  });
});

describe('EpisodesPanel', () => {
  it('shows each channel with its counts, spend, caps and episodes', () => {
    const html = panel();
    expect(html).toContain('SAMPLE CHANNEL');
    expect(html).toContain('in production');
    expect(html).toContain('$0.40 / $20.00');
    expect(html).toContain('21.7 min');
    expect(html).toContain('45 min');
    expect(html).toContain(`id="episode-${EID}"`);
    expect(html).toContain('Review G0');
    expect(html).toContain('Run studio now');
  });

  it('marks a paused channel and offers Resume, and never a publish button', () => {
    const html = panel();
    expect(html).toContain('paused');
    expect(html).toContain('Resume');
    expect(html).not.toMatch(/>\s*Publish\s*</);
  });

  it('shows a sent decision instead of Review G0', () => {
    const html = panel({ episodes: [summary({ g0Pending: true })] });
    expect(html).toContain('decision sent');
    expect(html).not.toContain('Review G0');
  });

  it('filters by property and hides without a studio', () => {
    expect(panel({ selectedProperty: 'beta' })).not.toContain('SAMPLE CHANNEL');
    expect(panel({ status: null })).toBe('');
  });

  it('warns on a failed run and cools the button down', () => {
    const html = panel({
      status: { ...STATUS, lastRun: { at: STATUS.generatedAt, ok: false, advanced: 0, note: 'sample failure' } },
      runStatus: 'started',
      runAvailableAt: NOW + 60_000,
    });
    expect(html).toContain('last run failed: sample failure');
    expect(html).toContain('Ran just now');
  });
});

describe('v0.1.3-v0.1.4 additions', () => {
  const view = (d: EpisodeDetail) => renderToStaticMarkup(<EpisodeDrawerView detail={d} loading={false} error={null} actions={ACTIONS} now={NOW} />);
  const HITS = [
    { beat: 2, sentence: 'The sample source says this almost word for word.', sourceN: 1, run: 'says this almost word for word', kind: 'run' as const },
    { beat: 2, sentence: 'Another dense sentence.', sourceN: 2, run: 'dense sentence', kind: 'density' as const },
  ];

  it('reads "not checked" on a draft without sourceCopy', () => {
    expect(view(detail())).toContain('Not checked: this draft was written before');
  });

  it('shows the hits by beat with the shared words marked and the source named from the snapshot', () => {
    const html = view(detail({ sourceIndex: [{ n: 1, url: 'https://example.com/a' }, { n: 2, url: 'https://example.com/b' }] }, { sourceCopy: HITS }));
    expect(html).toContain('Source copy (2)');
    expect(html).toContain('data-copy-beat="2"');
    expect(html).toContain('Beat 2: TWO · 2 hits');
    expect(html).toMatch(/<mark[^>]*>says this almost word for word<\/mark>/);
    expect(html).toContain('copied run');
    expect(html).toContain('dense overlap');
    expect(html).toContain('title="https://example.com/b"');
    expect(html).toContain('2 source-copy hits');
  });

  it('is a note, never a block on Approve', () => {
    const html = view(detail({}, { sourceCopy: HITS }));
    expect(html).not.toContain('source copy');
    expect(html).toContain('Check every claim: 2 of 2 not checked.');
    expect(html).not.toMatch(/Approve[^<]*source/i);
  });

  it('says so when the check found nothing', () => {
    expect(view(detail({}, { sourceCopy: [] }))).toContain('No sentence follows a source’s wording.');
  });

  it('puts the studio wait note on the card and the run error beside the button', () => {
    const html = panel({
      episodes: [summary({ stage: 'visualizing', stageNote: 'waiting for the operator fixed text' })],
      runStatus: 'error',
      runError: 'ERROR: The system cannot find the file specified.',
    });
    expect(html).toContain('waiting for the operator fixed text');
    expect(html).toContain('Run studio now failed: ERROR: The system cannot find the file specified.');
  });
});

describe('the episode drawer', () => {
  const view = (d: EpisodeDetail | null, over: Partial<Parameters<typeof EpisodeDrawerView>[0]> = {}) =>
    renderToStaticMarkup(<EpisodeDrawerView detail={d} loading={false} error={null} actions={ACTIONS} now={NOW} {...over} />);

  it('opens the G0 review at awaiting-g0', () => {
    const html = view(detail());
    expect(html).toContain('Sample one.');
    expect(html).toContain('A sample fact.');
    expect(html).toContain('unsourced: needs a ruling');
    expect(html).toContain('0 / 2 checked');
    expect(html).toContain('beat 1: it ran 226 words');
    expect(html).toContain('A sample still.');
    expect(html).toContain('Line one. / Line two.');
    expect(html).toContain('Omni');
    expect(html).toContain('rewrites 0 / 2');
  });

  it('keeps Approve disabled until every claim is checked, and Omni off', () => {
    const html = view(detail());
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*?Approve/);
    expect(html).toContain('Check every claim: 2 of 2 not checked.');
    expect(html).not.toMatch(/type="checkbox"[^>]*checked=""[^>]*\/>\s*<span>\s*Omni/);
  });

  it('warns when the script and the plan disagree on beats', () => {
    const html = view(detail({ script: '## [Beat 1: ONE]\n\nOnly one.\n' }));
    expect(html).toContain('The script has 1 beat headings and the plan 2');
  });

  it('stops rewrite at two', () => {
    const html = view(detail({}, { rewrites: 2 }));
    expect(html).toContain('rewrites 2 / 2');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="2 rewrites already/);
  });

  it('shows a waiting decision instead of the review', () => {
    const html = view(detail({ g0Pending: { decision: 'approve', at: '2026-10-24T05:58:00Z', omni: false, claimsChecked: ['c1', 'c2'], edited: false } }));
    expect(html).toContain('the studio applies it on its next run');
    expect(html).not.toContain('0 / 2 checked');
  });

  it('after G0 shows the media, checks, publish form, visibility and the AI-label reminder, with no publish button', () => {
    const html = view(
      detail(
        { media: { cut: 120_000_000, short: 9_000_000, thumbs: ['thumb-1.jpg', 'thumb-2.jpg'] }, chapters: ['0:00 One'], visibility: { visibility: 'public', number: 6, first: 5 } },
        { stage: 'assembling', durationSeconds: 492, cloud: { capEpisodeUsd: 2, spentUsd: 0.5, omniAllowed: true, items: [{ kind: 'still', usd: 0.04, at: '' }] } },
      ),
    );
    expect(html).toContain('The 60 s cut (9 MB)');
    expect(html).toContain('The full cut (120 MB)');
    expect(html).toContain('Episode 6 on this channel');
    expect(html).toContain('PUBLIC');
    expect(html).toContain('altered or synthetic content');
    expect(html).toContain('Save publish.json');
    expect(html).toContain('thumb-2.jpg');
    expect(html).toContain('8:12');
    expect(html).toContain('Omni on');
    expect(html).not.toMatch(/(<button[^>]*>|<\/svg>)\s*Publish\b/);
  });

  it('locks the publish form once submitted', () => {
    const html = view(detail({ media: { cut: 1, short: 1, thumbs: ['thumb-1.jpg'] } }, { stage: 'at-g1' }));
    expect(html).toContain('Submitted: the title and thumbnail are with the pipeline now.');
    expect(html).not.toContain('Save publish.json');
  });

  it('renders the drawer shell only when open', () => {
    const shell = (open: boolean) =>
      renderToStaticMarkup(<EpisodeDrawer open={open} title="SAMPLE TITLE" onClose={() => undefined} detail={detail()} loading={false} error={null} actions={ACTIONS} now={NOW} />);
    expect(shell(false)).toBe('');
    expect(shell(true)).toContain('role="dialog"');
  });
});

// -- the composer's episode lane (v1.17) ---------------------------------------

function lane(over: Partial<Lane>): Lane {
  return {
    lane: 'short',
    content_type: 'short',
    cadence_per_week: 7,
    seedable: true,
    operator_only: false,
    feed_lane: false,
    queued: 0,
    in_flight: 0,
    pending: 0,
    runway_days: 0,
    status: 'ok',
    ...over,
  };
}

const EPISODE_LANE = lane({ lane: 'episode', content_type: 'episode', cadence_per_week: 1 });
const SEEDBANK: ContentSeedbank = {
  generated_at: '2026-10-24T05:00:00Z',
  age_seconds: 60,
  stale: false,
  run_at: '2026-10-24T05:00:00Z',
  target_runway_days: 7,
  properties: [
    {
      id: 'alpha',
      lanes: [lane({}), lane({ lane: 'long', content_type: 'thesis', operator_only: true }), EPISODE_LANE],
      episode_classes: [
        { id: 'sample-briefing', name: 'Sample Briefing', operator_only: true },
        { id: 'sample-check', name: 'Sample Check', operator_only: false },
      ],
      motion: { lanes: ['short', 'episode'], durationSeconds: 8, monthlySecondsCap: 120, release: 'instagram' } as never,
    },
    { id: 'beta', lanes: [lane({})] },
  ],
};

const PROMPT: ThesisPrompt = {
  id: '00000000-0000-4000-8000-000000000001',
  property_id: 'alpha',
  status: 'open',
  signal: 'A sample signal',
  why_it_matters: 'Sample reason',
  links: ['https://example.com/a', 'http://example.com/b'],
  created_at: '2026-10-24T05:00:00Z',
};

const form = (over: Partial<SeedForm> = {}): SeedForm => ({
  property_id: 'alpha',
  text: 'Sample topic',
  pillar: '',
  product: '',
  url: 'https://example.com/ignored',
  queries: ['ignored'],
  priority: 2,
  episode: { cls: 'sample-check', sources: [' https://example.com/a '], minutes: 8 },
  ...over,
});

describe('the composer on the episode lane', () => {
  it('is its own lane: no target queries, no Video control', () => {
    expect(isEpisode(EPISODE_LANE)).toBe(true);
    expect(queriesAllowed(EPISODE_LANE)).toBe(false);
    expect(seedVideoAllowed(SEEDBANK.properties[0], EPISODE_LANE)).toBe(false);
  });

  it('sends the three fields and nothing the lane refuses', () => {
    expect(seedBody(form(), EPISODE_LANE)).toEqual({
      property_id: 'alpha',
      content_type: 'episode',
      text: 'Sample topic',
      episode_class: 'sample-check',
      sources: ['https://example.com/a'],
      target_minutes: 8,
      priority: 2,
    });
  });

  it('never sends the episode fields on another lane', () => {
    const body = seedBody(form(), lane({}));
    expect(body).not.toHaveProperty('episode_class');
    expect(body).not.toHaveProperty('sources');
    expect(body).not.toHaveProperty('target_minutes');
  });

  it('checks the class, sources and minutes', () => {
    expect(seedProblems(form(), EPISODE_LANE, null)).toEqual([]);
    const bad = seedProblems(form({ episode: { cls: '', sources: ['http://x'], minutes: 13 } }), EPISODE_LANE, null);
    expect(bad).toEqual(['Pick the episode class.', 'Each source starts https:// and is at most 500 characters.', 'Target minutes: a whole number 4–12.']);
    expect(seedProblems(form({ episode: { cls: 'x', sources: [], minutes: 8 } }), EPISODE_LANE, null)).toContain('Give 1–10 sources.');
    expect(parseSources(' a \n\n b ')).toEqual(['a', 'b']);
  });

  it('offers a thesis prompt as the operator-only class, its https links as sources', () => {
    expect(promptEpisodeClass(PROMPT, SEEDBANK)?.name).toBe('Sample Briefing');
    expect(promptEpisodeClass({ ...PROMPT, property_id: 'beta' }, SEEDBANK)).toBeNull();
    const draft = episodeDraftFromPrompt(PROMPT, SEEDBANK);
    expect(draft).toMatchObject({ lane: 'episode', episode_class: 'sample-briefing', sources: ['https://example.com/a'], source_prompt_id: PROMPT.id });
  });

  it('renders the episode fields with the operator-only badge', () => {
    const draft = episodeDraftFromPrompt(PROMPT, SEEDBANK)!;
    const html = renderToStaticMarkup(
      <SeedComposer seedbank={SEEDBANK} draft={draft} onQueue={async () => 'id'} onVerify={async () => ({ state: 'unchecked', reason: 'x' })} onClose={() => undefined} />,
    );
    expect(html).toContain('Episode class');
    expect(html).toContain('Sample Briefing (yours only)');
    expect(html).toContain('operator-only');
    expect(html).toContain('Target minutes');
    expect(html).toContain('value="8"');
    expect(html).toContain('https://example.com/a');
    expect(html).not.toContain('Target queries');
    expect(html).not.toContain('<span class="text-[10.5px] uppercase tracking-wide" style="color:var(--color-text-tertiary)">URL</span>');
  });

  it('puts a Seed as button on the thesis prompt', () => {
    const html = renderToStaticMarkup(
      <ThesisPrompts
        prompts={[PROMPT]}
        showProperty={false}
        onMark={() => undefined}
        onSeed={() => undefined}
        onSeedEpisode={() => undefined}
        episodeClassName={(t) => promptEpisodeClass(t, SEEDBANK)?.name ?? null}
      />,
    );
    expect(html).toContain('Seed as a Sample Briefing');
  });
});
