import { Lightbulb, ScrollText } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { BdProspects, EngagementStats, StatsLine, Template } from '../../lib/bizdev-api';
import { templateSourceId } from '../../lib/bizdev-compose';
import { DashboardPanel } from '../Dashboard/DashboardPanel';
import { num, shortDateTime } from '../shared/format';
import { Quiet, Tile } from '../shared/ui';
import { STAGE_LABELS } from './PipelineBoard';

const FUNNEL = ['new', 'drafted', 'sent', 'replied', 'meeting', 'won'] as const;
const INSIGHTS_MIN_SENT = 5;

const pct = (n?: number | null) => (n == null ? '—' : `${Math.round(n * 100)}%`);

const hours = (h?: number | null) => (h == null ? '—' : h < 48 ? `${num(h, 1)} h` : `${num(h / 24, 1)} d`);

/** `hermes` -> "Hermes draft", `template:7` -> the template's name. */
export function sourceLabel(source: string, templates: Template[] | undefined): string {
  if (source === 'hermes') return 'Hermes draft';
  const id = templateSourceId(source);
  return templates?.find((t) => t.id === id)?.name ?? source;
}

/** Part B: `bd_stats.engagement` (delivery, non-proxy opens, replies by touch
 * and by draft source; the send-slot table only once Hermes publishes it). */
export function EngagementStatsBlock({ e, templates }: { e: EngagementStats; templates?: Template[] }) {
  const byTouch = e.reply_rate_by_touch ?? {};
  const bySource = Object.entries(e.reply_rate_by_draft_source ?? {});
  const slots = e.reply_rate_by_send_slot ?? [];
  return (
    <div className="flex flex-col gap-2" data-engagement-stats>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Tile label="Sends" value={num(e.sends ?? 0)} />
        <Tile label="Delivered" value={pct(e.delivery_rate)} />
        <Tile label="Opened" value={pct(e.open_rate_nonproxy)} sub="not counting mail proxies" />
        <Tile label="Time to reply" value={hours(e.median_time_to_reply_h)} sub="median" />
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11.5px]">
        {(['1', '2', '3'] as const).map((t) => (
          <span key={t}>
            touch {t} replies {pct(byTouch[t])}
          </span>
        ))}
        <span>bounces this week {pct(e.bounce_rate_week)}</span>
      </div>
      {bySource.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11.5px]">
          {bySource.map(([source, rate]) => (
            <span key={source}>
              {sourceLabel(source, templates)} replies {pct(rate)}
            </span>
          ))}
        </div>
      )}
      {slots.length > 0 && (
        <table className="w-full text-[12px] tabular-nums">
          <thead>
            <tr style={{ color: 'var(--color-text-tertiary)' }}>
              <th className="py-1 px-2 text-left font-medium">Sent (Central)</th>
              <th className="py-1 px-2 text-right font-medium">Sent</th>
              <th className="py-1 px-2 text-right font-medium">Replies</th>
            </tr>
          </thead>
          <tbody>
            {slots.map((r) => (
              <tr key={`${r.dow}-${r.hour_bucket}`} style={{ borderTop: '1px solid var(--color-border)' }}>
                <td className="py-1 px-2">
                  {r.dow} {r.hour_bucket}
                </td>
                <td className="py-1 px-2 text-right">{num(r.sent)}</td>
                <td className="py-1 px-2 text-right">{num(r.replied)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <span className="text-[10.5px]" style={{ color: 'var(--color-text-tertiary)' }}>
        {e.pulled_at ? `Engagement read ${shortDateTime(e.pulled_at)}` : 'Engagement isn’t being read yet.'}
      </span>
    </div>
  );
}

export function InsightsPanel({
  stats,
  loading,
  error,
  templates,
}: {
  stats: StatsLine | undefined;
  loading?: boolean;
  error?: string | null;
  templates?: Template[];
}) {
  const data = FUNNEL.map((s) => ({ stage: STAGE_LABELS[s], count: stats?.by_stage?.[s] ?? 0 }));
  const sent = (stats?.by_stage?.sent ?? 0) + (stats?.by_stage?.replied ?? 0) + (stats?.by_stage?.meeting ?? 0) + (stats?.by_stage?.won ?? 0) + (stats?.by_stage?.lost ?? 0);
  const insights = stats?.signal_insights ?? [];

  return (
    <DashboardPanel icon={Lightbulb} title="Insights" tag="Daily" size="half" loading={loading} error={error}>
      {!stats ? (
        <Quiet>No stats yet -- Hermes computes them daily.</Quiet>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="h-44">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -18 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
                <XAxis dataKey="stage" tick={{ fontSize: 10, fill: 'var(--color-text-tertiary)' }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: 'var(--color-text-tertiary)' }} />
                <Tooltip
                  cursor={{ fill: 'var(--color-bg-secondary)' }}
                  contentStyle={{
                    background: 'var(--color-surface)',
                    border: '1px solid var(--color-border)',
                    borderRadius: 'var(--radius-md)',
                    fontSize: 12,
                    color: 'var(--color-text)',
                  }}
                />
                <Bar dataKey="count" fill="var(--color-accent)" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11.5px]">
            <span>sent → replied {pct(stats.conversion?.sent_to_replied)}</span>
            <span>replied → meeting {pct(stats.conversion?.replied_to_meeting)}</span>
            <span>meeting → won {pct(stats.conversion?.meeting_to_won)}</span>
          </div>
          {stats.engagement && (stats.engagement.sends ?? 0) > 0 && (
            <EngagementStatsBlock e={stats.engagement} templates={templates} />
          )}
          {insights.length === 0 || sent < INSIGHTS_MIN_SENT ? (
            <Quiet>Signal insights appear once at least {INSIGHTS_MIN_SENT} emails have been sent.</Quiet>
          ) : (
            <table className="w-full text-[12px] tabular-nums">
              <thead>
                <tr style={{ color: 'var(--color-text-tertiary)' }}>
                  <th className="py-1 px-2 text-left font-medium">Signal</th>
                  <th className="py-1 px-2 text-right font-medium">Prospects</th>
                  <th className="py-1 px-2 text-right font-medium">Replies</th>
                  <th className="py-1 px-2 text-right font-medium">Reply rate</th>
                </tr>
              </thead>
              <tbody>
                {insights.map((s) => (
                  <tr key={s.signal} style={{ borderTop: '1px solid var(--color-border)' }}>
                    <td className="py-1 px-2">{s.signal}</td>
                    <td className="py-1 px-2 text-right">{num(s.prospects)}</td>
                    <td className="py-1 px-2 text-right">{num(s.replied)}</td>
                    <td className="py-1 px-2 text-right">{pct(s.reply_rate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </DashboardPanel>
  );
}

/** This week's skipped schools and errors, for transparency. */
export function ResearchLog({ prospects, loading, error }: { prospects: BdProspects | null; loading?: boolean; error?: string | null }) {
  const skipped = prospects?.skipped ?? [];
  const errors = prospects?.errors ?? [];
  return (
    <DashboardPanel icon={ScrollText} title="Research log" tag={prospects?.week ?? 'Weekly'} size="half" loading={loading} error={error}>
      {!prospects ? (
        <Quiet>No research batch yet.</Quiet>
      ) : (
        <div className="flex flex-col gap-2">
          <span className="text-[11.5px]">
            {num(prospects.counts?.surfaced ?? prospects.prospects.length)} surfaced · {num(prospects.counts?.with_contacts)} with contacts ·{' '}
            {num(prospects.counts?.with_draft)} drafted
          </span>
          <details>
            <summary className="cursor-pointer text-[11.5px]" style={{ color: 'var(--color-text-tertiary)' }}>
              Skipped ({skipped.length})
            </summary>
            <ul className="mt-1 flex flex-col gap-0.5 pl-3">
              {skipped.map((s, i) => (
                <li key={i}>
                  <span style={{ color: 'var(--color-text)' }}>{s.name}</span> -- {s.reason}
                </li>
              ))}
            </ul>
          </details>
          <details>
            <summary className="cursor-pointer text-[11.5px]" style={{ color: 'var(--color-text-tertiary)' }}>
              Errors ({errors.length})
            </summary>
            <ul className="mt-1 flex flex-col gap-0.5 pl-3">
              {errors.map((e, i) => (
                <li key={i}>
                  <span style={{ color: 'var(--color-text)' }}>{e.name}</span> -- {e.error}
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}
    </DashboardPanel>
  );
}
