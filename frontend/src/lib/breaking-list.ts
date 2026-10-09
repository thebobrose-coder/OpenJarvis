import type { AlertKind, BreakingNewsAlert } from './api';

/**
 * The Latest News dock's breaking list (contract v1.7): the newest alert
 * plus up to two more from the last 24 h. Pure, so it tests without a DOM.
 */

export const LIST_HOURS = 24;
export const LIST_ROWS = 3;

/** A row without `kind` is `news`, or `trading` when `source` is `trading`. */
export function alertKind(a: Pick<BreakingNewsAlert, 'kind' | 'source'>): AlertKind {
  if (a.kind) return a.kind;
  return a.source === 'trading' ? 'trading' : 'news';
}

/**
 * Newest first, inside the window, one row per `event_id` (the newest: an
 * upgrade row replaces the one it upgrades), at most `rows`. `latest` is the
 * spoken alert from /api/breaking-news; its matching /recent row (same
 * `alerted_at`) lends it the v1.7 keys the root route doesn't carry.
 */
export function selectBreaking(
  latest: BreakingNewsAlert | null,
  recent: BreakingNewsAlert[],
  now: number,
  { hours = LIST_HOURS, rows = LIST_ROWS } = {},
): BreakingNewsAlert[] {
  const all = [...recent];
  if (latest) {
    const i = all.findIndex((a) => a.alerted_at === latest.alerted_at);
    if (i >= 0) all[i] = { ...all[i], ...latest };
    else all.push(latest);
  }
  const cutoff = now - hours * 3600_000;
  const seen = new Set<string>();
  return all
    .filter((a) => Date.parse(a.alerted_at) >= cutoff)
    .sort((a, b) => Date.parse(b.alerted_at) - Date.parse(a.alerted_at))
    .filter((a) => {
      const key = a.event_id ? `event:${a.event_id}` : `at:${a.alerted_at}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, rows);
}

export type LevelTone = 'error' | 'warning' | 'neutral';

/** PAGER/GDACS `red` and NWS `Extreme` read as error, `orange` as warning. */
export function levelTone(level: string | null | undefined): LevelTone {
  const l = (level ?? '').toLowerCase();
  if (l === 'red' || l === 'extreme') return 'error';
  if (l === 'orange') return 'warning';
  return 'neutral';
}

export const LEVEL_COLOR: Record<LevelTone, string> = {
  error: 'var(--color-error)',
  warning: 'var(--color-warning)',
  neutral: 'var(--color-text-tertiary)',
};

/** "now", "38 min", "5 h": the age after the source name ("USGS · 38 min"). */
export function alertAge(alertedAt: string, now: number): string {
  const min = Math.floor(Math.max(0, now - Date.parse(alertedAt)) / 60_000);
  if (min < 1) return 'now';
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h`;
}
