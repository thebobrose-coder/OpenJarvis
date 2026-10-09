/**
 * Trading view data: the x402 paper trader's own status export and nightly
 * report, published by Hermes as `trading_status` and `trading_day` and
 * proxied read-only by /api/trading (hq/decisions/0014, contract v1.6
 * "Trading"). The view shows and never acts: there is no write here, and
 * none may be added. Money is strings, as everywhere in the trader.
 */
import type { FeedMeta } from './commerce-api';
import type { SpeechBlock } from './voice-api';
import { apiFetch } from './api';

export type HaltState = 'NORMAL' | 'DEGRADED' | 'KILL' | (string & {});

export interface Position {
  product: string;
  side: string;
  size: string | number;
  entry: string;
  /** Contract v1.7.2: the last print the trader holds (null when it has none),
   * and that print's own time; older files carry neither key. */
  mark?: string | null;
  mark_at?: string | null;
  stop?: string | null;
  held_days?: number | null;
}

/** As `status.json` lists them (`schemas/Status.json`: id, product, side,
 * type, size, limit, status, submitted_at). The nightly report's
 * `open_orders_now` names (client_order_id, product_id, base_size,
 * limit_price) are accepted as fallbacks. */
export interface OpenOrder {
  id?: string;
  client_order_id?: string;
  product?: string;
  product_id?: string;
  side: string;
  type?: string;
  size?: string | number;
  base_size?: string;
  limit?: string | null;
  limit_price?: string | null;
  status?: string;
  submitted_at?: string | null;
}

export const orderId = (o: OpenOrder) => o.id ?? o.client_order_id ?? null;
export const orderProduct = (o: OpenOrder) => o.product ?? o.product_id ?? '—';
export const orderSize = (o: OpenOrder) => (o.size != null ? String(o.size) : o.base_size ?? '—');
export const orderLimit = (o: OpenOrder) => o.limit ?? o.limit_price ?? null;

export interface TickToday {
  time: string;
  kind: string;
  done: boolean;
  at?: string | null;
}

export interface SleeveTicks {
  /** Equities: the fixed times of the day, done or due. */
  today?: TickToday[];
  next_due?: string | null;
  /** Crypto: the polling interval and the entry window. */
  interval_s?: number;
  entry_window?: string;
  entry_done?: string | null;
}

export interface TradeEvent {
  ts: string;
  type: string;
  summary?: string;
}

export interface Alert {
  ts: string;
  source?: string;
  message: string;
}

export interface Sleeve {
  halt_state: HaltState;
  day?: { date?: string; start_equity?: string; entries_halted?: boolean; paused?: string[] };
  equity: string;
  cash: string;
  realized_equity: string;
  hwm: string;
  realized_hwm?: string;
  drawdown_pct: string;
  positions?: Position[];
  open_orders?: OpenOrder[];
  ticks?: SleeveTicks;
  last_tick?: { at?: string | null; kind?: string; submitted?: number; duration_s?: number } | null;
  /** The last 20 non-TICK events. */
  recent_events?: TradeEvent[];
}

export interface TradingStatus extends FeedMeta {
  /** The spoken trading summary, when Hermes includes one (contract v1.1
   * speech blocks; the Listen lineup and the panel's speaker use it). */
  speech?: SpeechBlock[];
  schema?: number;
  /** The trader's own clock: when it wrote the export. */
  written_at?: string;
  mode?: string;
  app?: { installed_commit?: string | null; run_from?: string | null };
  kill?: {
    local_file: boolean | null;
    aws_flag: boolean | null | 'unknown';
    aws_checked_at?: string | null;
    last_cause?: string | null;
    cleared_at?: string | null;
  };
  heartbeat?: { last_sent_at?: string | null; last_ok?: boolean | null; alarm?: string | null };
  x402?: {
    day?: string;
    payments: number;
    total_usdc: string;
    daily_cap_usdc: string;
    entry_pool_usdc?: string;
    exit_reserve_usdc?: string;
    under_cap?: boolean;
  };
  /** Absent when Hermes could not read the export (then `stale` is true). */
  sleeves?: Record<string, Sleeve>;
  alerts_24h?: Alert[];
  nightly?: { last_report?: string | null; next_run?: string | null; last_backup_copy?: string | null };
  /** Set by Hermes when `written_at` was over 15 minutes old at publish time. */
  stale_reason?: string;
}

/** One day of the equity curve, as `trading_day.curve` lists it. */
export interface DayPoint {
  date: string;
  sleeves: Record<string, { equity?: string | null; realized_equity?: string | null }>;
}

/** The nightly report (`src/report.js`): the G2 block first, then per sleeve. */
export interface TradingDay extends FeedMeta {
  date: string;
  mode?: string;
  g2?: { reconcile_diffs?: number; alerts?: number; x402_under_cap?: boolean; x402_total_usdc?: string; ok?: boolean };
  sleeves?: Record<
    string,
    {
      paper?: { starting_cash?: string; cash?: string; realized_equity?: string; realized_pnl_total?: string };
      equity?: string | null;
      realized_pnl_day?: string;
    }
  >;
  /** The last 90 days, one point per day per sleeve, when Hermes includes
   * them (the bridge serves only the latest row, so history travels inside
   * the document). Without it the curve has the latest day only. */
  curve?: DayPoint[];
}

export interface TradingConfig {
  page_url_set: boolean;
  page_url: string | null;
}

export type TradingFeedName = 'trading_status' | 'trading_day';

export const STALE_AFTER_S = 15 * 60;
export const DRAWDOWN_LIMIT_PCT = 8;
export const SLEEVE_ORDER = ['equities', 'crypto'];
export const CURVE_DAYS = 90;

export const SLEEVE_LABEL: Record<string, string> = { equities: 'Equities', crypto: 'Crypto' };
export const sleeveLabel = (name: string) => SLEEVE_LABEL[name] ?? name;

/** Sleeves in the fixed order, then any others by name. */
export function sleeveNames(status: Pick<TradingStatus, 'sleeves'> | null | undefined): string[] {
  const names = Object.keys(status?.sleeves ?? {});
  return [...SLEEVE_ORDER.filter((n) => names.includes(n)), ...names.filter((n) => !SLEEVE_ORDER.includes(n)).sort()];
}

/** A money string as a number, or null when it isn't one. */
export function money(s: string | number | null | undefined): number | null {
  if (s == null || s === '') return null;
  const n = typeof s === 'number' ? s : Number(s);
  return Number.isFinite(n) ? n : null;
}

export const OVER_CAP = 'Over the daily cap: the trader stops paying for data until tomorrow.';

/** The spend meter's tone, shared by the Trading page and the Dashboard
 * summary: error over the cap, warning from 80 % of it, accent otherwise. */
export function spendTone(x: TradingStatus['x402']): 'accent' | 'warning' | 'error' {
  if (x?.under_cap === false) return 'error';
  // Integer micro-USDC (the trader's six places), so exactly 80 % is 80 %.
  const total = money(x?.total_usdc);
  const cap = money(x?.daily_cap_usdc);
  if (total == null || cap == null || cap <= 0) return 'accent';
  return Math.round(total * 1e6) * 5 >= Math.round(cap * 1e6) * 4 ? 'warning' : 'accent';
}

/** "10,000.00"; "—" when missing. */
export function fmtMoney(s: string | number | null | undefined, digits = 2): string {
  const n = money(s);
  if (n == null) return '—';
  return n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** USDC to six places as the trader writes it, trimmed to what matters. */
export function fmtUsdc(s: string | number | null | undefined): string {
  const n = money(s);
  if (n == null) return '—';
  if (n === 0) return '0';
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

const secondsSince = (iso: string | null | undefined, nowMs: number): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.max(0, Math.round((nowMs - t) / 1000));
};

/** Whether the status is stale and why: Hermes's own flag (the trader's
 * `written_at` was over 15 minutes old when published), the route's age
 * past 15 minutes (the bridge unreachable), or the trader's clock itself
 * past 15 minutes as seen from here. */
export function staleness(status: TradingStatus | null | undefined, nowMs = Date.now()): { stale: boolean; reason: string | null } {
  if (!status) return { stale: false, reason: null };
  if (status.stale && status.stale_reason) return { stale: true, reason: status.stale_reason };
  const written = secondsSince(status.written_at, nowMs);
  if (written != null && written > STALE_AFTER_S) {
    return { stale: true, reason: `the trader last wrote its status ${Math.floor(written / 60)} minutes ago` };
  }
  if (status.age_seconds > STALE_AFTER_S) {
    return { stale: true, reason: `no fresh status for ${Math.floor(status.age_seconds / 60)} minutes` };
  }
  if (status.stale) return { stale: true, reason: 'Hermes marked the status stale' };
  return { stale: false, reason: null };
}

export type Tone = 'neutral' | 'accent' | 'warning' | 'error' | 'success' | 'muted';

export function haltTone(state: HaltState | null | undefined): Tone {
  switch (state) {
    case 'NORMAL':
      return 'success';
    case 'DEGRADED':
      return 'warning';
    case 'KILL':
      return 'error';
    default:
      return 'neutral';
  }
}

const STAMP = /\((\d{4}-\d{2}-\d{2}T[\d:.]+Z)\)\s*$/;

/** When a sleeve went to KILL: its latest KILL event, else the time the
 * trader wrote into `kill.last_cause` ("max_drawdown … (2026-…Z)"). */
export function killWhen(status: TradingStatus, sleeve: string): string | null {
  const ev = [...(status.sleeves?.[sleeve]?.recent_events ?? [])].reverse().find((e) => e.type === 'KILL');
  if (ev?.ts) return ev.ts;
  const m = STAMP.exec(status.kill?.last_cause ?? '');
  return m ? m[1] : null;
}

/** The cause without its trailing timestamp. */
export function killCause(status: TradingStatus): string | null {
  const cause = status.kill?.last_cause?.replace(STAMP, '').trim();
  return cause || null;
}

/** The drawdown as a number of percent (the trader writes "3.2" for 3.2%). */
export function drawdownPct(sleeve: Pick<Sleeve, 'drawdown_pct'>): number | null {
  return money(sleeve.drawdown_pct);
}

export interface CurveRow {
  date: string;
  /** `<sleeve>` is the mark-to-market equity, `<sleeve>_realized` the realized one. */
  [series: string]: number | string | null;
}

/** The equity curve's rows, oldest first, at most 90 days. `curve` when
 * Hermes includes it; else the one day the latest report describes. */
export function curveRows(day: TradingDay | null | undefined): CurveRow[] {
  if (!day) return [];
  const points: DayPoint[] = Array.isArray(day.curve) && day.curve.length
    ? day.curve
    : [
        {
          date: day.date,
          sleeves: Object.fromEntries(
            Object.entries(day.sleeves ?? {}).map(([name, s]) => [name, { equity: s.equity ?? null, realized_equity: s.paper?.realized_equity ?? null }]),
          ),
        },
      ];
  return [...points]
    .filter((p) => p && typeof p.date === 'string')
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-CURVE_DAYS)
    .map((p) => {
      const row: CurveRow = { date: p.date };
      for (const [name, s] of Object.entries(p.sleeves ?? {})) {
        row[name] = money(s.equity);
        row[`${name}_realized`] = money(s.realized_equity);
      }
      return row;
    });
}

/** Sleeves that appear in the curve, in the fixed order. */
export function curveSleeves(rows: CurveRow[]): string[] {
  const names = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) if (k !== 'date' && !k.endsWith('_realized')) names.add(k);
  return sleeveNames({ sleeves: Object.fromEntries([...names].map((n) => [n, {} as Sleeve])) });
}

/** The latest alert and the last 20 non-TICK events across sleeves, newest first. */
export function recentEvents(status: TradingStatus): (TradeEvent & { sleeve: string })[] {
  const out: (TradeEvent & { sleeve: string })[] = [];
  for (const name of sleeveNames(status)) {
    for (const e of status.sleeves?.[name]?.recent_events ?? []) if (e.type !== 'TICK') out.push({ ...e, sleeve: name });
  }
  return out.sort((a, b) => (b.ts ?? '').localeCompare(a.ts ?? '')).slice(0, 20);
}

export async function fetchTradingFeed<T extends TradingStatus | TradingDay>(feed: TradingFeedName): Promise<T | null> {
  const res = await apiFetch(`/api/trading/${feed}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(res.status === 503 ? 'Hermes is unreachable' : `Failed: ${res.status}`);
  return res.json();
}

export async function fetchTradingConfig(): Promise<TradingConfig> {
  const res = await apiFetch('/api/trading/config');
  if (!res.ok) return { page_url_set: false, page_url: null };
  const body = (await res.json()) as Partial<TradingConfig>;
  const url = typeof body.page_url === 'string' && /^https:\/\//i.test(body.page_url) ? body.page_url : null;
  return { page_url_set: url != null, page_url: url };
}
