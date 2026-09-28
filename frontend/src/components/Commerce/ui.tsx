/**
 * Small building blocks shared by every Commerce section, so chips, tiles,
 * links and filters look the same everywhere on the page (and match the
 * Dashboard, whose DashboardPanel chrome every section uses).
 */
import type { ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import { openExternal } from '../../lib/open-external';

export type Tone = 'neutral' | 'accent' | 'warning' | 'error' | 'success' | 'muted';

const TONE: Record<Tone, { color: string; background: string; border: string }> = {
  neutral: { color: 'var(--color-text-secondary)', background: 'var(--color-bg-secondary)', border: 'var(--color-border)' },
  accent: { color: 'var(--color-accent)', background: 'var(--color-accent-subtle)', border: 'transparent' },
  warning: { color: 'var(--color-warning)', background: 'transparent', border: 'var(--color-warning)' },
  error: { color: 'var(--color-error)', background: 'transparent', border: 'var(--color-error)' },
  success: { color: 'var(--color-success)', background: 'transparent', border: 'var(--color-success)' },
  muted: { color: 'var(--color-text-tertiary)', background: 'var(--color-bg-secondary)', border: 'transparent' },
};

export function Chip({ tone = 'neutral', title, children }: { tone?: Tone; title?: string; children: ReactNode }) {
  const t = TONE[tone];
  return (
    <span
      className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium whitespace-nowrap"
      style={{ color: t.color, background: t.background, border: `1px solid ${t.border}` }}
      title={title}
    >
      {children}
    </span>
  );
}

/** A metric: label on top, value, optional muted sub-line. Zeros stay calm. */
export function Tile({ label, value, sub, subTone }: { label: string; value: ReactNode; sub?: ReactNode; subTone?: Tone }) {
  return (
    <div
      className="flex flex-col gap-0.5 rounded-lg px-3 py-2 min-w-0"
      style={{ background: 'var(--color-bg-secondary)' }}
    >
      <span className="text-[10px] uppercase tracking-wide truncate" style={{ color: 'var(--color-text-tertiary)' }}>
        {label}
      </span>
      <span className="text-[15px] font-semibold tabular-nums truncate" style={{ color: 'var(--color-text)' }}>
        {value}
      </span>
      {sub != null && (
        <span className="text-[11px] tabular-nums truncate" style={{ color: TONE[subTone ?? 'muted'].color }}>
          {sub}
        </span>
      )}
    </div>
  );
}

/** One muted line: "no data yet", "not connected", and similar. */
export function Quiet({ children }: { children: ReactNode }) {
  return <p className="text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>{children}</p>;
}

export function ExtLink({ url, title, children }: { url?: string | null; title?: string; children: ReactNode }) {
  if (!url) return <>{children}</>;
  return (
    <button
      onClick={() => void openExternal(url)}
      className="text-left cursor-pointer hover:underline"
      style={{ background: 'transparent', border: 'none', padding: 0, color: 'inherit', font: 'inherit' }}
      title={title ?? url}
    >
      {children}
    </button>
  );
}

export function ExtIcon({ url, title }: { url?: string | null; title: string }) {
  if (!url) return null;
  return (
    <button
      onClick={() => void openExternal(url)}
      className="inline-flex items-center justify-center w-5 h-5 rounded-md cursor-pointer shrink-0"
      style={{ background: 'var(--color-bg-secondary)', color: 'var(--color-text-secondary)', border: 'none' }}
      title={title}
      aria-label={title}
    >
      <ExternalLink size={11} />
    </button>
  );
}

export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="rounded-md px-1.5 py-1 text-[11.5px] cursor-pointer"
        style={{ background: 'var(--color-bg-secondary)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Segmented buttons, e.g. the store switcher and the briefing tabs. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="inline-flex flex-wrap gap-1 rounded-lg p-1"
      style={{ background: 'var(--color-bg-secondary)' }}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.value)}
            className="px-2.5 py-1 rounded-md text-[12px] cursor-pointer transition-colors"
            style={{
              background: active ? 'var(--color-surface)' : 'transparent',
              color: active ? 'var(--color-text)' : 'var(--color-text-secondary)',
              border: active ? '1px solid var(--color-border)' : '1px solid transparent',
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function SmallButton({
  onClick,
  disabled,
  tone = 'neutral',
  title,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  tone?: Tone;
  title?: string;
  children: ReactNode;
}) {
  const t = TONE[tone];
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11.5px] cursor-pointer disabled:opacity-50 disabled:cursor-default"
      style={{ color: t.color, background: t.background, border: `1px solid ${t.border}` }}
    >
      {children}
    </button>
  );
}
