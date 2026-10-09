/**
 * "Updated N ago" line for panels backed by a Hermes feed (Store
 * Performance, Daily Brief, Culture & Sports, Commerce). When the bridge is
 * down the route serves its last good copy with `stale: true`, shown as an
 * amber tag. `staleAfterSeconds` also turns the line amber once the feed is
 * older than its schedule allows (e.g. a daily feed past 26 h).
 *
 * `ageSeconds` is the age when the prop arrived; the line keeps counting
 * from there (re-rendering once a minute), so a copy fetched hours ago and
 * never refreshed doesn't keep reading "Updated 5 min ago".
 */

import { useEffect, useState } from 'react';

const TICK_MS = 60_000;

/** `staleAfterSeconds` for the once-a-day digests: a missed 06:00 run reads amber. */
export const DAILY_LATE_AFTER_S = 26 * 3600;

export function formatAge(seconds: number): string {
  const min = Math.floor(seconds / 60);
  if (min < 1) return 'just now';
  if (min < 120) return `${min} min ago`;
  return `${Math.floor(min / 60)} h ago`;
}

/** Age now, given the age it had at `receivedAt` (both clocks in ms). */
export function liveAgeSeconds(ageSeconds: number, receivedAt: number, now: number): number {
  return ageSeconds + Math.max(0, now - receivedAt) / 1000;
}

type FeedFreshnessProps = {
  ageSeconds?: number | null;
  stale?: boolean;
  staleTitle?: string;
  staleAfterSeconds?: number;
  /** Prefix naming the feed, for pages that show several ("Data"). */
  label?: string;
  className?: string;
};

export function FeedFreshness(props: FeedFreshnessProps) {
  const { ageSeconds } = props;
  const [received, setReceived] = useState(() => ({ age: ageSeconds, at: Date.now() }));
  if (received.age !== ageSeconds) setReceived({ age: ageSeconds, at: Date.now() });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);
  const age = ageSeconds == null ? ageSeconds : liveAgeSeconds(ageSeconds, received.at, now);
  return <FeedFreshnessView {...props} ageSeconds={age} />;
}

export function FeedFreshnessView({
  ageSeconds,
  stale,
  staleTitle = 'Hermes is unreachable -- showing the last good copy.',
  staleAfterSeconds,
  label,
  className = '',
}: FeedFreshnessProps) {
  if (ageSeconds == null) return null;
  const late = staleAfterSeconds != null && ageSeconds > staleAfterSeconds;
  return (
    <div
      className={`flex items-center gap-2 text-[11px] ${className}`}
      style={{ color: stale || late ? 'var(--color-warning)' : 'var(--color-text-tertiary)' }}
      title={late ? 'Older than this feed’s schedule -- a run may have been missed.' : undefined}
    >
      <span>
        {label ? `${label} · updated` : 'Updated'} {formatAge(ageSeconds)}
      </span>
      {stale && (
        <span
          className="px-1.5 py-0.5 rounded font-semibold uppercase tracking-wide text-[10px]"
          style={{ color: 'var(--color-warning)', border: '1px solid var(--color-warning)' }}
          title={staleTitle}
        >
          stale
        </span>
      )}
    </div>
  );
}
