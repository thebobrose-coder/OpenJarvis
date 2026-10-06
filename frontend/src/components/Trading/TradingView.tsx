import { sleeveNames, type TradingConfig, type TradingDay, type TradingStatus } from '../../lib/trading-api';
import type { FeedState } from '../../hooks/useTradingData';
import { Quiet } from '../shared/ui';
import { EquityCurve } from './EquityCurve';
import { EventsPanel } from './EventsPanel';
import { KillCard } from './KillCard';
import { SleeveCard } from './SleeveCard';
import { NightlyCard, SpendCard } from './SpendCard';
import { TradingHeader } from './TradingHeader';

export interface TradingViewProps {
  status: FeedState<TradingStatus>;
  day: FeedState<TradingDay>;
  config: TradingConfig | null;
  now: number;
}

export const NO_STATUS_YET = 'No trading status yet. Hermes publishes the trader’s status every 5 minutes once the export exists.';
export const NO_SLEEVES = 'Hermes could not read the trader’s status export, so there is nothing to show for the sleeves.';

/**
 * The Trading page (hq/decisions/0014): the x402 paper trader as it reports
 * itself, read-only. Header strip, kill switch, x402 spend, nightly, the two
 * sleeve cards, the equity curve, events and alerts. Pure: everything comes
 * in through props (see TradingPage).
 */
export function TradingView({ status, day, config, now }: TradingViewProps) {
  const s = status.data;
  const sleeves = sleeveNames(s);
  const loading = status.loading;
  const error = status.error;
  return (
    <div className="max-w-[1800px] mx-auto">
      <TradingHeader status={s} now={now} />

      {!loading && !error && !s && <Quiet>{NO_STATUS_YET}</Quiet>}

      <div className="grid grid-cols-12 gap-4 mb-4">
        <KillCard status={s} config={config} loading={loading} error={error} />
        <SpendCard status={s} loading={loading} error={error} />
        <NightlyCard status={s} loading={loading} error={error} />
      </div>

      <div className="grid grid-cols-12 gap-4 mb-4">
        {s && sleeves.length === 0 ? (
          <div className="col-span-12">
            <Quiet>{NO_SLEEVES}</Quiet>
          </div>
        ) : (
          (sleeves.length ? sleeves : ['equities', 'crypto']).map((name) => (
            <SleeveCard key={name} name={name} sleeve={s?.sleeves?.[name] ?? null} loading={loading} error={error} />
          ))
        )}
      </div>

      <div className="grid grid-cols-12 gap-4 mb-10">
        <EquityCurve day={day.data} loading={day.loading} error={day.error} />
        <EventsPanel status={s} loading={loading} error={error} />
      </div>
    </div>
  );
}
