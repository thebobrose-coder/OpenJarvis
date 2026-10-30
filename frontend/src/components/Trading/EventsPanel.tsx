import { useState } from 'react';
import { Bell, ListOrdered } from 'lucide-react';
import { localizeStamps, sleeveNames, tidyEvents, type TradingStatus } from '../../lib/trading-api';
import { DashboardPanel } from '../Dashboard/DashboardPanel';
import { shortDateTime } from '../shared/format';
import { Chip, Quiet, Segmented, type Tone } from '../shared/ui';
import { SleeveName } from './TradingHeader';

/** Event types as chip tones: the two halt states a human must act on in
 * the status palette, the rest neutral. A refused roll is a warning; the
 * other ROLL_* types and any type not listed here take the default. */
export function eventTone(type: string): Tone {
  switch (type) {
    case 'KILL':
      return 'error';
    case 'DEGRADED':
    case 'ALERT':
    case 'RECONCILE_DIFF':
    case 'ROLL_REFUSED':
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

// Columns: time, type, sleeve, then the text, which wraps in its own column.
const ROWS = 'grid grid-cols-[auto_auto_auto_minmax(0,1fr)] gap-x-2 gap-y-1.5 items-baseline text-[12px]';

/**
 * The last 20 events across sleeves, or one sleeve's, without repeats: a
 * SIGNAL shows as the reason under the PROPOSAL it led to, and an ALERT
 * already in the Alerts panel isn't listed twice, and back-to-back repeats
 * are one row with a count (`tidyEvents`). The alerts
 * of the last 24 hours sit beside it. Times are local.
 */
export function EventsPanel({ status, loading, error }: { status: TradingStatus | null; loading?: boolean; error?: string | null }) {
  const [only, setOnly] = useState<string>('all');
  const names = status ? sleeveNames(status) : [];
  const sleeve = only !== 'all' && names.includes(only) ? only : null;
  const events = status ? tidyEvents(status, sleeve) : [];
  const alerts = status?.alerts_24h ?? [];
  return (
    <>
      <DashboardPanel
        icon={ListOrdered}
        title="Events"
        tag="Last 20"
        size="half"
        loading={loading}
        error={error}
        actions={
          names.length > 1 ? (
            <Segmented
              ariaLabel="Events for"
              value={sleeve ?? 'all'}
              onChange={setOnly}
              options={[{ value: 'all', label: 'All' }, ...names.map((n) => ({ value: n, label: <SleeveName name={n} /> }))]}
            />
          ) : undefined
        }
      >
        {events.length === 0 ? (
          <Quiet>No events reported.</Quiet>
        ) : (
          <div className={ROWS} data-events>
            {events.map((e, i) => (
              <div key={`${e.ts}-${i}`} className="contents" data-event-type={e.type}>
                <span className="tabular-nums whitespace-nowrap" style={{ color: 'var(--color-text-tertiary)' }}>
                  {shortDateTime(e.ts)}
                </span>
                <span>
                  <Chip tone={eventTone(e.type)}>{e.type}</Chip>
                </span>
                <span className="whitespace-nowrap text-[11.5px]">
                  <SleeveName name={e.sleeve} muted />
                </span>
                <span className="min-w-0 break-words" style={{ color: 'var(--color-text)' }}>
                  {e.summary ? localizeStamps(e.summary) : ''}
                  {e.repeat && (
                    <span className="ml-1.5 text-[11px] whitespace-nowrap" data-event-repeat={e.repeat} style={{ color: 'var(--color-text-tertiary)' }}>
                      ×{e.repeat} since {shortDateTime(e.first_ts)}
                    </span>
                  )}
                  {e.reason && (
                    <span className="block text-[11px]" data-event-reason style={{ color: 'var(--color-text-tertiary)' }}>
                      {localizeStamps(e.reason)}
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </DashboardPanel>
      <DashboardPanel icon={Bell} title="Alerts" tag="Last 24 h" size="half" loading={loading} error={error}>
        {alerts.length === 0 ? (
          <Quiet>No alerts in the last 24 hours.</Quiet>
        ) : (
          <div className="grid grid-cols-[auto_auto_minmax(0,1fr)] gap-x-2 gap-y-1.5 items-baseline text-[12px]" data-alerts>
            {alerts.map((a, i) => (
              <div key={`${a.ts}-${i}`} className="contents">
                <span className="tabular-nums whitespace-nowrap" style={{ color: 'var(--color-text-tertiary)' }}>
                  {shortDateTime(a.ts)}
                </span>
                <span>{a.source && <Chip tone="muted">{a.source}</Chip>}</span>
                <span className="min-w-0 break-words" style={{ color: 'var(--color-text)' }}>
                  {localizeStamps(a.message)}
                </span>
              </div>
            ))}
          </div>
        )}
      </DashboardPanel>
    </>
  );
}
