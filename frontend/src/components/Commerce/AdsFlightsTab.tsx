import { Plane, Sparkles } from 'lucide-react';
import type { AdsHold, DailyStore } from '../../lib/commerce-api';
import type { Spark } from '../../lib/content-api';
import type { Patch } from '../../lib/fixes-api';
import { DashboardPanel } from '../Dashboard/DashboardPanel';
import { SparkBlock } from '../Content/YouTubePanel';
import { Quiet } from '../shared/ui';
import { AdsPanel } from './AdsPanel';
import { HoldFlight } from './MerchantPanel';

export interface AdsFlightsTabProps {
  /** The selected stores' daily rows (GA4 ads live on them). */
  stores: DailyStore[];
  /** content_health.ads_hold (v1.21, v1.26): the verdict per flight. */
  adsHold: AdsHold | null;
  /** youtube_performance.spark (v1.29): the pick per flight; the swap is the operator's. */
  sparks: Spark[] | null;
  patches?: Patch[];
  onOpenFix?: (id: string) => void;
  loading?: { daily?: boolean };
  error?: { daily?: string | null };
}

/**
 * Ads & flights (widescreen plan 5.1): the flight and ads family in one place. It was
 * split across the Merchant panel (ads hold), the Content page (Spark picks), the Spend
 * ledger (flight caps) and the Ads panel (GA4 campaigns). Everything here is read only
 * or links to an existing Fixes entry; the swap and the campaigns stay in Google Ads.
 */
export function AdsFlightsTab({ stores, adsHold, sparks, patches = [], onOpenFix, loading = {}, error = {} }: AdsFlightsTabProps) {
  const flights = Object.entries(adsHold?.flights ?? {});
  return (
    <>
      <div className="grid grid-cols-12 gap-4 mb-4" data-flights>
        {flights.length === 0 ? (
          <DashboardPanel icon={Plane} title="Flights" tag="ads hold" size="full">
            <Quiet>No ads-hold verdict yet. Hermes publishes one per flight on content_health.</Quiet>
          </DashboardPanel>
        ) : (
          flights.map(([id, f]) => (
            <DashboardPanel
              key={id}
              icon={Plane}
              title={id}
              tag={f.verdict}
              size="quarter"
              band="short"
              priority={f.verdict !== 'clear'}
            >
              <ul className="flex flex-col gap-2">
                <HoldFlight id={id} flight={f} patches={patches} onOpenFix={onOpenFix} />
              </ul>
            </DashboardPanel>
          ))
        )}
      </div>
      <div className="grid grid-cols-12 gap-4 mb-4">
        <AdsPanel stores={stores} loading={loading.daily} error={error.daily} size="half" band="tall" />
        <DashboardPanel icon={Sparkles} title="Spark picks" tag="read only" size="half" band="tall">
          {!sparks ? (
            <Quiet>No YouTube read yet.</Quiet>
          ) : sparks.length === 0 ? (
            <Quiet>No spark picks: Hermes ranks a flight's Shorts once the channel has a 28-day read.</Quiet>
          ) : (
            <div className="flex flex-col gap-3" data-sparks>
              {sparks.map((s) => (
                <SparkBlock key={s.flight} spark={s} />
              ))}
            </div>
          )}
        </DashboardPanel>
      </div>
      <p className="text-ui-11 mb-10" style={{ color: 'var(--color-text-tertiary)' }} data-spend-moved>
        The spend ledger, with each cap’s gauge and the AWS burn, is on the Ops page.
      </p>
    </>
  );
}
