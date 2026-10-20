import { useState } from 'react';
import { useStackHealth } from '../../hooks/useStackHealth';
import { ALL_CLEAR, NO_RUN, clock, stripLines, type StackHealth, type StackLevel } from '../../lib/stack-api';
import { formatAge } from '../Dashboard/FeedFreshness';
import { StackHealthDrawer } from './StackHealthDrawer';

const TINT: Record<'fail' | 'warn', { color: string; background: string; border: string }> = {
  fail: {
    color: 'var(--color-error)',
    background: 'color-mix(in srgb, var(--color-error) 12%, transparent)',
    border: 'color-mix(in srgb, var(--color-error) 45%, transparent)',
  },
  warn: {
    color: 'var(--color-warning)',
    background: 'color-mix(in srgb, var(--color-warning) 12%, transparent)',
    border: 'color-mix(in srgb, var(--color-warning) 45%, transparent)',
  },
};

function MutedLine({ children, title }: { children: string; title?: string }) {
  return (
    <div className="mx-3 mb-1 px-3 py-1 text-[12px] shrink-0 truncate" style={{ color: 'var(--color-text-tertiary)' }} title={title}>
      {children}
    </div>
  );
}

export interface StackHealthDockViewProps {
  health: StackHealth | null;
  level: StackLevel;
  age: number | null;
  noticeOnly: boolean;
  missing: boolean;
  error: string | null;
  pulse: boolean;
  onOpen: () => void;
}

/**
 * The stack-health dock (hq 0017 A2): nearly invisible when green -- one
 * muted line with a small dot -- and a tinted two-line strip that opens the
 * drawer when something is wrong. Cloud notices alone keep the green line
 * and add an amber note. It never blocks the sidebar: a fetch error is a
 * muted line with the detail in its title.
 */
export function StackHealthDockView({ health, level, age, noticeOnly, missing, error, pulse, onOpen }: StackHealthDockViewProps) {
  if (!health) {
    if (missing) return <MutedLine>{NO_RUN}</MutedLine>;
    if (error) return <MutedLine title={error}>Stack health unavailable</MutedLine>;
    return null;
  }

  if (level === 'ok' || noticeOnly) {
    const notices = health.cloud_events.length;
    return (
      <div
        className="mx-3 mb-1 px-3 py-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] shrink-0 min-w-0"
        style={{ color: 'var(--color-text-tertiary)' }}
        data-stack-level={level}
      >
        <span className="flex items-center gap-2 min-w-0">
          <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: 'var(--color-success)' }} />
          <button
            type="button"
            onClick={onOpen}
            className="text-left cursor-pointer"
            style={{ background: 'transparent', border: 'none', padding: 0, color: 'inherit' }}
            title={`Stack health · last run ${clock(health.ran_at)}`}
          >
            {ALL_CLEAR}
          </button>
        </span>
        {/* Wraps under the sentence when the sidebar is narrow, never truncating it. */}
        <span className="shrink-0 tabular-nums text-[11px] pl-3.5">
          {clock(health.ran_at)}
          {age != null ? ` · ${formatAge(age)}` : ''}
        </span>
        {noticeOnly && (
          <button
            type="button"
            onClick={onOpen}
            className="shrink-0 cursor-pointer"
            style={{ background: 'transparent', border: 'none', padding: 0, color: 'var(--color-warning)' }}
          >
            {notices} cloud notice{notices === 1 ? '' : 's'}
          </button>
        )}
      </div>
    );
  }

  const tint = TINT[level === 'fail' ? 'fail' : 'warn'];
  const [first, second] = stripLines(health, age);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-live="polite"
      data-stack-level={level}
      className={`mx-3 mb-1 px-3 py-1.5 flex flex-col items-start gap-0.5 rounded-lg text-left text-[12px] shrink-0 min-w-0 cursor-pointer${pulse ? ' animate-pulse' : ''}`}
      style={{ background: tint.background, border: `1px solid ${tint.border}`, color: tint.color, width: 'calc(100% - 1.5rem)' }}
      title="Open stack health"
    >
      <span className="w-full truncate font-medium">{first}</span>
      <span className="w-full truncate text-[11px]" style={{ color: 'var(--color-text-secondary)' }}>
        {second}
      </span>
    </button>
  );
}

export function StackHealthDock() {
  const s = useStackHealth();
  const [open, setOpen] = useState(false);
  return (
    <>
      <StackHealthDockView
        health={s.health}
        level={s.level}
        age={s.age}
        noticeOnly={s.noticeOnly}
        missing={s.missing}
        error={s.error}
        pulse={s.pulse}
        onOpen={() => setOpen(true)}
      />
      {open && s.health && (
        <StackHealthDrawer
          health={s.health}
          now={s.now}
          run={s.run}
          onRun={s.runNow}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
