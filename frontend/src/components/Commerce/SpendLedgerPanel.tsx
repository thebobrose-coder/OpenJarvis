import { Wallet } from 'lucide-react';
import type { CostReader, SpendAlert, SpendLedger, SpendLine } from '../../lib/commerce-api';
import { DashboardPanel } from '../Dashboard/DashboardPanel';
import { shortDateTime } from './format';
import { Chip, Quiet, type Tone } from '../shared/ui';

/**
 * The spend ledger, read-only (contract v1.29 §4.8, hq 0028 Part 6 and A1):
 * one tile per line of the operator's `hq/ledger/spend.md`, grouped by period,
 * with Hermes's actuals, the cost reader's month to date and forecast, and
 * the current periods' alerts. The ledger is the operator's file: nothing
 * here edits it or links to anything that does.
 */

export const SPEND_TONE: Record<string, Tone> = {
  ok: 'neutral',
  warn: 'warning',
  at_cap: 'error',
  untracked: 'muted',
  not_read: 'muted',
};

/** The periods in the order the tiles show them; others follow as listed. */
const PERIOD_ORDER = ['day', 'month', 'flight', 'episode'];
export const PERIOD_LABEL: Record<string, string> = {
  day: 'Per day',
  month: 'Per month',
  flight: 'Per flight',
  episode: 'Per episode',
};

/** One amount in its unit: "$30.20", "16 units". */
export function amount(n: number | null | undefined, unit: string): string {
  if (n == null) return '—';
  if (unit === 'usd') return `$${n.toFixed(2)}`;
  return `${Number.isInteger(n) ? n.toLocaleString() : n.toFixed(2)} ${unit}`;
}

/** The lines grouped by period, in PERIOD_ORDER then first appearance. */
export function groupLines(lines: SpendLine[]): [string, SpendLine[]][] {
  const groups = new Map<string, SpendLine[]>();
  for (const l of lines) groups.set(l.period, [...(groups.get(l.period) ?? []), l]);
  const rank = (p: string) => {
    const i = PERIOD_ORDER.indexOf(p);
    return i < 0 ? PERIOD_ORDER.length : i;
  };
  return [...groups.entries()].sort(([a], [b]) => rank(a) - rank(b));
}

export function LineTile({ line }: { line: SpendLine }) {
  const tone = SPEND_TONE[line.status] ?? 'neutral';
  const border = tone === 'warning' ? 'var(--color-warning)' : tone === 'error' ? 'var(--color-error)' : 'transparent';
  const muted = tone === 'muted';
  return (
    <div
      id={`spend-${line.id}`}
      className="flex flex-col gap-1 rounded-lg px-3 py-2 min-w-0"
      style={{ background: 'var(--color-bg-secondary)', border: `1px solid ${border}` }}
      data-spend-line={line.id}
      data-status={line.status}
    >
      <span className="flex items-center gap-1.5 min-w-0">
        <span className="text-ui-11 font-medium truncate" style={{ color: 'var(--color-text)' }} title={line.scope ?? undefined}>
          {line.id}
        </span>
        <span className="ml-auto">
          <Chip tone={tone}>{line.status.replace('_', ' ')}</Chip>
        </span>
      </span>
      <span className="text-ui-13 tabular-nums" style={{ color: muted ? 'var(--color-text-tertiary)' : 'var(--color-text)' }}>
        {amount(line.actual, line.unit)}
        <span style={{ color: 'var(--color-text-tertiary)' }}> / {line.cap == null ? 'no cap' : amount(line.cap, line.unit)}</span>
        {line.pct != null && (
          <span className="ml-1.5 text-ui-11" style={{ color: 'var(--color-text-secondary)' }}>
            {line.pct.toFixed(1)} %
          </span>
        )}
      </span>
      {line.status === 'not_read' && line.not_read && (
        <span className="text-ui-11" style={{ color: 'var(--color-text-tertiary)' }}>
          not read: {line.not_read}
        </span>
      )}
      {line.alerts === 'campaign_cap' && (
        <span className="text-ui-10-5" style={{ color: 'var(--color-text-tertiary)' }} title="Its alerts come from campaign_daily, not from the ledger">
          alerts: campaign cap
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

/** The cost reader's line under the AWS lines (month to date, forecast, calls, error). */
export function CostReaderLine({ reader }: { reader: CostReader | null | undefined }) {
  if (!reader) return null;
  if (!reader.configured) return <Quiet>cost reader not configured</Quiet>;
  return (
    <p className="text-ui-11 tabular-nums" style={{ color: 'var(--color-text-tertiary)' }} data-cost-reader>
      AWS month to date {amount(reader.total, 'usd')} (Bedrock {amount(reader.bedrock, 'usd')}) · forecast {amount(reader.forecast_total, 'usd')}{' '}
      (Bedrock {amount(reader.forecast_bedrock, 'usd')}) · read {reader.read_at ? shortDateTime(reader.read_at) : '—'}
      {reader.calls_month != null ? ` · ${reader.calls_month} calls this month` : ''}
      {reader.error && <span style={{ color: 'var(--color-warning)' }}> · error {reader.error}</span>}
    </p>
  );
}

export function AlertRow({ alert }: { alert: SpendAlert }) {
  const paused = alert.action === 'studio_paused';
  const tone: Tone = paused || alert.level === 100 ? 'error' : alert.lane === 'act' ? 'warning' : 'muted';
  const color = tone === 'error' ? 'var(--color-error)' : tone === 'warning' ? 'var(--color-warning)' : 'var(--color-text-secondary)';
  return (
    <li className="flex flex-col gap-0.5 text-ui-12" style={{ color }} data-spend-alert={alert.line} data-action={alert.action ?? ''}>
      <span className="flex flex-wrap items-center gap-1.5">
        <Chip tone={tone}>{paused ? 'studio paused' : alert.action === 'budget_filter' ? 'budget filter' : alert.level != null ? `${alert.level} %` : alert.lane}</Chip>
        <span>{alert.line}</span>
        <span style={{ color: 'var(--color-text-tertiary)' }}>{alert.period}</span>
        {alert.raised_at && <span className="text-ui-11" style={{ color: 'var(--color-text-tertiary)' }}>{shortDateTime(alert.raised_at)}</span>}
      </span>
      <span>{alert.message}</span>
      {paused && (
        <span>
          Paused: {(alert.paused ?? []).join(', ') || '—'}, until you delete the flags in <code>_data\studio\pause\</code>.
        </span>
      )}
    </li>
  );
}

export interface SpendLedgerPanelProps {
  ledger: SpendLedger | null;
  loading?: boolean;
  error?: string | null;
  tag?: string;
  dim?: boolean;
}

/** The ledger's tiles by period, the cost reader line, the alerts and the
 * footer: the Spend ledger panel's body, and the Ops Spend burn's Table view. */
export function SpendLedgerBody({ ledger }: { ledger: SpendLedger | null }) {
  const groups = groupLines(ledger?.lines ?? []);
  const errors = ledger?.parse_errors ?? [];
  const alerts = ledger?.alerts ?? [];
  return (
      <div id="spend-ledger" className="flex flex-col gap-3">
        {errors.length > 0 && (
          <p role="alert" className="text-ui-12" style={{ color: 'var(--color-warning)' }} data-parse-errors>
            The ledger has {errors.length === 1 ? 'a line' : `${errors.length} lines`} Hermes couldn’t read: {errors.join('; ')}
          </p>
        )}
        {!ledger ? (
          <Quiet>No spend ledger read yet.</Quiet>
        ) : ledger.status === 'no_ledger' ? (
          <Quiet>No ledger: Hermes found no spend file to read.</Quiet>
        ) : groups.length === 0 ? (
          <Quiet>The ledger has no lines.</Quiet>
        ) : (
          groups.map(([period, lines]) => (
            <div key={period} className="flex flex-col gap-1.5" data-period={period}>
              <span className="text-ui-10 uppercase tracking-wide" style={{ color: 'var(--color-text-tertiary)' }}>
                {PERIOD_LABEL[period] ?? period}
              </span>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                {lines.map((l) => (
                  <LineTile key={l.id} line={l} />
                ))}
              </div>
              {lines.some((l) => l.id === 'aws-total' || l.id === 'bedrock-all') && <CostReaderLine reader={ledger.cost_reader} />}
            </div>
          ))
        )}
        {ledger && !groups.some(([, ls]) => ls.some((l) => l.id === 'aws-total' || l.id === 'bedrock-all')) && ledger.status !== 'no_ledger' && (
          <CostReaderLine reader={ledger.cost_reader} />
        )}
        {alerts.length > 0 && (
          <div className="flex flex-col gap-1.5" data-spend-alerts>
            <span className="text-ui-10 uppercase tracking-wide" style={{ color: 'var(--color-text-tertiary)' }}>
              Alerts this period
            </span>
            <ul className="flex flex-col gap-2">
              {alerts.map((a, i) => (
                <AlertRow key={`${a.line}-${a.period}-${a.action ?? a.level}-${i}`} alert={a} />
              ))}
            </ul>
          </div>
        )}
        <Quiet>
          The ledger is your file in hq (<code>hq/ledger/spend.md</code>); edit it there. Hermes reads it each morning
          {ledger?.run_at ? `, last at ${shortDateTime(ledger.run_at)}` : ''}.
        </Quiet>
      </div>
  );
}

export function SpendLedgerPanel({ ledger, loading, error, tag = 'read only', dim }: SpendLedgerPanelProps) {
  return (
    <DashboardPanel icon={Wallet} title="Spend ledger" tag={tag} size="full" dim={dim} loading={loading && !ledger} error={error}>
      <SpendLedgerBody ledger={ledger} />
    </DashboardPanel>
  );
}
