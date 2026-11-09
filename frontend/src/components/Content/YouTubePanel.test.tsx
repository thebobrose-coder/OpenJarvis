import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { YouTubePerformance, YouTubeVideo } from '../../lib/content-api';
import { groupItems, KIND_LABEL, linkFor } from '../../lib/waiting-api';
import { ALL_PROPERTIES } from './format';
import { isTokenError, recentVideos, YouTubePanel } from './YouTubePanel';

// Invented fixtures only: this repo is public.
const NOW = Date.parse('2026-01-30T12:00:00Z');
const META = { generated_at: '2026-01-30T11:52:00Z', age_seconds: 60, stale: false };

const video = (over: Partial<YouTubeVideo>): YouTubeVideo => ({
  video_id: 'vid-long-1',
  title: 'A sample episode',
  kind: 'long',
  kind_source: 'duration<=60s',
  published_at: '2026-01-25T16:00:00Z',
  duration_s: 311,
  views: 3,
  avg_view_duration_s: 238,
  avg_view_pct: 76.7,
  last_28d: { views: 2, avg_view_duration_s: 200, avg_view_pct: 70.5 },
  traffic_sources: null,
  ...over,
});

const FEED: YouTubePerformance = {
  ...META,
  run_at: '2026-01-30T11:52:00Z',
  quota: { used_today: 32, cap: 10000, stopped: false },
  channels: [
    {
      property: 'alpha',
      channel_title: 'Sample Channel',
      kind_rule: 'duration<=60s',
      videos: [
        video({}),
        video({ video_id: 'vid-short-1', title: 'A sample short', kind: 'short', duration_s: 58, episode_video_id: 'vid-long-1' }),
        video({ video_id: 'vid-short-2', title: 'A joined short', kind: 'short', duration_s: 55, episode_id: '01ABCDEFGHJKMNPQRSTVWXYZ00', beat: 3 }),
        video({ video_id: 'vid-old', title: 'An old upload', published_at: '2025-12-01T00:00:00Z' }),
      ],
    },
    { property: 'beta', channel_title: 'Other Channel', error: 'invalid_grant: token expired', videos: [] },
  ],
  spark: [{ flight: 'flight-a', rule: 'Shorts >= 72 h old with >= 50 views', candidates: [], reason: 'no candidate yet: 0 Shorts' }],
  not_available: ['viewed_vs_swiped (not in the YouTube Analytics API)'],
};

const render = (feed: YouTubePerformance | null, selectedProperty = ALL_PROPERTIES) =>
  renderToStaticMarkup(<YouTubePanel feed={feed} selectedProperty={selectedProperty} now={NOW} />);

describe('YouTubePanel', () => {
  it('splits the last 28 days into Shorts and long-form, newest first', () => {
    const { shorts, long } = recentVideos(FEED.channels[0], NOW);
    expect(long.map((v) => v.video_id)).toEqual(['vid-long-1']);
    expect(shorts.map((v) => v.video_id)).toEqual(['vid-short-1', 'vid-short-2']);
  });

  it('shows each video with views, average viewed and average duration from the 28-day window', () => {
    const html = render(FEED);
    expect(html).toContain('Long-form (1)');
    expect(html).toContain('Shorts (2)');
    expect(html).toContain('70.5 %');
    expect(html).toContain('3:20');
    expect(html).not.toContain('An old upload');
    expect(html).toContain('Short or long by: duration&lt;=60s');
  });

  it('links a Short to its full episode row, or names the studio episode and beat when joined', () => {
    const html = render(FEED);
    expect(html).toContain('id="yt-alpha-vid-long-1"');
    expect(html).toContain('data-episode-video="vid-long-1"');
    expect(html).toContain('episode 01ABCDEFGHJKMNPQRSTVWXYZ00 · beat 3');
  });

  it('shows a channel error in amber with the authorize hint for a token error', () => {
    const html = render(FEED);
    expect(html).toContain('invalid_grant: token expired');
    expect(html).toContain('re-run <code>authorize.py youtube beta</code>');
    expect(isTokenError('quotaExceeded')).toBe(false);
  });

  it('shows the spark reason without a pick, and the ranked candidates with the pick marked', () => {
    let html = render(FEED);
    expect(html).toContain('id="spark-flight-a"');
    expect(html).toContain('no candidate yet: 0 Shorts');
    expect(html).not.toContain('Google Ads');
    html = render({
      ...FEED,
      spark: [
        {
          flight: 'flight-a',
          candidates: [
            { video_id: 'c1', title: 'First', views: 80, avg_view_pct: 90 },
            { video_id: 'c2', title: 'Second', views: 60, avg_view_pct: 70 },
          ],
          pick: 'c1',
          reason: 'best retention',
        },
      ],
    });
    expect(html).toMatch(/data-candidate="c1".*>pick<\/span>/);
    expect(html).toContain('The swap is yours to make, in Google Ads.');
  });

  it('keeps the spark block when another property is selected, and the quota and not-available lines', () => {
    const html = render(FEED, 'beta');
    expect(html).not.toContain('Sample Channel');
    expect(html).toContain('data-spark="flight-a"');
    expect(html).toContain('API quota today: 32 / 10,000 units');
    expect(html).toContain('Not available from YouTube: viewed_vs_swiped');
  });

  it('renders before the first read', () => {
    expect(render(null)).toContain('No YouTube read yet.');
    expect(render({ ...FEED, channels: [], spark: [] })).toContain('No YouTube channel read');
  });
});

describe('v1.29 waiting kinds', () => {
  it('labels spend_cap and spark, follows the server link, and still renders an unknown kind', () => {
    expect(KIND_LABEL.spend_cap).toBe('Spend caps');
    expect(KIND_LABEL.spark).toBe('Spark swap (Google Ads)');
    const row = (kind: string, page: string, focus: string) => ({
      kind,
      id: focus,
      source_feed: 'x',
      scope: null,
      title: 'T',
      detail: null,
      created_at: null,
      due: null,
      priority: null,
      link: { page, focus },
      lane: 'act' as const,
    });
    expect(linkFor(row('spend_cap', '/commerce', 'spend-aws-total'))).toBe('/commerce?tab=ads&focus=spend-aws-total');
    const groups = groupItems({ items: [row('spark', '/content', 'spark-flight-a'), row('mystery', '/content', 'm')], counts: {} as never });
    expect(groups.map((g) => [g.kind, g.label])).toEqual([
      ['spark', 'Spark swap (Google Ads)'],
      ['mystery', 'mystery'],
    ]);
  });
});
