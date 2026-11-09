import type { ComponentType, ReactNode } from 'react';
import { Loader2, RefreshCw, RotateCw } from 'lucide-react';

export type PanelSize = 'hero' | 'tall' | 'third' | 'trio' | 'half' | 'wide' | 'quarter' | 'sixth' | 'full';

/** A row's height (widescreen plan, Phase 0): panels in a banded row scroll inside
 * instead of growing the row. short = 420 px, tall = two shorts plus the gap. */
export type PanelBand = 'short' | 'tall';

/* Spans at lg (today's layout) and at 3xl, the operator's 2560 px viewport, where a
 * third is 735 px: wider than today's half. */
const SIZE_CLASSES: Record<PanelSize, string> = {
  hero: 'col-span-12 lg:col-span-5 3xl:col-span-4',
  tall: 'col-span-12 md:col-span-6 lg:col-span-4',
  third: 'col-span-12 sm:col-span-6 lg:col-span-4',
  /** A row of exactly three: stacked, then three across, never 2 + 1. */
  trio: 'col-span-12 lg:col-span-4',
  half: 'col-span-12 lg:col-span-6',
  wide: 'col-span-12 lg:col-span-8',
  quarter: 'col-span-6 lg:col-span-3',
  sixth: 'col-span-6 lg:col-span-3 3xl:col-span-2',
  full: 'col-span-12',
};

const BAND_CLASSES: Record<PanelBand, string> = {
  short: 'lg:h-[420px]',
  tall: 'lg:h-[860px]',
};

interface DashboardPanelProps {
  icon: ComponentType<{ size?: number; style?: React.CSSProperties }>;
  title: string;
  /** Small right-aligned label, e.g. "15 min" or "Live". */
  tag?: string;
  loading?: boolean;
  error?: string | null;
  onRegenerate?: () => void;
  /** 'regenerate' asks Hermes to rebuild (a flag file); 'reload' only re-fetches here. */
  regenerateKind?: 'regenerate' | 'reload';
  regenerating?: boolean;
  size?: PanelSize;
  /** The row's height band; the body scrolls inside it. */
  band?: PanelBand;
  /** Demoted styling for the existing energy/cost/trace panels. */
  dim?: boolean;
  /** Subtle accent border for the new priority briefing panels. */
  priority?: boolean;
  onTitleClick?: () => void;
  /** Extra header controls, e.g. a speaker button. */
  actions?: ReactNode;
  /** A second header row, e.g. a Segmented for tabs inside the panel. */
  headerExtra?: ReactNode;
  /** The header icon's colour, when the panel stands for one series (a
   * trading sleeve); the accent otherwise. */
  iconColor?: string;
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
  regenerateKind = 'regenerate',
  regenerating,
  size = 'third',
  band,
  dim,
  priority,
  onTitleClick,
  actions,
  headerExtra,
  iconColor,
  children,
}: DashboardPanelProps) {
  return (
    <div
      className={`flex flex-col gap-3 rounded-xl p-4 ${SIZE_CLASSES[size]} ${band ? `${BAND_CLASSES[band]} min-h-0` : ''}`.trim()}
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
          <Icon size={14} style={{ color: iconColor ?? 'var(--color-accent)', flexShrink: 0 }} />
          <span
            className="text-ui-13 font-semibold truncate text-left"
            style={{ color: 'var(--color-text)' }}
          >
            {title}
          </span>
        </button>
        <div className="flex items-center gap-2 shrink-0">
          {actions}
          {tag && (
            <span className="text-ui-10 uppercase tracking-wide" style={{ color: 'var(--color-text-tertiary)' }}>
              {tag}
            </span>
          )}
          {onRegenerate && (
            <button
              onClick={onRegenerate}
              disabled={regenerating}
              className="flex items-center justify-center w-6 h-6 rounded-md transition-colors cursor-pointer disabled:opacity-50"
              style={{ color: 'var(--color-text-secondary)', background: 'var(--color-bg-secondary)' }}
              title={regenerateKind === 'reload' ? 'Reload' : 'Regenerate'}
            >
              {regenerateKind === 'reload' ? (
                <RotateCw size={11} className={regenerating ? 'animate-spin' : ''} />
              ) : (
                <RefreshCw size={11} className={regenerating ? 'animate-spin' : ''} />
              )}
            </button>
          )}
        </div>
      </div>

      {headerExtra && <div className="shrink-0">{headerExtra}</div>}

      <div className={`flex-1 min-h-0 text-ui-12-5 ${band ? 'overflow-y-auto pr-1' : ''}`.trim()} style={{ color: 'var(--color-text-secondary)' }}>
        {loading ? (
          <div className="flex items-center justify-center py-6" style={{ color: 'var(--color-text-tertiary)' }}>
            <Loader2 size={16} className="animate-spin" />
          </div>
        ) : error ? (
          <div className="line-clamp-3 break-words" style={{ color: 'var(--color-error)' }} title={error}>{error}</div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}
