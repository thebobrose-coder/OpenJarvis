/** Number formatting and store aggregation shared by the Commerce sections. */
import type { DailyStore, SalesWindow } from '../../lib/commerce-api';
import { num } from '../shared/format';

export { num, shortDateTime } from '../shared/format';

export const ALL_STORES = '__all__';

/** Money in the store's currency. `currency` is null for a store with no
 * sales yet; the amount is then 0 anyway, so plain digits are shown. */
export function money(n: number | null | undefined, currency?: string | null): string {
  if (n == null || Number.isNaN(n)) return '—';
  if (!currency) return num(n, 2);
  try {
    return n.toLocaleString(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: n >= 1000 ? 0 : 2,
    });
  } catch {
    return `${num(n, 2)} ${currency}`;
  }
}

export function ratio(numerator?: number | null, denominator?: number | null): number | null {
  if (!denominator || numerator == null) return null;
  return numerator / denominator;
}

/** Signed change vs a prior value: "+12%", "−3%", "new", or null when both are 0. */
export function delta(now: number, prior: number): { text: string; direction: -1 | 0 | 1 } | null {
  if (!now && !prior) return null;
  if (!prior) return { text: 'new', direction: 1 };
  const pct = ((now - prior) / prior) * 100;
  const rounded = Math.round(pct);
  if (rounded === 0) return { text: '±0%', direction: 0 };
  return { text: `${rounded > 0 ? '+' : '−'}${Math.abs(rounded)}%`, direction: rounded > 0 ? 1 : -1 };
}

export function storesFor<T extends { slug: string }>(stores: T[] | undefined, selected: string): T[] {
  if (!stores) return [];
  return selected === ALL_STORES ? stores : stores.filter((s) => s.slug === selected);
}

const ZERO: SalesWindow = { orders: 0, revenue: 0, units: 0 };

function addWindows(a: SalesWindow, b?: SalesWindow): SalesWindow {
  return {
    orders: a.orders + (b?.orders ?? 0),
    revenue: a.revenue + (b?.revenue ?? 0),
    units: a.units + (b?.units ?? 0),
  };
}

export interface KpiTotals {
  currency: string | null;
  /** More than one currency among the stores: money totals aren't summed. */
  mixedCurrency: boolean;
  yesterday: SalesWindow;
  last_7: SalesWindow;
  prior_7: SalesWindow;
  last_28: SalesWindow;
  inStock: number;
  outOfStock: number;
  alerts: number;
  ga4: {
    connectedStores: number;
    reasons: string[];
    sessions: number;
    purchases: number;
    adCost: number;
    adRevenue: number;
  };
}

/** Sum the KPI inputs of the selected stores (one store = its own values). */
export function kpiTotals(stores: DailyStore[]): KpiTotals {
  const currencies = new Set(stores.map((s) => s.sales?.currency).filter(Boolean) as string[]);
  const t: KpiTotals = {
    currency: currencies.size === 1 ? [...currencies][0] : null,
    mixedCurrency: currencies.size > 1,
    yesterday: ZERO,
    last_7: ZERO,
    prior_7: ZERO,
    last_28: ZERO,
    inStock: 0,
    outOfStock: 0,
    alerts: 0,
    ga4: { connectedStores: 0, reasons: [], sessions: 0, purchases: 0, adCost: 0, adRevenue: 0 },
  };
  for (const s of stores) {
    t.yesterday = addWindows(t.yesterday, s.sales?.yesterday);
    t.last_7 = addWindows(t.last_7, s.sales?.last_7);
    t.prior_7 = addWindows(t.prior_7, s.sales?.prior_7);
    t.last_28 = addWindows(t.last_28, s.sales?.last_28);
    t.inStock += s.catalog?.in_stock ?? 0;
    t.outOfStock += s.catalog?.out_of_stock ?? 0;
    t.alerts += s.alerts?.length ?? 0;
    const g = s.ga4;
    if (g?.connected) {
      t.ga4.connectedStores += 1;
      t.ga4.sessions += g.sessions_28 ?? 0;
      t.ga4.purchases += g.purchases_28 ?? 0;
      t.ga4.adCost += g.ads?.cost_28 ?? 0;
      t.ga4.adRevenue += g.ads?.revenue_28 ?? 0;
    } else if (g?.reason) {
      const label = stores.length > 1 ? `${s.display_name}: ${g.reason}` : g.reason;
      t.ga4.reasons.push(label);
    }
  }
  return t;
}
