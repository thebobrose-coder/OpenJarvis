import { MonitorPlay } from 'lucide-react';
import type { Spark, YouTubeChannel, YouTubePerformance, YouTubeVideo } from '../../lib/content-api';
import { DashboardPanel } from '../Dashboard/DashboardPanel';
import { Chip, ExtLink, Quiet } from '../shared/ui';
import { ALL_PROPERTIES } from './format';

/**
 * YouTube performance, read-only (contract v1.29 §4.9, hq 0028 Part 3): per
 * channel, the last 28 days' uploads with Shorts and long-form apart, and the
 * spark pick for a flight. A panel read only: no desk turn reads this feed
 * (0028 A2.3), and nothing here writes. The swap a spark pick recommends is
 * the operator's, in Google Ads.
 */

export const WINDOW_DAYS = 28;
const DAY_MS = 86_400_000;

const watchUrl = (id: string) => `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;

export function fmtSeconds(s: number | null | undefined): string {
  if (s == null) return '—';
  const n = Math.round(s);
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}

const fmtPct = (n: number | null | undefined) => (n == null ? '—' : `${n.toFixed(1)} %`);
const fmtNum = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString());

/** The channel's uploads of the last 28 days, newest first, split by kind. */
export function recentVideos(ch: Pick<YouTubeChannel, 'videos'>, now: number) {
  const since = now - WINDOW_DAYS * DAY_MS;
  const recent = (ch.videos ?? [])
    .filter((v) => {
      const t = Date.parse(v.published_at);
      return Number.isNaN(t) || t >= since;
    })
    .sort((a, b) => b.published_at.localeCompare(a.published_at));
  return { shorts: recent.filter((v) => v.kind === 'short'), long: recent.filter((v) => v.kind !== 'short') };
}

/** An error about the channel's OAuth grant: the operator re-runs the authorize step. */
export const isTokenError = (e: string) => /token|grant|auth|credential|401|403|scope|WRONG CHANNEL/i.test(e);

/** A video's figures: the 28-day window when Hermes sends it, else lifetime. */
const figures = (v: YouTubeVideo) => v.last_28d ?? { views: v.views, avg_view_pct: v.avg_view_pct, avg_view_duration_s: v.avg_view_duration_s };

const rowId = (property: string, videoId: string) => `yt-${property}-${videoId}`;

function goTo(id: string) {
  const el = typeof document === 'undefined' ? null : document.getElementById(id);
  el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function VideoRows({ property, videos, label }: { property: string; videos: YouTubeVideo[]; label: string }) {
  return (
    <div className="flex flex-col gap-1" data-kind-group={label}>
      <span className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--color-text-tertiary)' }}>
        {label} ({videos.length})
      </span>
      {videos.length === 0 ? (
        <Quiet>None in the last {WINDOW_DAYS} days.</Quiet>
      ) : (
        <table className="w-full text-[12px] tabular-nums">
          <thead>
            <tr className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--color-text-tertiary)' }}>
              <th className="py-1 px-2 text-left font-normal">Video</th>
              <th className="py-1 px-2 text-right font-normal">Views</th>
              <th className="py-1 px-2 text-right font-normal">Avg viewed</th>
              <th className="py-1 px-2 text-right font-normal">Avg duration</th>
            </tr>
          </thead>
          <tbody>
            {videos.map((v, i) => {
              const f = figures(v);
              return (
                <tr key={v.video_id} id={rowId(property, v.video_id)} style={{ borderTop: i ? '1px solid var(--color-border)' : undefined }} data-video={v.video_id}>
                  <td className="py-1 px-2 min-w-0">
                    <span className="flex flex-col gap-0.5">
                      <span style={{ color: 'var(--color-accent)' }}>
                        <ExtLink url={watchUrl(v.video_id)}>{v.title || v.video_id}</ExtLink>
                      </span>
                      <span className="flex flex-wrap items-center gap-1.5 text-[10.5px]" style={{ color: 'var(--color-text-tertiary)' }}>
                        {v.published_at.slice(0, 10)}
                        {v.duration_s != null && <span>{fmtSeconds(v.duration_s)}</span>}
                        {v.episode_id ? (
                          <span data-episode-id>
                            episode {v.episode_id}
                            {v.beat != null ? ` · beat ${v.beat}` : ''}
                          </span>
                        ) : v.episode_video_id ? (
                          <button
                            onClick={() => goTo(rowId(property, v.episode_video_id as string))}
                            className="cursor-pointer hover:underline"
                            style={{ background: 'transparent', border: 'none', padding: 0, color: 'var(--color-accent)', font: 'inherit' }}
                            data-episode-video={v.episode_video_id}
                          >
                            full episode
                          </button>
                        ) : null}
                      </span>
                    </span>
                  </td>
                  <td className="py-1 px-2 text-right">{fmtNum(f.views)}</td>
                  <td className="py-1 px-2 text-right">{fmtPct(f.avg_view_pct)}</td>
                  <td className="py-1 px-2 text-right">{fmtSeconds(f.avg_view_duration_s)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ChannelCard({ ch, now }: { ch: YouTubeChannel; now: number }) {
  const { shorts, long } = recentVideos(ch, now);
  return (
    <div className="flex flex-col gap-2 rounded-lg p-3 min-w-0" style={{ background: 'var(--color-bg-secondary)' }} data-channel={ch.property}>
      <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
        <span className="font-medium" style={{ color: 'var(--color-text)' }}>
          {ch.channel_title || ch.property}
        </span>
        <Chip tone="accent">{ch.property}</Chip>
      </div>
      {ch.error && (
        <p className="text-[11.5px]" style={{ color: 'var(--color-warning)' }} data-channel-error>
          {ch.error}
          {isTokenError(ch.error) && (
            <>
              {' '}
              (re-run <code>authorize.py youtube {ch.property}</code>)
            </>
          )}
        </p>
      )}
      <VideoRows property={ch.property} videos={long} label="Long-form" />
      <VideoRows property={ch.property} videos={shorts} label="Shorts" />
      {ch.kind_rule && (
        <span className="text-[10.5px]" style={{ color: 'var(--color-text-tertiary)' }} data-kind-rule>
          Short or long by: {ch.kind_rule}
        </span>
      )}
    </div>
  );
}

/** One flight's spark: candidates ranked, the pick marked; the swap is the operator's. */
export function SparkBlock({ spark }: { spark: Spark }) {
  return (
    <div id={`spark-${spark.flight}`} className="flex flex-col gap-1.5 rounded-lg p-3" style={{ border: '1px solid var(--color-border)' }} data-spark={spark.flight}>
      <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
        <span className="font-medium" style={{ color: 'var(--color-text)' }}>
          Spark: {spark.flight}
        </span>
        {spark.pick ? <Chip tone="success">pick ready</Chip> : <Chip tone="muted">no pick</Chip>}
      </div>
      {spark.rule && (
        <span className="text-[10.5px]" style={{ color: 'var(--color-text-tertiary)' }}>
          {spark.rule}
        </span>
      )}
      {spark.candidates.length > 0 && (
        <ol className="flex flex-col gap-1 text-[12px] tabular-nums">
          {spark.candidates.map((c, i) => (
            <li key={c.video_id} className="flex flex-wrap items-center gap-1.5" data-candidate={c.video_id}>
              <span style={{ color: 'var(--color-text-tertiary)' }}>{i + 1}.</span>
              <span style={{ color: 'var(--color-accent)' }}>
                <ExtLink url={watchUrl(c.video_id)}>{c.title || c.video_id}</ExtLink>
              </span>
              {c.video_id === spark.pick && <Chip tone="success">pick</Chip>}
              <span style={{ color: 'var(--color-text-tertiary)' }}>
                {fmtNum(c.views)} views · {fmtPct(c.avg_view_pct)} viewed
              </span>
            </li>
          ))}
        </ol>
      )}
      <span className="text-[11.5px]" style={{ color: 'var(--color-text-secondary)' }}>
        {spark.reason}
      </span>
      {spark.pick && (
        <span className="text-[11.5px]" style={{ color: 'var(--color-text)' }}>
          The swap is yours to make, in Google Ads.
        </span>
      )}
    </div>
  );
}

export interface YouTubePanelProps {
  feed: YouTubePerformance | null;
  selectedProperty: string;
  now: number;
  loading?: boolean;
  error?: string | null;
}

export function YouTubePanel({ feed, selectedProperty, now, loading, error }: YouTubePanelProps) {
  const channels = (feed?.channels ?? []).filter((c) => selectedProperty === ALL_PROPERTIES || c.property === selectedProperty);
  const quota = feed?.quota;
  return (
    <DashboardPanel icon={MonitorPlay} title="YouTube, last 28 days" tag="read only" size="full" loading={loading && !feed} error={error}>
      <div className="flex flex-col gap-3">
        {!feed ? (
          <Quiet>No YouTube read yet.</Quiet>
        ) : channels.length === 0 ? (
          <Quiet>No YouTube channel read for this property.</Quiet>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {channels.map((c) => (
              <ChannelCard key={c.property} ch={c} now={now} />
            ))}
          </div>
        )}
        {/* The spark block shows whatever the property filter: a waiting row links to it. */}
        {(feed?.spark ?? []).map((s) => (
          <SparkBlock key={s.flight} spark={s} />
        ))}
        {(feed?.not_available ?? []).length > 0 && (
          <Quiet>Not available from YouTube: {(feed?.not_available ?? []).join('; ')}.</Quiet>
        )}
        {quota && (
          <span className="text-[10.5px] tabular-nums" style={{ color: quota.stopped ? 'var(--color-warning)' : 'var(--color-text-tertiary)' }} data-quota>
            API quota today: {fmtNum(quota.used_today)} / {fmtNum(quota.cap)} units{quota.stopped ? ' (stopped for the rest of the Pacific day)' : ''}
          </span>
        )}
      </div>
    </DashboardPanel>
  );
}
