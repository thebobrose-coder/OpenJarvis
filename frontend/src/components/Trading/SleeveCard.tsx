import { Briefcase, CandlestickChart, Coins, Layers } from 'lucide-react';
import {
  DRAWDOWN_LIMIT_PCT,
  dayChange,
  drawdownPct,
  fmtMoney,
  localTime,
  signedMoney,
  signedPct,
  sleeveColor,
  stopDistancePct,
  stopTone,
  untilLabel,
  utcWindowLocal,
  orderId,
  orderLimit,
  orderProduct,
  orderSize,
  sleeveLabel,
  type Position,
  type Sleeve,
  type TickToday,
} from '../../lib/trading-api';
import { DashboardPanel, type PanelSize } from '../Dashboard/DashboardPanel';
import { formatAge } from '../Dashboard/FeedFreshness';
import { num, shortDateTime } from '../shared/format';
import { Chip, Quiet, Tile } from '../shared/ui';
import { HaltPill } from './TradingHeader';
import { Meter } from './Meter';

const SLEEVE_ICON: Record<string, typeof Briefcase> = { equities: Briefcase, crypto: Coins, futures: CandlestickChart };

/** Equities: the day's fixed ticks, done or due, as a short timeline, in
 * local time (the trader's schedule is in ET; it shows on hover). */
function TickTimeline({ ticks }: { ticks: TickToday[] }) {
  return (
    <ol className="flex flex-wrap items-center gap-2" data-tick-timeline>
      {ticks.map((t, i) => (
        <li
          key={`${t.time}-${i}`}
          className="inline-flex items-center gap-1.5 text-[11.5px]"
          data-tick={t.done ? 'done' : 'due'}
          title={`${t.time} ET${t.done && t.at ? ` · done ${shortDateTime(t.at)}` : ''}`}
        >
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ background: t.done ? 'var(--color-success)' : 'transparent', border: `1.5px solid ${t.done ? 'var(--color-success)' : 'var(--color-text-tertiary)'}` }}
            aria-hidden
          />
          <span className="tabular-nums" style={{ color: 'var(--color-text)' }}>
            {localTime(t.at) ?? `${t.time} ET`}
          </span>
          <span style={{ color: 'var(--color-text-tertiary)' }}>
            {t.kind} · {t.done ? 'done' : 'due'}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** The Stop cell: the price, and under it how far the mark is from it,
 * amber under 2 %, red once the mark is through it. */
function StopCell({ p }: { p: Position }) {
  const pct = stopDistancePct(p);
  const tone = stopTone(pct);
  return (
    <td className="pr-2 @md:pr-3 py-0.5 align-top" data-stop-distance={pct == null ? undefined : pct.toFixed(2)}>
      {p.stop ? fmtMoney(p.stop) : '—'}
      {pct != null && (
        <div
          className="text-[10.5px] leading-tight"
          style={{ color: tone ? `var(--color-${tone})` : 'var(--color-text-tertiary)' }}
          title={pct <= 0 ? 'The mark is through the stop' : `The mark is ${num(pct, 1)}% from the stop`}
        >
          {pct <= 0 ? 'past' : `${num(pct, 1)}%`}
        </div>
      )}
    </td>
  );
}

/** The Mark cell's hover: the print's own time and age ("as of 14:30 CT · 5 h
 * ago"), with the date when it isn't today's. A mark restored at boot keeps its
 * old time, so the age tells a stale price from a fresh one. */
export function markAsOf(markAt: string | null | undefined, now: number): string | undefined {
  if (!markAt) return undefined;
  const d = new Date(markAt);
  if (Number.isNaN(d.getTime())) return undefined;
  // 'shortGeneric' ("CT", not "CDT") is ES2022; the lib here is ES2020.
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'shortGeneric' } as Intl.DateTimeFormatOptions);
  const sameDay = d.toDateString() === new Date(now).toDateString();
  const date = sameDay ? '' : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, `;
  return `as of ${date}${time} · ${formatAge(Math.max(0, now - d.getTime()) / 1000)}`;
}

/** One sleeve: the money tiles, the drawdown against the 8% limit, positions
 * with their marks, open orders, today's ticks and the last tick. Read-only. */
export function SleeveCard({
  name,
  sleeve,
  loading,
  error,
  now = Date.now(),
  size = 'half',
}: {
  name: string;
  sleeve: Sleeve | null;
  loading?: boolean;
  error?: string | null;
  now?: number;
  /** One, two or three across (see `sleeveSize`). */
  size?: PanelSize;
}) {
  const Icon = SLEEVE_ICON[name] ?? Layers;
  const dd = sleeve ? drawdownPct(sleeve) : null;
  const ddTone = dd == null ? 'accent' : dd >= DRAWDOWN_LIMIT_PCT ? 'error' : dd >= DRAWDOWN_LIMIT_PCT / 2 ? 'warning' : 'accent';
  const positions = sleeve?.positions ?? [];
  const orders = sleeve?.open_orders ?? [];
  const ticks = sleeve?.ticks;
  const today = sleeve ? dayChange(sleeve) : null;
  const todayIso = new Date(now).toISOString().slice(0, 10);
  return (
    <DashboardPanel icon={Icon} iconColor={sleeveColor(name)} title={sleeveLabel(name)} tag={sleeve?.day?.date ?? undefined} size={size} loading={loading} error={error}>
      {!sleeve ? (
        <Quiet>No status for this sleeve yet.</Quiet>
      ) : (
        // A container: the card lays out by its own width, a third of the
        // row or half of it, not by the window's.
        <div className="@container flex flex-col gap-3" data-sleeve-card={name}>
          <div className="flex flex-wrap items-center gap-2">
            <HaltPill state={sleeve.halt_state} />
            {sleeve.day?.entries_halted && <Chip tone="warning">entries halted</Chip>}
            {(sleeve.day?.paused ?? []).map((p) => (
              <Chip key={p} tone="muted" title="Paused by the trader for the day">
                paused: {p}
              </Chip>
            ))}
          </div>

          <div className="grid grid-cols-2 @md:grid-cols-4 gap-2">
            <Tile
              label="Equity"
              value={fmtMoney(sleeve.equity)}
              sub={
                today ? (
                  <span data-day-change title={`Since the day's start, ${fmtMoney(sleeve.day?.start_equity)}`}>
                    {signedMoney(today.abs)} ({signedPct(today.pct)}) today
                  </span>
                ) : sleeve.day?.start_equity ? (
                  `start ${fmtMoney(sleeve.day.start_equity)}`
                ) : undefined
              }
              subTone={today ? (today.abs > 0 ? 'success' : today.abs < 0 ? 'error' : 'muted') : undefined}
            />
            <Tile label="Cash" value={fmtMoney(sleeve.cash)} />
            <Tile label="Realized equity" value={fmtMoney(sleeve.realized_equity)} sub={sleeve.realized_hwm ? `realized HWM ${fmtMoney(sleeve.realized_hwm)}` : undefined} />
            <Tile label="High-water mark" value={fmtMoney(sleeve.hwm)} />
          </div>

          <Meter
            testId={`drawdown-${name}`}
            value={dd}
            limit={DRAWDOWN_LIMIT_PCT}
            tone={ddTone}
            label="Drawdown from high-water mark"
            detail={`${dd == null ? '—' : num(dd, 2)}% of ${DRAWDOWN_LIMIT_PCT}% limit`}
          />

          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-medium" style={{ color: 'var(--color-text-secondary)' }}>
              Positions ({positions.length})
            </span>
            {positions.length === 0 ? (
              <Quiet>No open positions.</Quiet>
            ) : (
              <div className="overflow-x-auto">
              <table className="w-full text-[11.5px] @md:text-[12px] tabular-nums whitespace-nowrap [&_td:last-child]:pr-0 [&_th:last-child]:pr-0" data-positions>
                <thead>
                  <tr className="text-left" style={{ color: 'var(--color-text-tertiary)' }}>
                    {['Product', 'Side', 'Size', 'Entry', 'Mark', 'Stop', 'Held'].map((h) => (
                      <th key={h} className="font-normal pr-2 @md:pr-3 pb-1">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody style={{ color: 'var(--color-text)' }}>
                  {positions.map((p, i) => (
                    <tr key={`${p.product}-${i}`} className="align-top" style={{ borderTop: '1px solid var(--color-border)' }}>
                      <td className="pr-2 @md:pr-3 py-0.5">{p.product}</td>
                      <td className="pr-2 @md:pr-3">{p.side}</td>
                      <td className="pr-2 @md:pr-3">{String(p.size)}</td>
                      <td className="pr-2 @md:pr-3">{fmtMoney(p.entry)}</td>
                      <td className="pr-2 @md:pr-3" title={p.mark != null ? markAsOf(p.mark_at, now) : undefined} data-mark>
                        {fmtMoney(p.mark)}
                      </td>
                      <StopCell p={p} />
                      <td className="pr-2 @md:pr-3">{p.held_days != null ? `${num(p.held_days)} d` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-medium" style={{ color: 'var(--color-text-secondary)' }}>
              Open orders ({orders.length})
            </span>
            {orders.length === 0 ? (
              <Quiet>No open orders.</Quiet>
            ) : (
              <ul className="flex flex-col gap-0.5 text-[12px] tabular-nums" data-open-orders style={{ color: 'var(--color-text)' }}>
                {orders.map((o, i) => (
                  <li key={orderId(o) ?? i}>
                    {o.side} {orderSize(o)} {orderProduct(o)}
                    {o.type ? ` · ${o.type}` : ''}
                    {orderLimit(o) ? ` @ ${fmtMoney(orderLimit(o))}` : ''}
                    {o.status ? ` · ${o.status}` : ''}
                    {o.submitted_at ? ` · ${shortDateTime(o.submitted_at)}` : ''}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-medium" style={{ color: 'var(--color-text-secondary)' }}>
              Today’s ticks
            </span>
            {ticks?.today?.length ? (
              <TickTimeline ticks={ticks.today} />
            ) : ticks?.interval_s != null ? (
              <p className="text-[11.5px]" data-tick-interval style={{ color: 'var(--color-text-secondary)' }}>
                Every {num(ticks.interval_s / 60)} min
                {ticks.entry_window ? (
                  <span title={`${ticks.entry_window} (UTC)`}> · entry window {utcWindowLocal(ticks.entry_window, now) ?? ticks.entry_window}</span>
                ) : (
                  ''
                )}
                {ticks.entry_done ? ` · entry done ${ticks.entry_done === todayIso ? 'today' : ticks.entry_done}` : ' · entry not yet today'}
              </p>
            ) : (
              <Quiet>No tick schedule reported.</Quiet>
            )}
            {ticks?.next_due && (
              <span className="text-[11px]" data-next-due style={{ color: 'var(--color-text-tertiary)' }} title={shortDateTime(ticks.next_due)}>
                Next due {untilLabel(ticks.next_due, now)} ({localTime(ticks.next_due)})
              </span>
            )}
          </div>

          {sleeve.last_tick && (
            <p className="text-[11px]" data-last-tick style={{ color: 'var(--color-text-tertiary)' }}>
              Last tick {sleeve.last_tick.at ? shortDateTime(sleeve.last_tick.at) : '—'}
              {sleeve.last_tick.kind ? ` · ${sleeve.last_tick.kind}` : ''}
              {sleeve.last_tick.submitted != null ? ` · ${num(sleeve.last_tick.submitted)} submitted` : ''}
              {sleeve.last_tick.duration_s != null ? ` · ${num(sleeve.last_tick.duration_s, 1)} s` : ''}
            </p>
          )}
        </div>
      )}
    </DashboardPanel>
  );
}
