import { useState } from 'react';
import { TrendingUp } from 'lucide-react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CURVE_DAYS, curveRows, curveSleeves, fmtMoney, sleeveLabel, type CurveRow, type TradingDay } from '../../lib/trading-api';
import { DashboardPanel } from '../Dashboard/DashboardPanel';
import { Quiet, Segmented } from '../shared/ui';

/** Categorical slots in fixed order (dataviz: assigned, never cycled). The
 * tokens are defined in index.css for both themes. */
export const SERIES_VAR = ['var(--viz-series-1)', 'var(--viz-series-2)', 'var(--viz-series-3)'];

const shortDate = (d: string) => {
  const t = Date.parse(`${d}T00:00:00Z`);
  return Number.isNaN(t) ? d : new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
};

/** The curve as a table, for the accessibility pass and for reading exact values. */
function CurveTable({ rows, sleeves }: { rows: CurveRow[]; sleeves: string[] }) {
  return (
    <div className="overflow-x-auto" style={{ maxHeight: '16rem' }}>
      <table className="w-full text-[11.5px] tabular-nums" data-curve-table>
        <thead>
          <tr className="text-left" style={{ color: 'var(--color-text-tertiary)' }}>
            <th className="font-normal pr-3 pb-1">Day</th>
            {sleeves.map((s) => (
              <th key={s} className="font-normal pr-3 pb-1">
                {sleeveLabel(s)}
              </th>
            ))}
            {sleeves.map((s) => (
              <th key={`${s}-r`} className="font-normal pr-3 pb-1">
                {sleeveLabel(s)} realized
              </th>
            ))}
          </tr>
        </thead>
        <tbody style={{ color: 'var(--color-text)' }}>
          {[...rows].reverse().map((r) => (
            <tr key={r.date} style={{ borderTop: '1px solid var(--color-border)' }}>
              <td className="pr-3 py-0.5">{r.date}</td>
              {sleeves.map((s) => (
                <td key={s} className="pr-3">
                  {fmtMoney(r[s] as number | null)}
                </td>
              ))}
              {sleeves.map((s) => (
                <td key={`${s}-r`} className="pr-3">
                  {fmtMoney(r[`${s}_realized`] as number | null)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Paper equity per sleeve from the nightly reports (0014 D3: shown from
 * day one; a flat line is information). Mark-to-market equity is the solid
 * line, realized equity the dashed lighter one in the same hue, so the pair
 * is told apart by more than color. */
export function EquityCurve({ day, loading, error }: { day: TradingDay | null; loading?: boolean; error?: string | null }) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const rows = curveRows(day);
  const sleeves = curveSleeves(rows);
  const hasMarked = rows.some((r) => sleeves.some((s) => r[s] != null));
  const single = rows.length === 1;
  return (
    <DashboardPanel
      icon={TrendingUp}
      title="Equity curve"
      tag={rows.length ? `${rows.length} of ${CURVE_DAYS} days` : `${CURVE_DAYS} days`}
      size="full"
      loading={loading}
      error={error}
      actions={
        rows.length > 0 ? (
          <Segmented
            ariaLabel="Curve view"
            value={view}
            onChange={setView}
            options={[
              { value: 'chart', label: 'Chart' },
              { value: 'table', label: 'Table' },
            ]}
          />
        ) : undefined
      }
    >
      {rows.length === 0 ? (
        <Quiet>No nightly report yet. The curve starts with the first one.</Quiet>
      ) : (
        <div className="flex flex-col gap-2" data-equity-curve={rows.length}>
          <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]" data-curve-legend style={{ color: 'var(--color-text-secondary)' }}>
            {sleeves.map((s, i) => (
              <li key={s} className="inline-flex items-center gap-1.5">
                <span className="inline-block w-4 border-t-2" style={{ borderColor: SERIES_VAR[i] ?? SERIES_VAR[0] }} aria-hidden />
                {sleeveLabel(s)}
                {hasMarked ? ' equity' : ' realized equity'}
              </li>
            ))}
            {hasMarked &&
              sleeves.map((s, i) => (
                <li key={`${s}-r`} className="inline-flex items-center gap-1.5">
                  <span className="inline-block w-4 border-t-2 border-dashed" style={{ borderColor: SERIES_VAR[i] ?? SERIES_VAR[0], opacity: 0.7 }} aria-hidden />
                  {sleeveLabel(s)} realized
                </li>
              ))}
          </ul>
          {view === 'table' ? (
            <CurveTable rows={rows} sleeves={sleeves} />
          ) : (
            <div style={{ height: 220 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke="var(--color-border)" vertical={false} />
                  <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fontSize: 10, fill: 'var(--color-text-tertiary)' }} axisLine={false} tickLine={false} minTickGap={24} />
                  <YAxis
                    domain={['auto', 'auto']}
                    tick={{ fontSize: 10, fill: 'var(--color-text-tertiary)' }}
                    axisLine={false}
                    tickLine={false}
                    width={64}
                    tickFormatter={(v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  />
                  <Tooltip
                    cursor={{ stroke: 'var(--color-text-tertiary)', strokeDasharray: '3 3' }}
                    contentStyle={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 8, fontSize: 11, color: 'var(--color-text)' }}
                    labelStyle={{ color: 'var(--color-text-secondary)' }}
                    formatter={(value, name) => [fmtMoney(value as number), String(name).endsWith('_realized') ? `${sleeveLabel(String(name).replace(/_realized$/, ''))} realized` : sleeveLabel(String(name))]}
                  />
                  {sleeves.map((s, i) => (
                    <Line
                      key={s}
                      type="monotone"
                      dataKey={hasMarked ? s : `${s}_realized`}
                      name={hasMarked ? s : `${s}_realized`}
                      stroke={SERIES_VAR[i] ?? SERIES_VAR[0]}
                      strokeWidth={2}
                      dot={single ? { r: 4 } : false}
                      activeDot={{ r: 4 }}
                      connectNulls
                      isAnimationActive={false}
                    />
                  ))}
                  {hasMarked &&
                    sleeves.map((s, i) => (
                      <Line
                        key={`${s}-r`}
                        type="monotone"
                        dataKey={`${s}_realized`}
                        name={`${s}_realized`}
                        stroke={SERIES_VAR[i] ?? SERIES_VAR[0]}
                        strokeOpacity={0.7}
                        strokeWidth={1.5}
                        strokeDasharray="4 3"
                        dot={single ? { r: 3 } : false}
                        activeDot={{ r: 3 }}
                        connectNulls
                        isAnimationActive={false}
                      />
                    ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
          {single && (
            <Quiet>One day so far. The line grows with each nightly report.</Quiet>
          )}
        </div>
      )}
    </DashboardPanel>
  );
}
