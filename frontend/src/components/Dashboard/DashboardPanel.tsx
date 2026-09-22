import type { ComponentType, ReactNode } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';

export type PanelSize = 'hero' | 'tall' | 'third' | 'half' | 'wide' | 'quarter' | 'full';

const SIZE_CLASSES: Record<PanelSize, string> = {
  hero: 'col-span-12 lg:col-span-5',
  tall: 'col-span-12 md:col-span-6 lg:col-span-4',
  third: 'col-span-12 sm:col-span-6 lg:col-span-4',
  half: 'col-span-12 lg:col-span-6',
  wide: 'col-span-12 lg:col-span-8',
  quarter: 'col-span-6 lg:col-span-3',
  full: 'col-span-12',
};

interface DashboardPanelProps {
  icon: ComponentType<{ size?: number; style?: React.CSSProperties }>;
  title: string;
  /** Small right-aligned label, e.g. "15 min" or "Live". */
  tag?: string;
  loading?: boolean;
  error?: string | null;
  onRegenerate?: () => void;
  regenerating?: boolean;
  size?: PanelSize;
  /** Demoted styling for the existing energy/cost/trace panels. */
  dim?: boolean;
  /** Subtle accent border for the new priority briefing panels. */
  priority?: boolean;
  onTitleClick?: () => void;
  children: ReactNode;
}

/**
 * Shared chrome for every dashboard panel -- the single place that owns
 * border/radius/padding/header layout, so every panel (new briefing panels,
 * the existing energy/cost/trace panels once wrapped) reads as one
 * consistent system instead of each being styled independently.
 */
export function DashboardPanel({
  icon: Icon,
  title,
  tag,
  loading,
  error,
  onRegenerate,
  regenerating,
  size = 'third',
  dim,
  priority,
  onTitleClick,
  children,
}: DashboardPanelProps) {
  return (
    <div
      className={`flex flex-col gap-3 rounded-xl p-4 ${SIZE_CLASSES[size]}`}
      style={{
        background: 'var(--color-surface)',
        border: `1px solid ${priority ? 'var(--color-accent-subtle)' : 'var(--color-border)'}`,
        opacity: dim ? 0.82 : 1,
      }}
    >
      <div className="flex items-center justify-between gap-2 shrink-0">
        <button
          onClick={onTitleClick}
          disabled={!onTitleClick}
          className="flex items-center gap-2 min-w-0"
          style={{ cursor: onTitleClick ? 'pointer' : 'default', background: 'transparent', border: 'none', padding: 0 }}
        >
          <Icon size={14} style={{ color: 'var(--color-accent)', flexShrink: 0 }} />
          <span
            className="text-[13px] font-semibold truncate text-left"
            style={{ color: 'var(--color-text)' }}
          >
            {title}
          </span>
        </button>
        <div className="flex items-center gap-2 shrink-0">
          {tag && (
            <span className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--color-text-tertiary)' }}>
              {tag}
            </span>
          )}
          {onRegenerate && (
            <button
              onClick={onRegenerate}
              disabled={regenerating}
              className="flex items-center justify-center w-6 h-6 rounded-md transition-colors cursor-pointer disabled:opacity-50"
              style={{ color: 'var(--color-text-secondary)', background: 'var(--color-bg-secondary)' }}
              title="Regenerate"
            >
              <RefreshCw size={11} className={regenerating ? 'animate-spin' : ''} />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 text-[12.5px]" style={{ color: 'var(--color-text-secondary)' }}>
        {loading ? (
          <div className="flex items-center justify-center py-6" style={{ color: 'var(--color-text-tertiary)' }}>
            <Loader2 size={16} className="animate-spin" />
          </div>
        ) : error ? (
          <div style={{ color: 'var(--color-error)' }}>{error}</div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}
