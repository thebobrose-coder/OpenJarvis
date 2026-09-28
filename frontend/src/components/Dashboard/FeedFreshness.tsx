/**
 * "Updated N ago" line for panels backed by a Hermes feed (Store
 * Performance, Daily Brief, Culture & Sports). When the bridge is down the
 * route serves its last good copy with `stale: true`, shown as an amber tag.
 */

export function formatAge(seconds: number): string {
  const min = Math.floor(seconds / 60);
  if (min < 1) return 'just now';
  if (min < 120) return `${min} min ago`;
  return `${Math.floor(min / 60)} h ago`;
}

export function FeedFreshness({
  ageSeconds,
  stale,
  staleTitle = 'Hermes is unreachable -- showing the last good copy.',
  className = '',
}: {
  ageSeconds?: number | null;
  stale?: boolean;
  staleTitle?: string;
  className?: string;
}) {
  if (ageSeconds == null) return null;
  return (
    <div
      className={`flex items-center gap-2 text-[11px] ${className}`}
      style={{ color: stale ? 'var(--color-warning)' : 'var(--color-text-tertiary)' }}
    >
      <span>Updated {formatAge(ageSeconds)}</span>
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
