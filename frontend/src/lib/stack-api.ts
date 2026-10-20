/**
 * The sidebar's stack-health dock (hq decision 0017 A2): the operator's
 * stack-health check writes a local result file every 6 h, and the cloud
 * Health relay exports open AWS / Google events. /api/stack/health reads both
 * (machine-local paths in credentials.toml, `[stack]`); nothing here reaches
 * Hermes. Pure helpers for the dock and drawer live here so they test without
 * a DOM.
 */
import { apiFetch } from './api';
import type { SpeechBlock } from './voice-api';

export type CheckStatus = 'OK' | 'WARN' | 'FAIL' | 'SKIP';

export interface CheckRow {
  area: string;
  check: string;
  status: CheckStatus;
  /** One free-text line from the check, shown in full. */
  evidence: string;
}

export interface CloudEvent {
  alias: string;
  service: string;
  type: string;
  /** `issue` is red; `accountNotification`, `scheduledChange`, `investigation` amber. */
  category: string;
  status: string;
  region?: string;
  last_updated: string | null;
  age_seconds: number | null;
  description_first_line: string;
  description?: string;
}

export interface StackHealth {
  ran_at: string | null;
  duration_ms?: number | null;
  age_seconds: number | null;
  stale: boolean;
  counts: Record<CheckStatus, number>;
  failing: CheckRow[];
  warning: CheckRow[];
  skipped: number;
  cloud_events: CloudEvent[];
  cloud_error?: string | null;
  speech?: SpeechBlock[];
}

export type StackLevel = 'ok' | 'warn' | 'fail' | 'stale' | 'unavailable';

/** The check runs every 6 h; a file older than 7 h means a run was missed. */
export const STALE_AFTER_S = 7 * 3600;
export const NO_RUN = 'No stack-health run yet';
export const ALL_CLEAR = 'All systems operating nominally.';

export class StackHealthError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function detail(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json();
    return typeof body?.detail === 'string' ? body.detail : fallback;
  } catch {
    return fallback;
  }
}

export async function fetchStackHealth(): Promise<StackHealth> {
  const res = await apiFetch('/api/stack/health');
  if (!res.ok) throw new StackHealthError(res.status, await detail(res, `Failed: ${res.status}`));
  return res.json();
}

/** Start the scheduled task now; the new file lands about a minute later. */
export async function runStackHealth(): Promise<void> {
  const res = await apiFetch('/api/stack/health/run', { method: 'POST' });
  if (!res.ok) throw new StackHealthError(res.status, await detail(res, `Failed: ${res.status}`));
}

export const isIssue = (e: CloudEvent) => e.category === 'issue';

/** Age now, counting on from the age the server reported at `receivedAt`. */
export function ageNow(h: StackHealth, receivedAt: number, now: number): number | null {
  if (h.age_seconds == null) return null;
  return h.age_seconds + Math.max(0, now - receivedAt) / 1000;
}

/** fail: a FAIL or an open cloud issue; warn: a WARN or a cloud notice;
 * stale: otherwise clean but older than 7 h. */
export function stackLevel(h: StackHealth | null, ageSeconds: number | null = h?.age_seconds ?? null): StackLevel {
  if (!h) return 'unavailable';
  if ((h.counts?.FAIL ?? 0) > 0 || h.failing.length > 0 || h.cloud_events.some(isIssue)) return 'fail';
  if ((h.counts?.WARN ?? 0) > 0 || h.warning.length > 0 || h.cloud_events.length > 0) return 'warn';
  if (h.stale || ageSeconds == null || ageSeconds > STALE_AFTER_S) return 'stale';
  return 'ok';
}

/** Only cloud notices are amiss: the dock keeps its green line and adds a note. */
export function noticeOnly(h: StackHealth | null, ageSeconds: number | null = h?.age_seconds ?? null): boolean {
  if (!h || stackLevel(h, ageSeconds) !== 'warn') return false;
  const localClean = (h.counts?.WARN ?? 0) === 0 && h.warning.length === 0;
  const fresh = !h.stale && ageSeconds != null && ageSeconds <= STALE_AFTER_S;
  return localClean && fresh && h.cloud_events.length > 0;
}

const rowName = (r: CheckRow) => `${r.area}/${r.check}`;
const eventName = (e: CloudEvent) => [e.alias, e.service].filter(Boolean).join(' · ');

/** The first FAIL's area/check, else the first WARN's, else the first cloud event's. */
export function headline(h: StackHealth): string {
  if (h.failing[0]) return rowName(h.failing[0]);
  const issue = h.cloud_events.find(isIssue);
  if (issue) return eventName(issue);
  if (h.warning[0]) return rowName(h.warning[0]);
  return h.cloud_events[0] ? eventName(h.cloud_events[0]) : '';
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "12 min", "9 h": an age without "ago". */
export function ageWords(seconds: number): string {
  const min = Math.floor(seconds / 60);
  if (min < 1) return 'under a minute';
  if (min < 120) return `${min} min`;
  return `${Math.floor(min / 60)} h`;
}

/** The strip's two lines when the dock isn't green. */
export function stripLines(h: StackHealth, ageSeconds: number | null): [string, string] {
  const fails = h.counts?.FAIL ?? h.failing.length;
  const warns = h.counts?.WARN ?? h.warning.length;
  const issues = h.cloud_events.filter(isIssue).length;
  const notices = h.cloud_events.length - issues;
  const name = headline(h);
  let first: string;
  if (fails > 0 || warns > 0) first = `${fails} FAIL · ${warns} WARN — ${name}`;
  else if (issues > 0) first = `${plural(issues, 'cloud issue')} — ${name}`;
  else if (notices > 0) first = `${plural(notices, 'cloud notice')} — ${name}`;
  else first = 'Stack health run overdue';
  const second = ageSeconds == null ? 'Stack health has no run time' : `Stack health is ${ageWords(ageSeconds)} old`;
  return [first, second];
}

/** Local hh:mm of an ISO time. */
export function clock(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function duration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${s % 60} s`;
}

/** The task runs at 00:10, 06:10, 12:10 and 18:10 Central. */
const RUN_MINUTES = [10, 370, 730, 1090];

function centralMinutes(at: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(new Date(at));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return (get('hour') % 24) * 60 + get('minute');
}

/** The next scheduled run after `now` (ms). */
export function nextRunAt(now: number): number {
  const mins = centralMinutes(now);
  const wait = Math.min(...RUN_MINUTES.map((m) => (m - mins + 1440 - 1) % 1440 + 1));
  const base = now - (now % 60_000);
  return base + wait * 60_000;
}

/** Newest first (the server already sorts), at most `cap`, and how many more. */
export function cappedEvents(events: CloudEvent[], cap = 10): { shown: CloudEvent[]; more: number } {
  return { shown: events.slice(0, cap), more: Math.max(0, events.length - cap) };
}

/** D6: chime when `fail` is entered, once per run (`ran_at`), never for amber. */
export function shouldChime(
  previous: StackLevel | null,
  level: StackLevel,
  ranAt: string | null,
  chimedRanAt: string | null,
): boolean {
  return level === 'fail' && previous !== 'fail' && !!ranAt && ranAt !== chimedRanAt;
}

/**
 * Run now: start the task, then poll every `intervalMs` until `ran_at`
 * changes or `timeoutMs` passes. Resolves with the new copy, or null on
 * timeout. `sleep` is injectable for tests.
 */
export async function runAndWait(
  previousRanAt: string | null,
  {
    run = runStackHealth,
    fetch = fetchStackHealth,
    intervalMs = 5000,
    timeoutMs = 120_000,
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  }: {
    run?: () => Promise<void>;
    fetch?: () => Promise<StackHealth>;
    intervalMs?: number;
    timeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<StackHealth | null> {
  await run();
  for (let waited = 0; waited < timeoutMs; waited += intervalMs) {
    await sleep(intervalMs);
    try {
      const h = await fetch();
      if (h.ran_at && h.ran_at !== previousRanAt) return h;
    } catch {
      // The file is replaced atomically; a miss just means try again.
    }
  }
  return null;
}
