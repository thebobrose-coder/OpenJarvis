import { useEffect, useState } from 'react';
import { ageWords, formatAge } from '../../lib/age';
import { liveAgeSeconds } from './FeedFreshness';

export interface FeedAge {
  /** The feed as the operator knows it: "Products", "SEO audit". */
  label: string;
  ageSeconds?: number | null;
  stale?: boolean;
  /** Older than this reads as late (a missed run). */
  staleAfterSeconds?: number;
}

const TICK_MS = 60_000;

/**
 * One freshness line for a page header (widescreen plan, Phase 0): the newest and
 * oldest feed ages and how many are stale or late, with the per-feed list on hover.
 * Replaces a `FeedFreshness` string in every panel; panels keep only the stale tag.
 */
export function FeedFreshnessLine({ feeds, className = '' }: { feeds: FeedAge[]; className?: string }) {
  const [receivedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);
  const live = feeds
    .filter((f) => f.ageSeconds != null)
    .map((f) => ({ ...f, age: liveAgeSeconds(f.ageSeconds as number, receivedAt, now) }));
  return <FeedFreshnessLineView feeds={live} className={className} />;
}

export function FeedFreshnessLineView({
  feeds,
  className = '',
}: {
  feeds: (FeedAge & { age: number })[];
  className?: string;
}) {
  if (feeds.length === 0) return null;
  const newest = Math.min(...feeds.map((f) => f.age));
  const oldest = Math.max(...feeds.map((f) => f.age));
  const stale = feeds.filter((f) => f.stale).length;
  const late = feeds.filter((f) => f.staleAfterSeconds != null && f.age > f.staleAfterSeconds).length;
  const warn = stale + late > 0;
  const title = feeds
    .map((f) => `${f.label}: ${formatAge(f.age)}${f.stale ? ' (stale)' : ''}`)
    .join('\n');
  return (
    <div
      className={`flex items-center gap-2 text-ui-11 ${className}`.trim()}
      style={{ color: warn ? 'var(--color-warning)' : 'var(--color-text-tertiary)' }}
      title={title}
    >
      <span>
        Updated {formatAge(newest)}
        {feeds.length > 1 && oldest - newest >= 60 && ` · oldest ${ageWords(oldest)}`}
      </span>
      {stale > 0 && (
        <span
          className="px-1.5 py-0.5 rounded font-semibold uppercase tracking-wide text-ui-10"
          style={{ color: 'var(--color-warning)', border: '1px solid var(--color-warning)' }}
          title="Hermes is unreachable for these feeds -- showing the last good copy."
        >
          {stale} stale
        </span>
      )}
      {late > 0 && (
        <span className="text-ui-10 uppercase tracking-wide" title="Older than the feed's schedule -- a run may have been missed.">
          {late} late
        </span>
      )}
    </div>
  );
}
