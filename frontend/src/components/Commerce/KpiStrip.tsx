import { Gauge } from 'lucide-react';
import type { DailyStore } from '../../lib/commerce-api';
import { DashboardPanel } from '../Dashboard/DashboardPanel';
import { delta, kpiTotals, money, num, ratio } from './format';
import { Chip, ExtLink, Quiet, Tile } from '../shared/ui';

/**
 * Sales, traffic, ads and catalog at a glance, for one store or summed for
 * all. The stores are new, so zeros are expected: nothing here turns red on
 * a zero, and a week-over-week drop is only muted text.
 */
export function KpiStrip({ stores, error, loading }: { stores: DailyStore[]; error?: string | null; loading?: boolean }) {
  const t = kpiTotals(stores);
  const cur = t.mixedCurrency ? null : t.currency;
  const m = (n: number) => (t.mixedCurrency ? 'mixed currencies' : money(n, cur));
  const wow = delta(t.last_7.revenue, t.prior_7.revenue);
  const wowOrders = delta(t.last_7.orders, t.prior_7.orders);
  const roas = ratio(t.ga4.adRevenue, t.ga4.adCost);
  const ga4Connected = t.ga4.connectedStores > 0;

  return (
    <DashboardPanel icon={Gauge} title="Store KPIs" tag="Daily" size="full" loading={loading} error={error}>
      {stores.length === 0 ? (
        <Quiet>No store data yet -- Hermes collects it daily at 06:45.</Quiet>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
            <Tile
              label="Yesterday"
              value={m(t.yesterday.revenue)}
              sub={`${num(t.yesterday.orders)} orders · ${num(t.yesterday.units)} units`}
            />
            <Tile
              label="Last 7 days"
              value={m(t.last_7.revenue)}
              sub={
                wow || wowOrders
                  ? `${num(t.last_7.orders)} orders · ${wow?.text ?? wowOrders?.text} vs prior 7`
                  : `${num(t.last_7.orders)} orders · ${num(t.last_7.units)} units`
              }
              subTone={wow && wow.direction > 0 ? 'success' : 'muted'}
            />
            <Tile
              label="Last 28 days"
              value={m(t.last_28.revenue)}
              sub={`${num(t.last_28.orders)} orders · ${num(t.last_28.units)} units`}
            />
            <Tile
              label="Stock"
              value={`${num(t.inStock)} in stock`}
              sub={t.outOfStock ? `${num(t.outOfStock)} out of stock` : 'none out of stock'}
              subTone={t.outOfStock ? 'warning' : 'muted'}
            />
            <Tile
              label="Alerts"
              value={num(t.alerts)}
              sub={t.alerts ? 'listed below' : 'all clear'}
              subTone={t.alerts ? 'warning' : 'muted'}
            />
            <Tile
              label="Sessions (GA4, 28 d)"
              value={ga4Connected ? num(t.ga4.sessions) : '—'}
              sub={ga4Connected ? `${num(t.ga4.purchases)} purchases` : 'not connected'}
            />
          </div>

          {ga4Connected && (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              <Tile label="Ad cost (28 d)" value={m(t.ga4.adCost)} />
              <Tile label="Ad revenue (28 d)" value={m(t.ga4.adRevenue)} />
              <Tile label="ROAS (28 d)" value={roas == null ? '—' : `${num(roas, 2)}×`} sub={roas == null ? 'no ad spend yet' : undefined} />
            </div>
          )}

          {t.alerts > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {stores.flatMap((s) =>
                (s.alerts ?? []).map((a, i) => (
                  <Chip key={`${s.slug}-${i}`} tone="warning" title={a.kind}>
                    <ExtLink url={a.admin_url} title="Open in Shopify admin">
                      {stores.length > 1 ? `${s.display_name}: ` : ''}
                      {a.title}
                    </ExtLink>
                  </Chip>
                )),
              )}
            </div>
          )}

          {t.ga4.reasons.length > 0 && (
            <Quiet>GA4 not connected -- {t.ga4.reasons.join('; ')}</Quiet>
          )}
        </div>
      )}
    </DashboardPanel>
  );
}
