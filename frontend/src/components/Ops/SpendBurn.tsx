import { useState } from 'react';
import { Wallet } from 'lucide-react';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { CostReader, SpendLedger, SpendLine } from '../../lib/commerce-api';
import { AlertRow, PERIOD_LABEL, SPEND_TONE, SpendLedgerBody, amount, groupLines } from '../Commerce/SpendLedgerPanel';
import { DashboardPanel } from '../Dashboard/DashboardPanel';
import { Chip, Quiet, Segmented } from '../shared/ui';

type SpendView = 'gauges' | 'table';

/** A status's fill: the ledger's own tones, accent for a line under its cap. */
const FILL: Record<string, string> = {
  ok: 'var(--color-accent)',
  warn: 'var(--color-warning)',
  at_cap: 'var(--color-error)',
};

/**
 * One ledger line as a filled gauge against its cap. The fill stops at the cap
 * (an over-cap line reads at_cap and its number says how far over); the text is
 * the tiles' own `amount` so the Table view shows the same figures.
 */
export function SpendGauge({ line }: { line: SpendLine }) {
  const tone = SPEND_TONE[line.status] ?? 'neutral';
  const muted = tone === 'muted';
  const pct = line.pct ?? (line.actual != null && line.cap ? (line.actual / line.cap) * 100 : null);
  const width = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  return (
    <div id={`spend-${line.id}`} className="flex flex-col gap-1 min-w-0" data-spend-gauge={line.id} data-status={line.status}>
      <div className="flex items-baseline gap-2 min-w-0 text-ui-12">
        <span className="font-medium truncate" style={{ color: 'var(--color-text)' }} title={line.scope ?? undefined}>
          {line.id}
        </span>
        <span className="ml-auto tabular-nums whitespace-nowrap" style={{ color: muted ? 'var(--color-text-tertiary)' : 'var(--color-text)' }}>
          {amount(line.actual, line.unit)}
          <span style={{ color: 'var(--color-text-tertiary)' }}> / {line.cap == null ? 'no cap' : amount(line.cap, line.unit)}</span>
        </span>
        {pct != null && (
          <span className="tabular-nums text-ui-11 w-14 text-right" style={{ color: 'var(--color-text-secondary)' }}>
            {pct.toFixed(1)} %
          </span>
        )}
        {line.status !== 'ok' && <Chip tone={tone}>{line.status.replace('_', ' ')}</Chip>}
      </div>
      <div
        className="relative h-2.5 rounded"
        style={{ background: 'var(--color-bg-secondary)', border: muted ? '1px dashed var(--color-border)' : 'none' }}
        role="meter"
        aria-label={`${line.id} ${pct == null ? 'not measured' : `${pct.toFixed(1)} % of cap`}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct == null ? undefined : Math.round(pct)}
      >
        {!muted && width > 0 && (
          <span className="absolute inset-y-0 left-0 rounded" style={{ width: `${width}%`, background: FILL[line.status] ?? 'var(--color-accent)' }} />
        )}
        {/* The 80 % alert level, as the ledger's spend_cap alerts use it. */}
        {line.cap != null && <span className="absolute inset-y-0 w-px" style={{ left: '80%', background: 'var(--color-text-tertiary)', opacity: 0.6 }} title="80 % alert level" />}
      </div>
      {line.status === 'not_read' && line.not_read && (
        <span className="text-ui-11" style={{ color: 'var(--color-text-tertiary)' }}>
          not read: {line.not_read}
        </span>
      )}
      {line.top_episode && (
        <span className="text-ui-11 truncate" style={{ color: 'var(--color-text-secondary)' }}>
          top episode: {line.top_episode}
        </span>
      )}
    </div>
  );
}

export interface BurnPoint {
  day: number;
  aws?: number;
  bedrock?: number;
  awsForecast?: number;
  bedrockForecast?: number;
}

/**
 * The month's burn from the cost reader's three real numbers per series: zero on
 * the 1st, the month to date today, and AWS's own forecast at month end. Between
 * them the lines are straight: the average pace, not a daily series (the feed
 * carries none). Null until the reader has a total.
 */
export function burnPoints(reader: CostReader | null | undefined, now: number): { points: BurnPoint[]; today: number; days: number } | null {
  if (!reader?.configured || reader.total == null) return null;
  const d = new Date(now);
  const days = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  const today = d.getDate();
  const start: BurnPoint = { day: 0, aws: 0, ...(reader.bedrock != null ? { bedrock: 0 } : {}) };
  const mid: BurnPoint = {
    day: today,
    aws: reader.total,
    ...(reader.bedrock != null ? { bedrock: reader.bedrock } : {}),
    ...(reader.forecast_total != null ? { awsForecast: reader.total } : {}),
    ...(reader.forecast_bedrock != null && reader.bedrock != null ? { bedrockForecast: reader.bedrock } : {}),
  };
  const end: BurnPoint = {
    day: days,
    ...(reader.forecast_total != null ? { awsForecast: reader.forecast_total } : {}),
    ...(reader.forecast_bedrock != null ? { bedrockForecast: reader.forecast_bedrock } : {}),
  };
  const points = [start, mid, ...(end.awsForecast != null || end.bedrockForecast != null ? [end] : [])];
  return { points, today, days };
}

/** Four round steps from 0 that clear `top`: 1, 2, 2.5 or 5 times a power of ten. */
export function niceTicks(top: number): number[] {
  const t = Math.max(top, 1);
  const mag = 10 ** Math.floor(Math.log10(t / 4));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s * 4 >= t * 1.04) ?? 10 * mag;
  return [0, 1, 2, 3, 4].map((i) => Number((i * step).toFixed(2)));
}

const SERIES = [
  { key: 'aws', forecast: 'awsForecast', label: 'AWS total', color: 'var(--viz-series-1)', cap: 'aws-total' },
  { key: 'bedrock', forecast: 'bedrockForecast', label: 'Bedrock', color: 'var(--viz-series-2)', cap: 'bedrock-all' },
] as const;

function BurnChart({ ledger, now }: { ledger: SpendLedger; now: number }) {
  const burn = burnPoints(ledger.cost_reader, now);
  if (!burn) return <Quiet>{ledger.cost_reader?.configured === false ? 'The AWS cost reader isn’t configured.' : 'No AWS month to date read yet.'}</Quiet>;
  const caps = SERIES.map((s) => ({ ...s, line: ledger.lines.find((l) => l.id === s.cap && l.period === 'month' && l.cap != null) }));
  const r = ledger.cost_reader!;
  const shown = SERIES.filter((s) => burn.points.some((p) => p[s.key] != null));
  const capLines = caps.filter((c) => c.line && shown.some((s) => s.key === c.key));
  // The y range takes in the caps, so a cap above this month's burn still shows.
  const top = Math.max(
    ...burn.points.flatMap((p) => [p.aws ?? 0, p.awsForecast ?? 0, p.bedrock ?? 0, p.bedrockForecast ?? 0]),
    ...capLines.map((c) => c.line!.cap!),
  );
  const yTicks = niceTicks(top);
  return (
    <div className="flex flex-col gap-2" data-burn-chart>
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-ui-12" data-burn-legend>
        {shown.map((s) => {
          const mtd = s.key === 'aws' ? r.total : r.bedrock;
          const fc = s.key === 'aws' ? r.forecast_total : r.forecast_bedrock;
          return (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <span className="inline-block w-4 border-t-2" style={{ borderColor: s.color }} aria-hidden />
              <span style={{ color: 'var(--color-text)' }}>{s.label}</span>
              <span className="tabular-nums" style={{ color: 'var(--color-text-secondary)' }}>
                {amount(mtd, 'usd')} to date · forecast {amount(fc, 'usd')}
              </span>
            </span>
          );
        })}
        <span className="inline-flex items-center gap-1.5 text-ui-11" style={{ color: 'var(--color-text-tertiary)' }}>
          <span className="inline-block w-4 border-t-2 border-dashed" style={{ borderColor: 'var(--color-text-tertiary)' }} aria-hidden />
          forecast
        </span>
      </div>
      <div style={{ height: 300 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={burn.points} margin={{ top: 12, right: 16, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
            <XAxis
              dataKey="day"
              type="number"
              domain={[0, burn.days]}
              ticks={[0, burn.today, burn.days]}
              tickFormatter={(d: number) => (d === 0 ? '1st' : d === burn.today ? 'today' : `${d}th`)}
              tick={{ fontSize: 10, fill: 'var(--color-text-tertiary)' }}
            />
            <YAxis domain={[0, yTicks[yTicks.length - 1]]} ticks={yTicks} tickFormatter={(v: number) => `$${v}`} tick={{ fontSize: 10, fill: 'var(--color-text-tertiary)' }} width={56} />
            <Tooltip
              formatter={(v, name) => [amount(Number(v), 'usd'), String(name)]}
              labelFormatter={(d) => (Number(d) === 0 ? 'Start of month' : Number(d) === burn.today ? 'Today' : 'Month end (forecast)')}
              contentStyle={{
                background: 'var(--color-surface)',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-md)',
                fontSize: 12,
                color: 'var(--color-text)',
              }}
            />
            <ReferenceLine x={burn.today} stroke="var(--color-text-tertiary)" strokeDasharray="2 3" />
            {capLines.map((c) => (
                <ReferenceLine
                  key={`cap-${c.key}`}
                  y={c.line!.cap!}
                  stroke={c.color}
                  strokeDasharray="6 4"
                  strokeOpacity={0.7}
                  label={{ value: `${c.label} cap ${amount(c.line!.cap, 'usd')}`, position: 'insideTopLeft', fontSize: 10, fill: 'var(--color-text-secondary)' }}
                />
              ))}
            {shown.map((s) => (
              <Line key={s.key} name={`${s.label} to date`} dataKey={s.key} stroke={s.color} strokeWidth={2} dot={{ r: 4, strokeWidth: 2, stroke: 'var(--color-surface)', fill: s.color }} connectNulls isAnimationActive={false} />
            ))}
            {shown.map((s) => (
              <Line
                key={s.forecast}
                name={`${s.label} forecast`}
                dataKey={s.forecast}
                stroke={s.color}
                strokeWidth={2}
                strokeDasharray="5 4"
                dot={{ r: 4, strokeWidth: 2, stroke: 'var(--color-surface)', fill: 'var(--color-surface)' }}
                connectNulls
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <p className="text-ui-10-5" style={{ color: 'var(--color-text-tertiary)' }}>
        Straight lines between the 1st, today and AWS’s month-end forecast: the average pace, not a daily series.
        {r.calls_month != null ? ` ${r.calls_month} cost reads this month.` : ''}
        {r.error && <span style={{ color: 'var(--color-warning)' }}> Reader error: {r.error}</span>}
      </p>
    </div>
  );
}

export interface SpendBurnViewProps {
  ledger: SpendLedger | null;
  loading?: boolean;
  error?: string | null;
  now: number;
  initialView?: SpendView;
}

/**
 * Ops row 2, wide and tall (widescreen plan 5.3): the spend ledger as gauges, one
 * per line grouped by period, with the AWS and Bedrock month-to-date burn above them
 * and the current alerts beneath. "Table" shows the ledger tiles: the same figures.
 * Read only: the ledger is the operator's file in hq.
 */
export function SpendBurnView({ ledger, loading, error, now, initialView = 'gauges' }: SpendBurnViewProps) {
  const [view, setView] = useState<SpendView>(initialView);
  const groups = groupLines(ledger?.lines ?? []);
  const alerts = ledger?.alerts ?? [];
  return (
    <DashboardPanel
      icon={Wallet}
      title="Spend burn"
      tag="read only"
      size="wide"
      band="tall"
      priority={alerts.some((a) => a.lane === 'act')}
      loading={loading && !ledger}
      error={!ledger ? error : null}
      headerExtra={
        <Segmented<SpendView>
          ariaLabel="Spend view"
          value={view}
          onChange={setView}
          options={[
            { value: 'gauges', label: 'Gauges' },
            { value: 'table', label: 'Table' },
          ]}
        />
      }
    >
      {view === 'table' ? (
        <SpendLedgerBody ledger={ledger} />
      ) : !ledger ? (
        <Quiet>No spend ledger read yet.</Quiet>
      ) : ledger.status === 'no_ledger' ? (
        <Quiet>No ledger: Hermes found no spend file to read.</Quiet>
      ) : (
        <div className="flex flex-col gap-4" data-spend-view="gauges">
          <BurnChart ledger={ledger} now={now} />
          {(ledger.parse_errors ?? []).length > 0 && (
            <p role="alert" className="text-ui-12" style={{ color: 'var(--color-warning)' }}>
              The ledger has lines Hermes couldn’t read: {ledger.parse_errors.join('; ')}
            </p>
          )}
          <div className="grid grid-cols-1 3xl:grid-cols-2 gap-x-6 gap-y-4">
            {groups.map(([period, lines]) => (
              <section key={period} className="flex flex-col gap-2" data-period={period}>
                <span className="text-ui-10 uppercase tracking-wide" style={{ color: 'var(--color-text-tertiary)' }}>
                  {PERIOD_LABEL[period] ?? period}
                </span>
                {lines.map((l) => (
                  <SpendGauge key={l.id} line={l} />
                ))}
              </section>
            ))}
          </div>
          {alerts.length > 0 && (
            <section className="flex flex-col gap-1.5" data-spend-alerts>
              <span className="text-ui-10 uppercase tracking-wide" style={{ color: 'var(--color-text-tertiary)' }}>
                Alerts this period
              </span>
              <ul className="flex flex-col gap-2">
                {alerts.map((a, i) => (
                  <AlertRow key={`${a.line}-${a.period}-${a.action ?? a.level}-${i}`} alert={a} />
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </DashboardPanel>
  );
}
