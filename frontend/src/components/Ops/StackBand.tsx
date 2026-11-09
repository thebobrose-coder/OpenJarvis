import { Activity, Loader2, MessagesSquare, Play } from 'lucide-react';
import type { RunState } from '../../hooks/useStackHealth';
import { RUN_MINUTES, centralMinutes, clock, duration, headline, nextRunAt, type CheckStatus, type StackHealth, type StackLevel } from '../../lib/stack-api';
import { firstBlock } from '../../lib/voice-api';
import { DashboardPanel } from '../Dashboard/DashboardPanel';
import { formatAge } from '../Dashboard/FeedFreshness';
import { SpeakButton } from '../shared/SpeakButton';
import { Chip, Quiet, SmallButton, type Tone } from '../shared/ui';

/** The status palette, in the order the bar reads: what needs you first. */
const PARTS: { key: CheckStatus; label: string; tone: Tone; color: string }[] = [
  { key: 'FAIL', label: 'FAIL', tone: 'error', color: 'var(--color-error)' },
  { key: 'WARN', label: 'WARN', tone: 'warning', color: 'var(--color-warning)' },
  { key: 'OK', label: 'OK', tone: 'success', color: 'var(--color-success)' },
  { key: 'SKIP', label: 'SKIP', tone: 'muted', color: 'var(--color-text-tertiary)' },
];

const LEVEL: Record<StackLevel, { label: string; tone: Tone }> = {
  ok: { label: 'all clear', tone: 'success' },
  warn: { label: 'warnings', tone: 'warning' },
  fail: { label: 'failing', tone: 'error' },
  stale: { label: 'stale run', tone: 'warning' },
  unavailable: { label: 'unavailable', tone: 'muted' },
};

const slotLabel = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/**
 * The day as a strip, in Central time: the four scheduled runs (00:10, 06:10,
 * 12:10, 18:10), the last run and now. The feed carries one run, not a history,
 * so this is the schedule, not a sparkline of past results.
 */
export function RunTimeline({ ranAt, now }: { ranAt: string | null; now: number }) {
  const at = (m: number) => `${(m / 1440) * 100}%`;
  const nowM = centralMinutes(now);
  const ranMs = ranAt ? new Date(ranAt).getTime() : NaN;
  // The last run sits on today's strip only when it ran today (Central).
  const ranToday = Number.isFinite(ranMs) && now - ranMs < nowM * 60_000 + 60_000;
  const ranM = ranToday ? centralMinutes(ranMs) : null;
  const next = centralMinutes(nextRunAt(now));
  return (
    <div className="flex flex-col gap-1 min-w-0" data-run-timeline>
      <div className="relative h-8" role="img" aria-label={`Runs at ${RUN_MINUTES.map(slotLabel).join(', ')} Central; now ${slotLabel(nowM)}`}>
        <div className="absolute left-0 right-0 top-1/2 h-0.5 -translate-y-1/2 rounded-full" style={{ background: 'var(--color-border)' }} />
        <div className="absolute top-1/2 h-0.5 -translate-y-1/2 rounded-full" style={{ left: 0, width: at(nowM), background: 'var(--color-text-tertiary)' }} />
        {RUN_MINUTES.map((m) => {
          const isNext = m === next;
          const done = m <= nowM;
          return (
            <span
              key={m}
              className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
              data-slot={slotLabel(m)}
              data-next={isNext ? 'true' : undefined}
              style={{
                left: at(m),
                width: isNext ? 12 : 10,
                height: isNext ? 12 : 10,
                background: done ? 'var(--color-text-tertiary)' : 'var(--color-surface)',
                border: `2px solid ${isNext ? 'var(--color-accent)' : 'var(--color-text-tertiary)'}`,
                boxShadow: '0 0 0 2px var(--color-surface)',
              }}
              title={`${slotLabel(m)} Central${isNext ? ' · next' : done ? ' · done today' : ''}`}
            />
          );
        })}
        {ranM != null && (
          <span
            className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
            data-last-run
            style={{ left: at(ranM), width: 10, height: 10, background: 'var(--color-accent)', boxShadow: '0 0 0 2px var(--color-surface)' }}
            title={`Last run ${clock(ranAt)}`}
          />
        )}
        <span
          className="absolute top-0 bottom-0 w-px"
          data-now
          style={{ left: at(nowM), background: 'var(--color-text-secondary)' }}
          title={`Now ${slotLabel(nowM)} Central`}
        />
      </div>
      <div className="relative h-4 text-ui-10-5 tabular-nums" style={{ color: 'var(--color-text-tertiary)' }}>
        {RUN_MINUTES.map((m) => (
          <span key={m} className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: at(m) }}>
            {slotLabel(m)}
          </span>
        ))}
      </div>
    </div>
  );
}

/** The mix of the last run's checks as one 100 % bar, each part labelled. */
export function CheckMix({ counts }: { counts: Record<CheckStatus, number> }) {
  const total = PARTS.reduce((n, p) => n + (counts[p.key] ?? 0), 0);
  if (!total) return null;
  return (
    <div className="flex h-3 w-full gap-0.5" role="img" aria-label={PARTS.map((p) => `${counts[p.key] ?? 0} ${p.label}`).join(', ')} data-check-mix>
      {PARTS.filter((p) => (counts[p.key] ?? 0) > 0).map((p, i, shown) => (
        <span
          key={p.key}
          style={{
            flexGrow: counts[p.key],
            flexBasis: 0,
            minWidth: 4,
            background: p.color,
            borderRadius: `${i === 0 ? 4 : 0}px ${i === shown.length - 1 ? 4 : 0}px ${i === shown.length - 1 ? 4 : 0}px ${i === 0 ? 4 : 0}px`,
          }}
          title={`${counts[p.key]} ${p.label}`}
        />
      ))}
    </div>
  );
}

export interface StackBandViewProps {
  health: StackHealth | null;
  level: StackLevel;
  age: number | null;
  now: number;
  missing: boolean;
  error: string | null;
  run: { state: RunState; detail: string | null };
  onRun: () => void;
  onAskDesk?: () => void;
}

/**
 * Ops row 1 (widescreen plan 5.3): the stack-health run as a status band. The four
 * counts with the check mix as one bar, the day's run schedule, the headline,
 * and Run now with Speak. Compact rather than the 420 px short band, so the
 * spend row stays above the fold.
 */
export function StackBandView({ health, level, age, now, missing, error, run, onRun, onAskDesk }: StackBandViewProps) {
  const running = run.state === 'running';
  const c = health?.counts;
  return (
    <DashboardPanel
      icon={Activity}
      title="Stack health"
      size="full"
      priority={level === 'fail'}
      loading={!health && !missing && !error}
      error={!health && !missing ? error : null}
      actions={
        <>
          {onAskDesk && health && (
            <SmallButton onClick={onAskDesk} title="Open an Ops desk thread with this run as context">
              <MessagesSquare size={11} /> Ask the desk
            </SmallButton>
          )}
          {health && <SpeakButton feed="stack_health" block={firstBlock(health.speech)} />}
          <SmallButton onClick={onRun} disabled={running} title="Start the stack-health task now">
            {running ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
            {running ? 'Running…' : 'Run now'}
          </SmallButton>
        </>
      }
    >
      {!health ? (
        <Quiet>{missing ? 'No stack-health run yet.' : 'The stack-health file is unavailable.'}</Quiet>
      ) : (
        <div className="grid grid-cols-12 gap-x-6 gap-y-3 items-center" data-stack-band={level}>
          <div className="col-span-12 lg:col-span-5 flex flex-col gap-2">
            <div className="grid grid-cols-4 gap-2">
              {PARTS.map((p) => (
                <div key={p.key} className="flex flex-col rounded-lg px-3 py-2" style={{ background: 'var(--color-bg-secondary)' }} data-count={p.key}>
                  <span className="text-ui-10 uppercase tracking-wide" style={{ color: 'var(--color-text-tertiary)' }}>
                    {p.label}
                  </span>
                  <span
                    className="text-ui-20 font-semibold tabular-nums"
                    style={{ color: (c?.[p.key] ?? 0) > 0 && (p.key === 'FAIL' || p.key === 'WARN') ? p.color : 'var(--color-text)' }}
                  >
                    {c?.[p.key] ?? 0}
                  </span>
                </div>
              ))}
            </div>
            {c && <CheckMix counts={c} />}
          </div>
          <div className="col-span-12 lg:col-span-4">
            <RunTimeline ranAt={health.ran_at} now={now} />
          </div>
          <div className="col-span-12 lg:col-span-3 flex flex-col gap-1 min-w-0 text-ui-12">
            <span className="flex flex-wrap items-center gap-1.5">
              <Chip tone={LEVEL[level].tone}>{LEVEL[level].label}</Chip>
              {health.stale && <Chip tone="warning">stale</Chip>}
              {health.cloud_events.length > 0 && <Chip tone="muted">{health.cloud_events.length} cloud events</Chip>}
            </span>
            {headline(health) && (
              <span className="truncate" style={{ color: 'var(--color-text)' }} title={headline(health)}>
                {headline(health)}
              </span>
            )}
            <span className="tabular-nums" style={{ color: 'var(--color-text-tertiary)' }}>
              Last run {clock(health.ran_at)}
              {age != null ? ` (${formatAge(age)})` : ''} · {duration(health.duration_ms)} · next {clock(new Date(nextRunAt(now)).toISOString())}
            </span>
            {run.detail && (
              <span style={{ color: 'var(--color-warning)' }} role="status">
                {run.detail}
              </span>
            )}
          </div>
        </div>
      )}
    </DashboardPanel>
  );
}
