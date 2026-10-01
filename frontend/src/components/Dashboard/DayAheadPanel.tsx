import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { CalendarClock } from 'lucide-react';
import { fetchDayAhead, refreshDayAhead } from '../../lib/api';
import type { DayAhead } from '../../lib/api';
import { DashboardPanel } from './DashboardPanel';
import { FeedFreshness } from './FeedFreshness';

const REFRESH_MS = 5 * 60 * 1000;
// Hermes regenerates day_ahead every 5 minutes; past 15 the feed is late.
const LATE_AFTER_S = 15 * 60;

function formatEventTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function formatTaskDue(iso: string): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** The agenda itself: next 24h of events and the open tasks, from Hermes's
 * day_ahead feed, with its age (and a stale note when the bridge is down). */
export function DayAheadView({ data, onConnect }: { data: DayAhead; onConnect?: () => void }) {
  if (!data.calendar_connected && !data.tasks_connected) {
    return (
      <p style={{ color: 'var(--color-text-tertiary)' }}>
        <button
          onClick={onConnect}
          className="underline cursor-pointer"
          style={{ background: 'transparent', border: 'none', padding: 0, color: 'inherit', font: 'inherit' }}
        >
          Connect Google Calendar and Google Tasks
        </button>{' '}
        to populate this panel.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <div>
        {!data.calendar_connected ? (
          <p style={{ color: 'var(--color-text-tertiary)' }}>Calendar not connected.</p>
        ) : data.events.length === 0 ? (
          <p style={{ color: 'var(--color-text-tertiary)' }}>Nothing on the calendar in the next 24 hours.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {data.events.map((e) => (
              <li key={e.id} className="flex items-baseline gap-2">
                <span className="shrink-0 font-mono text-[11px]" style={{ color: 'var(--color-text-tertiary)', minWidth: '56px' }}>
                  {formatEventTime(e.time)}
                </span>
                <span style={{ color: 'var(--color-text)' }}>{e.title}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {data.tasks_connected && data.tasks.length > 0 && (
        <div className="pt-2" style={{ borderTop: '1px solid var(--color-border)' }}>
          <div className="text-[10px] uppercase tracking-wide mb-1.5" style={{ color: 'var(--color-text-tertiary)' }}>
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

      <FeedFreshness ageSeconds={data.age_seconds} stale={data.stale} staleAfterSeconds={LATE_AFTER_S} />
    </div>
  );
}

/**
 * Agenda panel: Hermes's day_ahead feed (wave 4), which Hermes regenerates
 * every 5 minutes. Opening the panel asks Hermes for a fresh one (it lands
 * within a couple of minutes); the panel reloads on its interval.
 */
export function DayAheadPanel() {
  const navigate = useNavigate();
  const [data, setData] = useState<DayAhead | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await fetchDayAhead());
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Queue one refresh on open; don't wait for it (the current copy shows now).
    refreshDayAhead().catch(() => {});
    load();
    const interval = setInterval(load, REFRESH_MS);
    return () => clearInterval(interval);
  }, [load]);

  return (
    <DashboardPanel icon={CalendarClock} title="Day Ahead" tag="5 min" size="half" priority loading={loading} error={error}>
      {data && <DayAheadView data={data} onConnect={() => navigate('/data-sources')} />}
    </DashboardPanel>
  );
}
