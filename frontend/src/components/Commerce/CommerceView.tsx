import { useState } from 'react';
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
import { Segmented } from '../shared/ui';
import type { CatalogFixesState } from '../../hooks/useCatalogFixes';
import { FixesTab, waitingCount } from './fixes/FixesTab';

export type CommerceTab = 'overview' | 'fixes';

/** What the Fixes tab needs from useCatalogFixes. */
export type FixesProps = Pick<
  CatalogFixesState,
  | 'data'
  | 'loading'
  | 'error'
  | 'pending'
  | 'cardNotes'
  | 'paused'
  | 'pausePending'
  | 'decide'
  | 'decideClass'
  | 'setPaused'
  | 'notice'
  | 'clearNotice'
>;

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
  /** Catalog fixes (contract v1.3); without it the page has no Fixes tab. */
  fixes?: FixesProps;
  initialTab?: CommerceTab;
}

/**
 * The Commerce page. Overview, top to bottom: header, KPIs, today's
 * briefing, the recommendations queue with its ledger, products, ads, SEO
 * health and compliance. Fixes: Hermes's catalog fixes to review. Pure:
 * everything comes in through props (see CommercePage).
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
  fixes,
  initialTab = 'overview',
}: CommerceViewProps) {
  const [tab, setTab] = useState<CommerceTab>(fixes ? initialTab : 'overview');
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
  const ledger = feeds.ecom_recommendations.data;
  const recTitles = Object.fromEntries(
    [...(ledger?.open ?? []), ...(ledger?.recent_decided ?? [])].map((i) => [i.id, i.title]),
  );
  const openRec = (id: string) => {
    setTab('overview');
    window.setTimeout(() => document.getElementById(`rec-${id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 50);
  };
  const waiting = waitingCount(fixes?.data ?? null);

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

      {fixes && (
        <div className="mb-4">
          <Segmented
            ariaLabel="Commerce view"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'overview', label: 'Overview' },
              { value: 'fixes', label: waiting ? `Fixes (${waiting})` : 'Fixes' },
            ]}
          />
        </div>
      )}

      {tab === 'fixes' && fixes ? (
        <FixesTab
          feed={fixes.data}
          loading={fixes.loading}
          error={fixes.error}
          pending={fixes.pending}
          cardNotes={fixes.cardNotes}
          paused={fixes.paused}
          pausePending={fixes.pausePending}
          selectedStore={selectedStore}
          storeNames={storeNames}
          recTitles={recTitles}
          onDecide={fixes.decide}
          onDecideClass={fixes.decideClass}
          onPause={(p) => void fixes.setPaused(p)}
          onOpenRec={openRec}
          notice={fixes.notice}
          onClearNotice={fixes.clearNotice}
        />
      ) : (
        <>
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
        </>
      )}
    </div>
  );
}
