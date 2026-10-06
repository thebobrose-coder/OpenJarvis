import { Bell, ListOrdered } from 'lucide-react';
import { recentEvents, sleeveLabel, type TradingStatus } from '../../lib/trading-api';
import { DashboardPanel } from '../Dashboard/DashboardPanel';
import { shortDateTime } from '../shared/format';
import { Chip, Quiet, type Tone } from '../shared/ui';

/** Event types as chip tones: the two halt states a human must act on in
 * the status palette, the rest neutral. */
export function eventTone(type: string): Tone {
  switch (type) {
    case 'KILL':
      return 'error';
    case 'DEGRADED':
    case 'ALERT':
    case 'RECONCILE_DIFF':
      return 'warning';
    case 'DEGRADED_CLEARED':
    case 'FILL':
      return 'success';
    case 'HITL':
    case 'PROPOSAL':
    case 'GATE':
      return 'accent';
    default:
      return 'muted';
  }
}

/** The last 20 non-TICK events across sleeves, and the alerts of the last 24 hours. */
export function EventsPanel({ status, loading, error }: { status: TradingStatus | null; loading?: boolean; error?: string | null }) {
  const events = status ? recentEvents(status) : [];
  const alerts = status?.alerts_24h ?? [];
  return (
    <>
      <DashboardPanel icon={ListOrdered} title="Events" tag="Last 20" size="half" loading={loading} error={error}>
        {events.length === 0 ? (
          <Quiet>No events reported.</Quiet>
        ) : (
          <ul className="flex flex-col gap-1 text-[12px]" data-events>
            {events.map((e, i) => (
              <li key={`${e.ts}-${i}`} className="flex flex-wrap items-baseline gap-2" data-event-type={e.type}>
                <span className="tabular-nums shrink-0" style={{ color: 'var(--color-text-tertiary)' }}>
                  {shortDateTime(e.ts)}
                </span>
                <Chip tone={eventTone(e.type)}>{e.type}</Chip>
                <span style={{ color: 'var(--color-text-tertiary)' }}>{sleeveLabel(e.sleeve)}</span>
                {e.summary && <span style={{ color: 'var(--color-text)' }}>{e.summary}</span>}
              </li>
            ))}
          </ul>
        )}
      </DashboardPanel>
      <DashboardPanel icon={Bell} title="Alerts" tag="Last 24 h" size="half" loading={loading} error={error}>
        {alerts.length === 0 ? (
          <Quiet>No alerts in the last 24 hours.</Quiet>
        ) : (
          <ul className="flex flex-col gap-1 text-[12px]" data-alerts>
            {alerts.map((a, i) => (
              <li key={`${a.ts}-${i}`} className="flex flex-wrap items-baseline gap-2">
                <span className="tabular-nums shrink-0" style={{ color: 'var(--color-text-tertiary)' }}>
                  {shortDateTime(a.ts)}
                </span>
                {a.source && <Chip tone="muted">{a.source}</Chip>}
                <span style={{ color: 'var(--color-text)' }}>{a.message}</span>
              </li>
            ))}
          </ul>
        )}
      </DashboardPanel>
    </>
  );
}
