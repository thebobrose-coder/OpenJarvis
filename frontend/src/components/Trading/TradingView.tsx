import { SLEEVE_ORDER, sleeveNames, sleeveSize, type TradingConfig, type TradingDay, type TradingStatus } from '../../lib/trading-api';
import type { FeedState } from '../../hooks/useTradingData';
import { Quiet } from '../shared/ui';
import { EquityCurve } from './EquityCurve';
import { EventsPanel } from './EventsPanel';
import { SleeveCard } from './SleeveCard';
import { StatusStrip } from './StatusStrip';
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
 * The Trading page (hq/decisions/0014; widescreen plan 4.6): the x402 paper
 * trader as it reports itself, read-only. Row 1: the status strip (kill
 * switch, x402 spend and nightly; one line while all fine, expands in place).
 * Row 2, tall: one card per sleeve, three across. Row 3, tall: the equity
 * curve (wide) beside Events | Alerts (third, tabbed). Pure: everything
 * comes in through props (see TradingPage).
 */
export function TradingView({ status, day, config, now }: TradingViewProps) {
  const s = status.data;
  const sleeves = sleeveNames(s);
  // Before the first status, a placeholder per known sleeve.
  const shown = sleeves.length ? sleeves : SLEEVE_ORDER;
  const loading = status.loading;
  const error = status.error;
  return (
    <div>
      <TradingHeader status={s} now={now} />

      {!loading && !error && !s && <Quiet>{NO_STATUS_YET}</Quiet>}

      <StatusStrip status={s} config={config} loading={loading} error={error} />

      <div className="grid grid-cols-12 gap-4 mb-4">
        {s && sleeves.length === 0 ? (
          <div className="col-span-12">
            <Quiet>{NO_SLEEVES}</Quiet>
          </div>
        ) : (
          shown.map((name) => (
            <SleeveCard
              key={name}
              name={name}
              sleeve={s?.sleeves?.[name] ?? null}
              loading={loading}
              error={error}
              now={now}
              size={sleeveSize(shown.length)}
              band="tall"
            />
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
