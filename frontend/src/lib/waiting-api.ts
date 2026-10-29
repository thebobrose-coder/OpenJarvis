/**
 * "Waiting on you" (hq 0020 P1): one list of everything waiting on the
 * operator, for the bell and the Dashboard panel. /api/waiting merges Hermes's
 * `approvals` feed (contract v1.17 block 2) with the local kinds: x402 from
 * `trading_status`, G0 episodes, inbox decision boxes, work orders and the G1
 * mirror's open approvals (when configured). It is
 * an index: every row links to the page that already holds the action.
 * /api/decisions and its tick are the Decisions drawer (0020 A5). Pure
 * helpers live here so they test without a DOM.
 *
 * v1.22 (hq 0023): every row has a lane. "For you" (`act`) is what only the
 * operator can do and what the bell counts; "Dispatch" (`delegate`) can be
 * handed to Claude Code or the Commerce desk in one click; "Filed" (`fyi`)
 * is counted, never listed.
 */
import { apiFetch } from './api';

export type WaitingKind =
  | 'proposal'
  | 'thesis_prompt'
  | 'patch'
  | 'patch_class'
  | 'follow_up'
  | 'rec'
  | 'g0'
  | 'decision'
  | 'x402'
  | 'workorder'
  | 'g1';

export interface WaitingItem {
  kind: WaitingKind | (string & {});
  id: string | number;
  source_feed: string;
  scope: string | null;
  title: string;
  detail: string | null;
  created_at: string | null;
  due: string | null;
  priority: number | null;
  link: { page: string; focus: string | number | null } | null;
  /** Local rows that open a drawer here instead of a page. */
  opens?: 'decisions' | 'g1' | 'workorder';
  /** v1.22; absent on an older feed, which reads as `act`. */
  lane?: Lane;
  delegate?: Delegate | null;
  /** `rec` only: how often the briefing proposed it again. */
  times_seen?: number | null;
  last_seen?: string | null;
}

export type Lane = 'act' | 'delegate' | 'fyi';

export type Delegate =
  | { target: 'workorder'; repo: string; scope: 'read-only' | 'edit' }
  | { target: 'desk'; desk: string };

export interface WaitingSource {
  generated_at: string | null;
  age_seconds: number | null;
  stale?: boolean;
  error?: string;
  /** approvals only: each Hermes source feed's generated_at (null = missing). */
  feeds?: Record<string, string | null>;
}

export interface Waiting {
  generated_at: string;
  counts: Record<string, number> & { total: number };
  items: WaitingItem[];
  sources: Record<string, WaitingSource>;
  /** False when the workspace data folder isn't configured (no local kinds). */
  local: boolean;
}

export interface DecisionBox {
  file: string;
  folder: string;
  title: string;
  modified_at: string;
  number: number;
  ticked: boolean;
  decision: string;
  default: string;
  alternative: string | null;
  text: string;
  decided_note: string | null;
  line: number;
  hash?: string;
  paragraph?: string;
  archived?: boolean;
}

export interface Decisions {
  open: DecisionBox[];
  waiting_briefs: { file: string; folder: string; title: string; modified_at: string }[];
  recently_decided: DecisionBox[];
}

export const POLL_MS = 60 * 1000;
export const NOTE_MAX = 500;
/** A source older than this reads as stale on the panel (Hermes runs every 5 min). */
export const SOURCE_STALE_S = 30 * 60;

/** The groups, in the order the bell and the panel show them. */
export const KIND_ORDER: WaitingKind[] = [
  'x402',
  'g1',
  'decision',
  'g0',
  'proposal',
  'thesis_prompt',
  'follow_up',
  'patch',
  'patch_class',
  'rec',
  'workorder',
];

export const KIND_LABEL: Record<string, string> = {
  x402: 'Trading',
  g1: 'Posts to approve (G1)',
  decision: 'Decisions',
  g0: 'Episode scripts (G0)',
  proposal: 'Content proposals',
  thesis_prompt: 'Thesis prompts',
  follow_up: 'BD follow-ups',
  patch: 'Catalog fixes',
  patch_class: 'Invalid patches, by class',
  rec: 'Store recommendations',
  workorder: 'Work orders',
};

export const SOURCE_LABEL: Record<string, string> = {
  approvals: 'Hermes index',
  trading_status: 'Trading status',
  inbox: 'Inbox',
  studio: 'Studio',
  workorders: 'Work orders',
  g1_mirror: 'G1 mirror',
  content_proposals: 'Content',
  catalog_fixes: 'Catalog fixes',
  bd_pipeline: 'BD pipeline',
  ecom_recommendations: 'Recommendations',
};

export class WaitingError extends Error {
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

export async function fetchWaiting(): Promise<Waiting> {
  const res = await apiFetch('/api/waiting');
  if (!res.ok) throw new WaitingError(res.status, await detail(res, `Failed: ${res.status}`));
  return res.json();
}

export async function fetchDecisions(): Promise<Decisions> {
  const res = await apiFetch('/api/decisions');
  if (!res.ok) throw new WaitingError(res.status, await detail(res, `Failed: ${res.status}`));
  return res.json();
}

/** Tick one box (0020 A5). A 409 means the brief changed or it was already decided. */
export async function tickDecision(box: Pick<DecisionBox, 'file' | 'line' | 'hash'>, note: string): Promise<void> {
  const res = await apiFetch('/api/decisions/tick', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: box.file, line: box.line, hash: box.hash, note }),
  });
  if (!res.ok) throw new WaitingError(res.status, await detail(res, `Failed: ${res.status}`));
}

export interface WaitingGroup {
  kind: string;
  label: string;
  /** The uncapped count for the kind (Hermes caps its items at 200). */
  count: number;
  items: WaitingItem[];
}

export const laneOf = (item: Pick<WaitingItem, 'lane'>): Lane => item.lane ?? 'act';

/** Rows grouped by kind in KIND_ORDER (unknown kinds last); empty groups
 * dropped. With a lane, only that lane's rows, counted as listed: a kind's
 * uncapped count spans lanes, so it only applies to the whole list. */
export function groupItems(w: Pick<Waiting, 'items' | 'counts'> | null, lane?: Lane): WaitingGroup[] {
  if (!w) return [];
  const byKind = new Map<string, WaitingItem[]>();
  for (const item of w.items) {
    if (lane && laneOf(item) !== lane) continue;
    const list = byKind.get(item.kind) ?? [];
    list.push(item);
    byKind.set(item.kind, list);
  }
  const kinds = [...KIND_ORDER, ...[...byKind.keys()].filter((k) => !KIND_ORDER.includes(k as WaitingKind))];
  return kinds
    .map((kind) => {
      const items = byKind.get(kind) ?? [];
      const count = lane ? items.length : Math.max(w.counts[kind] ?? 0, items.length);
      return { kind, label: KIND_LABEL[kind] ?? kind, count, items };
    })
    .filter((g) => g.count > 0);
}

/** The route a row opens: `link.page` (which may carry a hash, as
 * `/commerce#fixes` does) with `?focus=<id>`; null when it has no page. */
export function linkFor(item: Pick<WaitingItem, 'link'>): string | null {
  if (!item.link?.page) return null;
  const [path, hash] = item.link.page.split('#');
  const focus = item.link.focus;
  const query = focus == null || focus === '' ? '' : `?focus=${encodeURIComponent(String(focus))}`;
  return `${path}${query}${hash ? `#${hash}` : ''}`;
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const m = Math.floor(Math.max(0, now - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** "due today", "due in 2d", "3d overdue" on the Central-agnostic local date. */
export function dueLabel(due: string | null | undefined, now = Date.now()): string | null {
  if (!due) return null;
  const d = new Date(due.length <= 10 ? `${due}T12:00:00` : due);
  if (Number.isNaN(d.getTime())) return null;
  const day = (x: Date) => Math.floor(new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime() / 86400000);
  const diff = day(d) - day(new Date(now));
  if (diff === 0) return 'due today';
  return diff < 0 ? `${-diff}d overdue` : `due in ${diff}d`;
}

export interface StaleNote {
  name: string;
  label: string;
  /** Age in seconds, or null when the source is missing or failed. */
  age: number | null;
  error?: string;
}

/** Sources worth a warning: failed, missing, or (the 5-minute index and the
 * other live sources) older than 30 min. Hermes's own source feeds run on
 * their own cadence, some daily, so only a missing one warns; their ages are
 * in `sourceAges`. */
export function staleSources(w: Pick<Waiting, 'sources'> | null): StaleNote[] {
  if (!w) return [];
  const out: StaleNote[] = [];
  for (const [name, s] of Object.entries(w.sources)) {
    const label = SOURCE_LABEL[name] ?? name;
    if (s.error) out.push({ name, label, age: null, error: s.error });
    else if (s.stale || (s.age_seconds != null && s.age_seconds > SOURCE_STALE_S)) out.push({ name, label, age: s.age_seconds });
    for (const [feed, at] of Object.entries(s.feeds ?? {})) {
      if (!at) out.push({ name: feed, label: SOURCE_LABEL[feed] ?? feed, age: null });
    }
  }
  return out;
}

/** Every source with an age, for the panel's muted footer. */
export function sourceAges(w: Pick<Waiting, 'sources'> | null, now = Date.now()): StaleNote[] {
  if (!w) return [];
  const ageOf = (iso: string | null) => (iso ? Math.max(0, (now - new Date(iso).getTime()) / 1000) : null);
  const out: StaleNote[] = [];
  for (const [name, s] of Object.entries(w.sources)) {
    if (s.feeds) {
      for (const [feed, at] of Object.entries(s.feeds)) out.push({ name: feed, label: SOURCE_LABEL[feed] ?? feed, age: ageOf(at) });
    } else if (s.generated_at) out.push({ name, label: SOURCE_LABEL[name] ?? name, age: ageOf(s.generated_at) });
  }
  return out;
}

export function fmtAge(seconds: number | null): string {
  if (seconds == null) return 'missing';
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m old`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h old` : `${Math.floor(h / 24)}d old`;
}

/** Scroll a deep-linked item into view once its page has rendered it, and
 * outline it briefly. Gives up after `timeoutMs` (the feed may still be loading). */
export function scrollToWhenReady(ids: string[], timeoutMs = 8000): () => void {
  if (typeof document === 'undefined') return () => {};
  const started = Date.now();
  let timer: number | undefined;
  const attempt = () => {
    const el = ids.map((id) => document.getElementById(id)).find(Boolean);
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      const prev = el.style.outline;
      el.style.outline = '2px solid var(--color-accent)';
      window.setTimeout(() => {
        el.style.outline = prev;
      }, 2500);
      return;
    }
    if (Date.now() - started < timeoutMs) timer = window.setTimeout(attempt, 250);
  };
  attempt();
  return () => window.clearTimeout(timer);
}

// -- lanes, Dispatch and Snooze (v1.22, hq 0023) ------------------------------

export const TABS: { lane: Lane; label: string }[] = [
  { lane: 'act', label: 'For you' },
  { lane: 'delegate', label: 'Dispatch' },
  { lane: 'fyi', label: 'Filed' },
];

/** A lane's count: the server's (uncapped) when present, else the listed rows. */
export function laneCount(w: Pick<Waiting, 'items' | 'counts'> | null, lane: Lane): number {
  if (!w) return 0;
  const n = w.counts[lane];
  return typeof n === 'number' ? n : w.items.filter((i) => laneOf(i) === lane).length;
}

/** The bell's number: what only the operator can do. */
export const bellCount = (w: Pick<Waiting, 'items' | 'counts'> | null) => laneCount(w, 'act');

export interface FiledRow {
  key: string;
  label: string;
  count: number;
  /** A page to open, or the work-order reports drawer. */
  href?: string;
  opens?: 'workorder';
}

/** The Filed tab: counts only, each opening where it is filed. Hermes's fyi
 * rows today are compliance recs with a fix already in hand (0023 lane rules). */
export function filedRows(w: Pick<Waiting, 'counts'> | null): FiledRow[] {
  if (!w) return [];
  const done = w.counts.workorder_done ?? 0;
  const hermes = Math.max(0, (w.counts.fyi ?? 0) - done);
  const rows: FiledRow[] = [];
  if (hermes) rows.push({ key: 'recs', label: 'Compliance recommendations with a fix in hand', count: hermes, href: '/commerce' });
  if (done) rows.push({ key: 'workorders', label: `Work order${done === 1 ? '' : 's'} done`, count: done, opens: 'workorder' });
  return rows;
}

/** The Dispatch button's words, by target and stage. */
export function dispatchLabel(d: Delegate | null | undefined): string | null {
  if (!d) return null;
  if (d.target === 'desk') return 'Ask the Commerce desk';
  return `Dispatch to Claude Code (${d.scope === 'edit' ? 'edit' : 'read-only'})`;
}

export const SNOOZE_DAYS = [1, 3, 7, 14, 30] as const;
export const SNOOZE_DEFAULT = 7;

/** The snooze note the bridge takes: "" for the 7-day default, else the days. */
export const snoozeNote = (days: number) => (days === SNOOZE_DEFAULT ? '' : String(days));

export const rowKey = (item: Pick<WaitingItem, 'kind' | 'id'>) => `${item.kind}:${item.id}`;

export interface DispatchResult {
  order_id: string;
  path: string;
  scope: string;
  repo: string;
  waits_for_tomorrow: boolean;
  decided: boolean | null;
  decide_error: string | null;
}

/** One click on a work-order row (0023 D2); the server re-reads the row. */
export async function dispatchRow(item: WaitingItem): Promise<DispatchResult> {
  const res = await apiFetch('/api/dispatch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: item.kind,
      id: String(item.id),
      source_feed: item.source_feed,
      title: item.title,
      detail: item.detail,
      scope: item.scope,
      delegate: item.delegate,
      link: item.link,
    }),
  });
  if (!res.ok) throw new WaitingError(res.status, await detail(res, `Failed: ${res.status}`));
  return res.json();
}

/** Snooze one rec. A 400 from the bridge is shown, never retried. */
export async function snoozeRec(id: string | number, days: number): Promise<void> {
  const res = await apiFetch(`/api/commerce/recommendations/${encodeURIComponent(String(id))}/snoozed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: snoozeNote(days) }),
  });
  if (!res.ok) throw new WaitingError(res.status, await detail(res, `Failed: ${res.status}`));
}

/** What a row says after its action: the order id, or the error. */
export type RowStatus =
  | { kind: 'busy' }
  | { kind: 'dispatched'; orderId: string; waits: boolean; decided: boolean | null; decideError: string | null }
  | { kind: 'snoozed'; days: number }
  | { kind: 'error'; message: string };

export function rowStatusText(s: RowStatus): string {
  switch (s.kind) {
    case 'busy':
      return 'Working…';
    case 'dispatched': {
      const parts = [`Dispatched as ${s.orderId}`];
      if (s.waits) parts.push("today's dispatch cap is reached, so it runs tomorrow");
      if (s.decided === false) parts.push(`the rec wasn't marked accepted (${s.decideError ?? 'bridge error'})`);
      else if (s.decided) parts.push('it leaves this list within 2 minutes');
      return parts.join('; ');
    }
    case 'snoozed':
      return `Snoozed for ${s.days} day${s.days === 1 ? '' : 's'}; it leaves this list within 2 minutes`;
    case 'error':
      return s.message;
  }
}

// -- work-order reports (O4) --------------------------------------------------

export interface WorkOrderReport {
  id: string;
  status: 'done' | 'failed' | 'blocked' | 'rejected' | (string & {});
  repo: string | null;
  scope: string | null;
  branch: string | null;
  costUsd: number | null;
  finishedAt: string;
  reason: string | null;
  needsHuman: string | null;
  summary: string | null;
}

export async function fetchReports(): Promise<WorkOrderReport[]> {
  const res = await apiFetch('/api/workorders/reports');
  if (!res.ok) throw new WaitingError(res.status, await detail(res, `Failed: ${res.status}`));
  return (await res.json()).reports ?? [];
}
