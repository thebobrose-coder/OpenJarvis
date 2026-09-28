import { X } from 'lucide-react';
import type { Decision, RefreshTarget } from '../../lib/commerce-api';
import type { FeedStates, PendingDecision, RefreshStatus } from '../../hooks/useCommerceData';
import { AdsPanel } from './AdsPanel';
import { BriefingPanel } from './BriefingPanel';
import { CommerceHeader } from './CommerceHeader';
import { CompliancePanel } from './CompliancePanel';
import { storesFor } from './format';
import { KpiStrip } from './KpiStrip';
import { ProductsTable } from './ProductsTable';
import { RecommendationsQueue } from './RecommendationsQueue';
import { SeoHealthPanel } from './SeoHealthPanel';

export interface CommerceViewProps {
  feeds: FeedStates;
  pending: Record<string, PendingDecision>;
  refreshStatus: Partial<Record<RefreshTarget, RefreshStatus>>;
  selectedStore: string;
  onSelectStore: (slug: string) => void;
  onRefresh: (target: RefreshTarget) => void;
  onDecide: (id: string, decision: Decision, note: string) => void;
  notice?: string | null;
  onClearNotice?: () => void;
}

/**
 * The Commerce page, top to bottom: header, KPIs, today's briefing, the
 * recommendations queue with its ledger, products, ads, SEO health and
 * compliance. Pure: everything comes in through props (see CommercePage).
 */
export function CommerceView({
  feeds,
  pending,
  refreshStatus,
  selectedStore,
  onSelectStore,
  onRefresh,
  onDecide,
  notice,
  onClearNotice,
}: CommerceViewProps) {
  const daily = feeds.ecom_daily.data;
  // Stores and their names come from ecom_daily; other feeds fall back to
  // their own lists if it hasn't run.
  const stores =
    daily?.stores ?? feeds.ecom_products.data?.stores ?? feeds.ecom_seo_health.data?.stores ?? [];
  const storeRefs = stores.map((s) => ({ slug: s.slug, display_name: s.display_name }));
  const storeNames = Object.fromEntries(storeRefs.map((s) => [s.slug, s.display_name]));
  const currencyBySlug = Object.fromEntries((daily?.stores ?? []).map((s) => [s.slug, s.sales?.currency ?? null]));
  const selectedDaily = storesFor(daily?.stores, selectedStore);
  const productTitles = Object.fromEntries(
    (feeds.ecom_products.data?.stores ?? []).flatMap((s) => s.products.map((p) => [p.id, p.title])),
  );
  const dailyState = feeds.ecom_daily;

  return (
    <div className="max-w-6xl mx-auto">
      <CommerceHeader
        stores={storeRefs}
        selected={selectedStore}
        onSelect={onSelectStore}
        feeds={feeds}
        refreshStatus={refreshStatus}
        onRefresh={onRefresh}
      />

      {notice && (
        <div
          className="flex items-center justify-between gap-2 rounded-lg px-3 py-2 mb-4 text-[12px]"
          style={{ border: '1px solid var(--color-warning)', color: 'var(--color-text-secondary)' }}
          role="status"
        >
          <span>{notice}</span>
          {onClearNotice && (
            <button onClick={onClearNotice} aria-label="Dismiss" className="cursor-pointer" style={{ background: 'transparent', border: 'none', color: 'inherit' }}>
              <X size={12} />
            </button>
          )}
        </div>
      )}

      <div className="grid grid-cols-12 gap-4 mb-4">
        <KpiStrip stores={selectedDaily} loading={dailyState.loading} error={dailyState.error} />
      </div>

      <div className="grid grid-cols-12 gap-4 mb-4">
        <BriefingPanel
          briefing={feeds.ecom_briefing.data}
          selectedStore={selectedStore}
          storeNames={storeNames}
          refreshStatus={refreshStatus}
          onRefresh={onRefresh}
          loading={feeds.ecom_briefing.loading}
          error={feeds.ecom_briefing.error}
        />
      </div>

      <div className="grid grid-cols-12 gap-4 mb-4">
        <RecommendationsQueue
          ledger={feeds.ecom_recommendations.data}
          pending={pending}
          selectedStore={selectedStore}
          onSelectStore={onSelectStore}
          stores={storeRefs}
          storeNames={storeNames}
          productTitles={productTitles}
          onDecide={onDecide}
          loading={feeds.ecom_recommendations.loading}
          error={feeds.ecom_recommendations.error}
        />
      </div>

      <div className="grid grid-cols-12 gap-4 mb-4">
        <ProductsTable
          products={feeds.ecom_products.data}
          selectedStore={selectedStore}
          currencyBySlug={currencyBySlug}
          loading={feeds.ecom_products.loading}
          error={feeds.ecom_products.error}
        />
      </div>

      <div className="grid grid-cols-12 gap-4 mb-4">
        <AdsPanel stores={selectedDaily} loading={dailyState.loading} error={dailyState.error} />
        <SeoHealthPanel
          seo={feeds.ecom_seo_health.data}
          selectedStore={selectedStore}
          loading={feeds.ecom_seo_health.loading}
          error={feeds.ecom_seo_health.error}
        />
      </div>

      <div className="grid grid-cols-12 gap-4 mb-10">
        <CompliancePanel
          findings={feeds.compliance_findings.data}
          loading={feeds.compliance_findings.loading}
          error={feeds.compliance_findings.error}
        />
      </div>
    </div>
  );
}
