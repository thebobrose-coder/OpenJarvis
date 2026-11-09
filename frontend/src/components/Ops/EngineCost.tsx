import { Cpu } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { DashboardPanel } from '../Dashboard/DashboardPanel';
import { Quiet } from '../shared/ui';

/** A header cost block: Content's proposals and each BizDev line carry one. */
export interface CostBlock {
  week_usd: number;
  month_usd: number;
  by_engine: Record<string, number>;
}

export interface CostSource {
  /** "Content", "BizDev · <line>". */
  label: string;
  cost: CostBlock;
}

/** The categorical slots in fixed order (validated light and dark); past them, "Other". */
export const ENGINE_SLOTS = ['var(--viz-series-1)', 'var(--viz-series-2)', 'var(--viz-series-3)', 'var(--viz-series-4)', 'var(--viz-series-5)'];
export const OTHER = 'Other';
const OTHER_COLOR = 'var(--color-text-tertiary)';

/**
 * Engines with any spend, biggest first, each with its slot; the free (local)
 * engines listed apart, since a zero-width bar can't show them. More engines
 * than slots fold into "Other" rather than a generated hue.
 */
export function engineSeries(sources: CostSource[]): { paid: { engine: string; usd: number; color: string }[]; free: string[] } {
  const totals = new Map<string, number>();
  for (const s of sources) for (const [e, usd] of Object.entries(s.cost.by_engine)) totals.set(e, (totals.get(e) ?? 0) + usd);
  const ranked = [...totals.entries()].filter(([, usd]) => usd > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const free = [...totals.entries()].filter(([, usd]) => usd <= 0).map(([e]) => e).sort();
  const fit = ranked.length > ENGINE_SLOTS.length ? ENGINE_SLOTS.length - 1 : ENGINE_SLOTS.length;
  const paid = ranked.slice(0, fit).map(([engine, usd], i) => ({ engine, usd, color: ENGINE_SLOTS[i] }));
  const rest = ranked.slice(fit);
  if (rest.length) paid.push({ engine: OTHER, usd: rest.reduce((n, [, u]) => n + u, 0), color: OTHER_COLOR });
  return { paid, free };
}

/** One chart row per source, a key per shown engine (Other summed). */
export function engineRows(sources: CostSource[], engines: string[]): Record<string, string | number>[] {
  return sources.map((s) => {
    const row: Record<string, string | number> = { source: s.label };
    for (const e of engines) row[e] = 0;
    for (const [e, usd] of Object.entries(s.cost.by_engine)) {
      if (usd <= 0) continue;
      const key = engines.includes(e) ? e : OTHER;
      row[key] = Number(row[key] ?? 0) + usd;
    }
    return row;
  });
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/**
 * Ops row 2, third and tall (widescreen plan 5.3): this month's model spend by
 * engine, stacked per source, from the cost blocks the Content and BizDev headers
 * already show. The legend carries each engine's total; the table under the chart
 * carries each source's month and week, so no figure depends on colour.
 */
export function EngineCostView({ sources, loading, error }: { sources: CostSource[]; loading?: boolean; error?: string | null }) {
  const { paid, free } = engineSeries(sources);
  const engines = paid.map((p) => p.engine);
  const rows = engineRows(sources, engines);
  const month = sources.reduce((n, s) => n + s.cost.month_usd, 0);
  return (
    <DashboardPanel icon={Cpu} title="Cost by engine" tag={sources.length ? `${usd(month)} this month` : undefined} size="third" band="tall" loading={loading && !sources.length} error={!sources.length ? error : null}>
      {!sources.length ? (
        <Quiet>No cost blocks yet: Content and BizDev publish them with their daily runs.</Quiet>
      ) : (
        <div className="flex flex-col gap-3" data-engine-cost>
          <ul className="flex flex-col gap-1 text-ui-12" data-engine-legend>
            {paid.map((p) => (
              <li key={p.engine} className="flex items-center gap-2">
                <span className="inline-block w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: p.color }} aria-hidden />
                <span style={{ color: 'var(--color-text)' }}>{p.engine}</span>
                <span className="ml-auto tabular-nums" style={{ color: 'var(--color-text-secondary)' }}>
                  {usd(p.usd)}
                </span>
              </li>
            ))}
            {free.length > 0 && (
              <li className="text-ui-11" style={{ color: 'var(--color-text-tertiary)' }}>
                Free / local: {free.join(', ')}
              </li>
            )}
          </ul>
          {paid.length > 0 ? (
            <div style={{ height: Math.max(120, rows.length * 56 + 32) }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 8, bottom: 0, left: 0 }} barCategoryGap={12}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" horizontal={false} />
                  <XAxis type="number" tickFormatter={(v: number) => `$${v}`} tick={{ fontSize: 10, fill: 'var(--color-text-tertiary)' }} />
                  <YAxis type="category" dataKey="source" width={110} tick={{ fontSize: 11, fill: 'var(--color-text-secondary)' }} />
                  <Tooltip
                    cursor={{ fill: 'var(--color-bg-secondary)' }}
                    formatter={(v, name) => [usd(Number(v)), String(name)]}
                    contentStyle={{
                      background: 'var(--color-surface)',
                      border: '1px solid var(--color-border)',
                      borderRadius: 'var(--radius-md)',
                      fontSize: 12,
                      color: 'var(--color-text)',
                    }}
                  />
                  {paid.map((p, i) => (
                    <Bar
                      key={p.engine}
                      dataKey={p.engine}
                      stackId="cost"
                      fill={p.color}
                      stroke="var(--color-surface)"
                      strokeWidth={2}
                      radius={i === paid.length - 1 ? [0, 4, 4, 0] : 0}
                      isAnimationActive={false}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <Quiet>Every engine this month was free / local.</Quiet>
          )}
          <table className="w-full text-ui-12 tabular-nums" data-engine-table>
            <thead>
              <tr style={{ color: 'var(--color-text-tertiary)' }}>
                <th className="py-1 pr-2 text-left font-medium">Source</th>
                <th className="py-1 px-2 text-right font-medium">This month</th>
                <th className="py-1 pl-2 text-right font-medium">This week</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.label} style={{ borderTop: '1px solid var(--color-border)' }}>
                  <td className="py-1 pr-2" style={{ color: 'var(--color-text)' }}>
                    {s.label}
                  </td>
                  <td className="py-1 px-2 text-right">{usd(s.cost.month_usd)}</td>
                  <td className="py-1 pl-2 text-right">{usd(s.cost.week_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </DashboardPanel>
  );
}
