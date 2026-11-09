import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BOARD_COLUMNS, StudioView, columnOf } from './StudioView';
import { studioLine } from './summary';
import { linkFor } from '../../lib/waiting-api';
import type { EpisodeSummary, StudioStatus } from '../../lib/studio-api';
import { ALL_PROPERTIES } from '../Content/format';

const NOW = Date.parse('2026-11-09T12:00:00Z');
const noop = () => undefined;

// Neutral fixtures only.
const STATUS: StudioStatus = {
  generatedAt: '2026-11-09T11:55:00Z',
  paused: { alpha: false },
  lanes: [{ propertyId: 'alpha', queued: 3, inProduction: 2, published30d: 4, runwayDays: 9, queue: [], heldSeeds: [] }],
  inFlight: [],
  spend: { month: '2026-11', alpha: { usd: 3.5, capUsd: 20, gpuMinutes: 42 } },
  lastRun: { at: '2026-11-09T11:50:00Z', ok: true, advanced: 1 },
  published: { alpha: 4 },
  channels: { alpha: { channelName: 'Sample Channel', lanePerWeek: 1, cloudCapUsdPerEpisode: 2, cloudCapUsdPerMonth: 20, gpuMinutesCap: 30, firstUnlisted: 3, episodeClasses: [] } },
  age_seconds: 300,
  stale: false,
};

const ep = (id: string, stage: string, over: Partial<EpisodeSummary> = {}): EpisodeSummary => ({
  episodeId: id,
  propertyId: 'alpha',
  stage,
  since: '2026-11-09T10:00:00Z',
  updatedAt: null,
  title: `Episode ${id}`,
  topic: null,
  episodeClass: null,
  targetMinutes: null,
  gpuMinutes: null,
  spentUsd: null,
  durationSeconds: null,
  youtubeVisibility: null,
  postId: null,
  stoppedReason: null,
  stageNote: null,
  rewrites: 0,
  g0Pending: false,
  actionPending: null,
  seedHeld: false,
  ...over,
});

const EPISODES = [ep('01HZZZZZZZZZZZZZZZZZZZZZZ1', 'awaiting-g0'), ep('01HZZZZZZZZZZZZZZZZZZZZZZ2', 'narrating'), ep('01HZZZZZZZZZZZZZZZZZZZZZZ3', 'published')];

const render = (over: Partial<Parameters<typeof StudioView>[0]> = {}) =>
  renderToStaticMarkup(
    <StudioView
      status={STATUS}
      episodes={EPISODES}
      loading={false}
      error={null}
      now={NOW}
      selectedProperty={ALL_PROPERTIES}
      onSelectProperty={noop}
      onOpen={noop}
      onRun={noop}
      onPause={noop}
      {...over}
    />,
  );

describe('Phase 3: Studio page', () => {
  it('maps every stage to a board column', () => {
    const all = BOARD_COLUMNS.flatMap((c) => c.stages);
    expect(new Set(all).size).toBe(all.length);
    expect(columnOf('awaiting-g0')).toBe('g0');
    expect(columnOf('published')).toBe('done');
    expect(columnOf('something-new')).toBe('producing');
  });
  it('shows the run clock, one card per channel and the episodes by column', () => {
    const html = render();
    expect(html).toContain('Run studio now');
    expect(html).toContain('Last run 10 min ago, advanced 1');
    expect(html).toContain('Sample Channel');
    expect(html).toContain('data-property="alpha"');
    expect(html).toContain('$3.50 / $20.00');
    expect(html).toContain('data-column="g0"');
    expect(html).toContain('Review G0');
    expect(html).toContain('id="episode-01HZZZZZZZZZZZZZZZZZZZZZZ2"');
    expect(html).toContain('No YouTube read yet.');
  });
  it('says so before the studio exists', () => {
    expect(render({ status: null, loading: false, error: null })).toContain('No studio on this machine yet.');
  });
});

describe('Phase 3: the Content header line and the episode links', () => {
  it('sums production and takes the shortest runway', () => {
    expect(studioLine(STATUS, noop)?.text).toBe('2 in production · runway 9 d');
    expect(studioLine(null, noop)).toBeNull();
  });
  it('an episode row lands on /studio whatever page the feed names', () => {
    expect(linkFor({ link: { page: '/content', focus: '01HZZZZZZZZZZZZZZZZZZZZZZ1' } })).toBe('/studio?focus=01HZZZZZZZZZZZZZZZZZZZZZZ1');
    expect(linkFor({ link: { page: '/content', focus: 'prop-1' } })).toBe('/content?focus=prop-1');
  });
});
