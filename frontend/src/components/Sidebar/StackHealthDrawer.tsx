import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, Loader2, Play, X } from 'lucide-react';
import type { RunState } from '../../hooks/useStackHealth';
import {
  cappedEvents,
  clock,
  duration,
  isIssue,
  nextRunAt,
  type CheckRow,
  type CloudEvent,
  type StackHealth,
} from '../../lib/stack-api';
import { firstBlock } from '../../lib/voice-api';
import { formatAge } from '../Dashboard/FeedFreshness';
import { SpeakButton } from '../shared/SpeakButton';
import { Chip, Quiet, SmallButton } from '../shared/ui';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: 'var(--color-text-tertiary)' }}>
        {title}
      </h3>
      {children}
    </section>
  );
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  const copy = () => {
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      })
      .catch(() => {});
  };
  return (
    <button
      type="button"
      onClick={copy}
      aria-label="Copy"
      title="Copy"
      className="shrink-0 p-1 rounded cursor-pointer"
      style={{ background: 'transparent', border: 'none', color: 'var(--color-text-tertiary)' }}
    >
      {done ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

function CheckRows({ rows, tone }: { rows: CheckRow[]; tone: 'error' | 'warning' }) {
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((r, i) => (
        <li
          key={`${r.area}/${r.check}/${i}`}
          className="flex items-start gap-2 rounded-lg px-2.5 py-2"
          style={{ background: 'var(--color-bg-secondary)', borderLeft: `2px solid var(--color-${tone})` }}
        >
          <div className="flex flex-col gap-0.5 min-w-0 flex-1">
            <span className="font-mono text-[11.5px]" style={{ color: 'var(--color-text)' }}>
              {r.area}/{r.check}
            </span>
            <span className="whitespace-pre-wrap break-words" data-evidence>
              {r.evidence}
            </span>
          </div>
          <CopyButton text={`${r.status} ${r.area}/${r.check}: ${r.evidence}`} />
        </li>
      ))}
    </ul>
  );
}

function EventRows({ events }: { events: CloudEvent[] }) {
  const { shown, more } = cappedEvents(events);
  return (
    <ul className="flex flex-col gap-2">
      {shown.map((e, i) => (
        <li
          key={`${e.alias}/${e.type}/${e.last_updated}/${i}`}
          className="flex flex-col gap-0.5 rounded-lg px-2.5 py-2"
          style={{
            background: 'var(--color-bg-secondary)',
            borderLeft: `2px solid var(--color-${isIssue(e) ? 'error' : 'warning'})`,
          }}
          data-cloud-event
        >
          <span className="text-[11.5px]" style={{ color: 'var(--color-text)' }}>
            {[e.alias, e.service, e.type, e.status, e.age_seconds != null ? formatAge(e.age_seconds) : null]
              .filter(Boolean)
              .join(' · ')}
          </span>
          <span className="whitespace-pre-wrap break-words">{e.description || e.description_first_line}</span>
        </li>
      ))}
      {more > 0 && <Quiet>+{more} more</Quiet>}
    </ul>
  );
}

export interface StackHealthDrawerProps {
  health: StackHealth;
  now: number;
  run: { state: RunState; detail: string | null };
  onRun: () => void;
  onClose: () => void;
}

/**
 * The full text behind the dock (the ProspectDrawer shape): counts, every
 * FAIL then WARN row with its whole evidence line, the open cloud events,
 * and the footer with Run now and Speak. There is no page: this drawer is the
 * "link to the full error text".
 */
export function StackHealthDrawer({ health, now, run, onRun, onClose }: StackHealthDrawerProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const c = health.counts;
  const running = run.state === 'running';
  const drawer = (
    <div className="fixed inset-0 z-[70] flex justify-end" style={{ background: 'rgba(0,0,0,0.35)' }} onClick={onClose}>
      <aside
        role="dialog"
        aria-label="Stack health"
        onClick={(e) => e.stopPropagation()}
        className="h-full w-full max-w-[34rem] overflow-y-auto flex flex-col gap-4 p-5 text-[12.5px]"
        style={{ background: 'var(--color-surface)', borderLeft: '1px solid var(--color-border)', color: 'var(--color-text-secondary)' }}
      >
        <header className="flex items-start justify-between gap-2">
          <div className="flex flex-col gap-1.5">
            <h2 className="text-[15px] font-semibold" style={{ color: 'var(--color-text)' }}>
              Stack health · {clock(health.ran_at)}
            </h2>
            <div className="flex flex-wrap items-center gap-1.5">
              <Chip tone={c.FAIL ? 'error' : 'muted'}>{c.FAIL} FAIL</Chip>
              <Chip tone={c.WARN ? 'warning' : 'muted'}>{c.WARN} WARN</Chip>
              <Chip tone="success">{c.OK} OK</Chip>
              <Chip tone="muted">{c.SKIP} SKIP</Chip>
              {health.stale && <Chip tone="warning">stale</Chip>}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" className="cursor-pointer p-1" style={{ background: 'transparent', border: 'none', color: 'inherit' }}>
            <X size={14} />
          </button>
        </header>

        {health.failing.length > 0 && (
          <Section title="Failures">
            <CheckRows rows={health.failing} tone="error" />
          </Section>
        )}
        {health.warning.length > 0 && (
          <Section title="Warnings">
            <CheckRows rows={health.warning} tone="warning" />
          </Section>
        )}
        {health.failing.length === 0 && health.warning.length === 0 && <Quiet>Every local check is OK.</Quiet>}

        {(health.cloud_events.length > 0 || health.cloud_error) && (
          <Section title="Cloud events">
            {health.cloud_error && <Quiet>{health.cloud_error}</Quiet>}
            <EventRows events={health.cloud_events} />
          </Section>
        )}

        {health.skipped > 0 && (
          <Quiet>
            {health.skipped} check{health.skipped === 1 ? '' : 's'} skipped
          </Quiet>
        )}

        <footer className="mt-auto flex flex-col gap-2 pt-3" style={{ borderTop: '1px solid var(--color-border)' }}>
          <span className="text-[11.5px] tabular-nums" style={{ color: 'var(--color-text-tertiary)' }}>
            Last run {clock(health.ran_at)} · {duration(health.duration_ms)} · next {clock(new Date(nextRunAt(now)).toISOString())}
          </span>
          <div className="flex items-center gap-2">
            <SmallButton onClick={onRun} disabled={running} title="Start the stack-health task now">
              {running ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
              {running ? 'Running…' : 'Run now'}
            </SmallButton>
            <SpeakButton feed="stack_health" block={firstBlock(health.speech)} />
            {run.detail && (
              <span className="text-[11.5px]" style={{ color: 'var(--color-warning)' }} role="status">
                {run.detail}
              </span>
            )}
          </div>
        </footer>
      </aside>
    </div>
  );
  return typeof document === 'undefined' ? drawer : createPortal(drawer, document.body);
}
