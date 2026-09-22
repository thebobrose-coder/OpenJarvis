import { useCallback, useEffect, useState } from 'react';
import { CalendarClock } from 'lucide-react';
import { fetchDayAhead } from '../../lib/api';
import type { DayAhead } from '../../lib/api';
import { DashboardPanel } from './DashboardPanel';

const REFRESH_MS = 5 * 60 * 1000;

function formatEventTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function formatTaskDue(iso: string): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Live agenda panel -- next 24h of calendar events + all open tasks.
 * Deliberately uncached: a stale calendar is wrong, not just stale, so
 * this fetches fresh on mount and on a short interval rather than
 * following the narrated/cached pattern the other briefing panels use.
 * No regen button -- there's nothing to regenerate, it's always current.
 */
export function DayAheadPanel() {
  const [data, setData] = useState<DayAhead | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await fetchDayAhead();
      setData(d);
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, REFRESH_MS);
    return () => clearInterval(interval);
  }, [load]);

  const neitherConnected = data && !data.calendar_connected && !data.tasks_connected;

  return (
    <DashboardPanel icon={CalendarClock} title="Day Ahead" tag="Live" size="tall" priority loading={loading} error={error}>
      {neitherConnected ? (
        <p style={{ color: 'var(--color-text-tertiary)' }}>
          Connect Google Calendar and Google Tasks to populate this panel.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <div>
            {!data?.calendar_connected ? (
              <p style={{ color: 'var(--color-text-tertiary)' }}>Calendar not connected.</p>
            ) : data.events.length === 0 ? (
              <p style={{ color: 'var(--color-text-tertiary)' }}>Nothing on the calendar in the next 24 hours.</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {data.events.map((e) => (
                  <li key={e.id} className="flex items-baseline gap-2">
                    <span
                      className="shrink-0 font-mono text-[11px]"
                      style={{ color: 'var(--color-text-tertiary)', minWidth: '56px' }}
                    >
                      {formatEventTime(e.time)}
                    </span>
                    <span style={{ color: 'var(--color-text)' }}>{e.title}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {data?.tasks_connected && data.tasks.length > 0 && (
            <div className="pt-2" style={{ borderTop: '1px solid var(--color-border)' }}>
              <div
                className="text-[10px] uppercase tracking-wide mb-1.5"
                style={{ color: 'var(--color-text-tertiary)' }}
              >
                Open tasks
              </div>
              <ul className="flex flex-col gap-1.5">
                {data.tasks.map((t) => (
                  <li key={t.id} className="flex items-baseline gap-2">
                    <span style={{ color: 'var(--color-text)' }}>{t.title}</span>
                    {t.due && (
                      <span className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
                        {formatTaskDue(t.due)}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </DashboardPanel>
  );
}
