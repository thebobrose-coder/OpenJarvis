import { EnergyDashboard } from '../components/Dashboard/EnergyDashboard';
import { PageFrame } from '../components/shared/PageFrame';
import { CostComparison } from '../components/Dashboard/CostComparison';
import { TraceDebugger } from '../components/Dashboard/TraceDebugger';
import { DayAheadPanel } from '../components/Dashboard/DayAheadPanel';
import { WeatherPanel } from '../components/Dashboard/WeatherPanel';
import { CultureNewsPanel } from '../components/Dashboard/CultureNewsPanel';
import { DailyBriefPanel } from '../components/Dashboard/DailyBriefPanel';
import { StorePerformancePanel } from '../components/Dashboard/StorePerformancePanel';
import { ListenPanel } from '../components/Dashboard/ListenPanel';
import { TradingSummaryPanel } from '../components/Dashboard/TradingSummaryPanel';
import { WaitingPanel } from '../components/Dashboard/WaitingPanel';

export function DashboardPage() {
  const now = new Date();
  const stamp = now.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

  return (
    <PageFrame>
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
          <WaitingPanel />
        </div>
        <div className="grid grid-cols-12 gap-4 mb-4">
          <DayAheadPanel />
          <WeatherPanel />
        </div>
        <div className="grid grid-cols-12 gap-4 mb-4">
          <TradingSummaryPanel />
          <ListenPanel />
        </div>
        <div className="grid grid-cols-12 gap-4 mb-10">
          <DailyBriefPanel />
          <CultureNewsPanel />
          {/* Market Briefing panel joins here as that pipeline ships. */}
        </div>
        <div className="grid grid-cols-12 gap-4 mb-10">
          <StorePerformancePanel />
        </div>

        <div
          className="text-ui-11 uppercase tracking-wide mb-3 pt-2"
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
    </PageFrame>
  );
}
