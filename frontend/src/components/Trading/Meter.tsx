import type { ReactNode } from 'react';

/**
 * A thin meter: a value against a limit, as a 4px track with a rounded fill
 * and a tick at the limit. The value and the limit are written beside it in
 * text tokens, so the bar is never the only carrier (dataviz: thin marks,
 * text wears text tokens). `tone` follows the status palette.
 */
export function Meter({
  value,
  limit,
  label,
  detail,
  tone = 'accent',
  testId,
}: {
  value: number | null;
  limit: number;
  label: ReactNode;
  detail?: ReactNode;
  tone?: 'accent' | 'warning' | 'error' | 'success';
  testId?: string;
}) {
  const ratio = value == null || limit <= 0 ? 0 : Math.max(0, Math.min(1, value / limit));
  const color =
    tone === 'error'
      ? 'var(--color-error)'
      : tone === 'warning'
        ? 'var(--color-warning)'
        : tone === 'success'
          ? 'var(--color-success)'
          : 'var(--color-accent)';
  return (
    <div className="flex flex-col gap-1" data-meter={testId} data-meter-ratio={ratio.toFixed(3)} data-meter-tone={tone}>
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span style={{ color: 'var(--color-text-secondary)' }}>{label}</span>
        {detail && (
          <span className="tabular-nums" style={{ color: 'var(--color-text-tertiary)' }}>
            {detail}
          </span>
        )}
      </div>
      <div
        className="relative h-1 w-full rounded-full"
        style={{ background: 'var(--color-bg-tertiary)' }}
        role="meter"
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={value ?? undefined}
      >
        <div className="h-1 rounded-full" style={{ width: `${ratio * 100}%`, background: color, minWidth: ratio > 0 ? 4 : 0 }} />
        <div
          className="absolute -top-0.5 h-2 w-px"
          style={{ right: 0, background: 'var(--color-text-tertiary)' }}
          aria-hidden
        />
      </div>
    </div>
  );
}
