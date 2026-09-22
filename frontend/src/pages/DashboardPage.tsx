import { Clapperboard, Flag, Goal } from 'lucide-react';
import { EnergyDashboard } from '../components/Dashboard/EnergyDashboard';
import { CostComparison } from '../components/Dashboard/CostComparison';
import { TraceDebugger } from '../components/Dashboard/TraceDebugger';
import { DayAheadPanel } from '../components/Dashboard/DayAheadPanel';
import { WeatherPanel } from '../components/Dashboard/WeatherPanel';
import { NewsDigestPanel } from '../components/Dashboard/NewsDigestPanel';

export function DashboardPage() {
  const now = new Date();
  const stamp = now.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

  return (
    <div className="flex-1 overflow-y-auto px-6 py-10">
      <div className="max-w-6xl mx-auto">
        <header className="mb-6">
          <div className="flex items-center justify-between">
            <h1 className="text-lg font-semibold" style={{ color: 'var(--color-text)' }}>
              Dashboard
            </h1>
            <div className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
              {stamp}
            </div>
          </div>
          <p className="text-sm mt-2 max-w-2xl" style={{ color: 'var(--color-text-secondary)' }}>
            Today's briefings at a glance, with system telemetry below.
          </p>
        </header>

        <div className="grid grid-cols-12 gap-4 mb-4">
          <DayAheadPanel />
          <WeatherPanel />
        </div>
        <div className="grid grid-cols-12 gap-4 mb-10">
          <NewsDigestPanel icon={Goal} title="Soccer" tag="1 hr" prefix="/api/digest/soccer" />
          <NewsDigestPanel icon={Flag} title="Motorsport" tag="1 hr" prefix="/api/digest/motorsport" />
          <NewsDigestPanel
            icon={Clapperboard}
            title="Entertainment"
            tag="1 hr"
            prefix="/api/digest/entertainment"
          />
          {/* Market Briefing panel joins here as that pipeline ships. */}
        </div>

        <div
          className="text-[11px] uppercase tracking-wide mb-3 pt-2"
          style={{ color: 'var(--color-text-tertiary)', borderTop: '1px solid var(--color-border)' }}
        >
          System telemetry
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4 opacity-90">
          <EnergyDashboard />
          <CostComparison />
        </div>
        <div className="opacity-90">
          <TraceDebugger />
        </div>
      </div>
    </div>
  );
}
