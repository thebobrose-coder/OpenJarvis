import { PageFrame } from '../components/shared/PageFrame';
import { DayAheadPanel } from '../components/Dashboard/DayAheadPanel';
import { WeatherPanel } from '../components/Dashboard/WeatherPanel';
import { DigestHubPanel } from '../components/Dashboard/DigestHubPanel';
import { StorePerformancePanel } from '../components/Dashboard/StorePerformancePanel';
import { TradingSummaryPanel } from '../components/Dashboard/TradingSummaryPanel';
import { WaitingPanel } from '../components/Dashboard/WaitingPanel';
import { StackHealthPanel } from '../components/Dashboard/StackHealthPanel';
import { FeedFreshnessLine } from '../components/Dashboard/FeedFreshnessLine';
import { FreshnessProvider, useFreshnessFeeds } from '../lib/freshness';

function DashboardFreshness() {
  return <FeedFreshnessLine feeds={useFreshnessFeeds()} />;
}

/**
 * The hub (widescreen plan, Phase 1). Row 1 is the act band: the For you lane with its
 * controls. Row 2 is the work row: the digests, the day ahead and the trader (short band too:
 * the operator wants all three rows above the fold). Row 3 is
 * reference: weather, the stores and the stack. The local-LLM telemetry lives on the
 * Ops page (Phase 5).
 */
export function DashboardPage() {
  return (
    <FreshnessProvider>
      <PageFrame>
        <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-ui-20 font-semibold" style={{ color: 'var(--color-text)' }}>
              Dashboard
            </h1>
            <p className="text-ui-12-5 mt-1" style={{ color: 'var(--color-text-secondary)' }}>
              What waits on you first; the day, the briefings and the trader beside it.
            </p>
          </div>
          <DashboardFreshness />
        </header>

        <div className="grid grid-cols-12 gap-4 mb-4">
          <WaitingPanel />
        </div>
        <div className="grid grid-cols-12 gap-4 mb-4">
          <DigestHubPanel />
          <DayAheadPanel />
          <TradingSummaryPanel />
        </div>
        <div className="grid grid-cols-12 gap-4 mb-10">
          <WeatherPanel />
          <StorePerformancePanel />
          <StackHealthPanel />
        </div>

      </PageFrame>
    </FreshnessProvider>
  );
}
