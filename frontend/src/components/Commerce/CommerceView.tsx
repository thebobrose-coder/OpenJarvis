import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type {
  AdsHold,
  ComplianceFinding,
  DailyStore,
  Decision,
  LedgerItem,
  RefreshTarget,
} from '../../lib/commerce-api';
import type { Spark } from '../../lib/content-api';
import type { CatalogFixesState } from '../../hooks/useCatalogFixes';
import type { FeedStates, PendingDecision, RefreshStatus } from '../../hooks/useCommerceData';
import { scrollToWhenReady } from '../../lib/waiting-api';
import { Segmented } from '../shared/ui';
import { AdsFlightsTab } from './AdsFlightsTab';
import { BriefingPanel } from './BriefingPanel';
import { CommerceHeader } from './CommerceHeader';
import { ComplianceTab } from './ComplianceTab';
import { KpiStrip } from './KpiStrip';
import { MerchantPanel } from './MerchantPanel';
import { ProductsTable } from './ProductsTable';
import { RecommendationsQueue } from './RecommendationsQueue';
import { SeoHealthPanel } from './SeoHealthPanel';
import { FixesTab, waitingCount } from './fixes/FixesTab';
import type { PrecheckProps } from './PrecheckWidget';
import { storesFor } from './format';

export type CommerceTab = 'overview' | 'fixes' | 'compliance' | 'ads';

/** `?tab=` and the older `#fixes` / `#commerce-compliance` links, as a tab. */
export function tabFromLocation(tab: string | null, hash: string): CommerceTab {
  if (hash === '#fixes') return 'fixes';
  if (hash === '#commerce-compliance') return 'compliance';
  return tab === 'fixes' || tab === 'compliance' || tab === 'ads' ? tab : 'overview';
}

/** A focus id that lives on the Ads & flights tab: a spark pick or a spend line. */
export const isAdsFocus = (id: string | null | undefined) => !!id && (id.startsWith('spark-') || id.startsWith('spend-'));

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
> &
  Partial<Pick<CatalogFixesState, 'policy' | 'tierPending' | 'setTier'>>;

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
  /** The page keeps `?tab=` in the URL. */
  onTab?: (tab: CommerceTab) => void;
  /** A deep link from "Waiting on you": a patch opens on the Fixes tab, a
   * rec scrolls into view on the Overview, a spark or spend line on Ads & flights.
   * `key` re-runs it per navigation. */
  focus?: { fix?: string | null; rec?: string | null; key?: string } | null;
  /** Desks (hq 0020 P3): "Ask the desk" on a recommendation and the KPIs
   * (Commerce desk) and on a compliance finding (Compliance desk). */
  onAskDesk?: {
    rec: (item: LedgerItem) => void;
    kpis: (stores: DailyStore[]) => void;
    finding: (f?: ComplianceFinding) => void;
  };
  /** The paste-and-check widget on the Compliance tab. */
  precheck?: PrecheckProps;
  /** Rec ids that get Fix it, from the waiting feed (0024 J1). */
  fixRecs?: ReadonlySet<string>;
  /** content_health.ads_hold (v1.21; its Merchant part v1.26), read only. */
  adsHold?: AdsHold | null;
  /** youtube_performance.spark (v1.29), read only: the Ads & flights tab. */
  sparks?: Spark[] | null;
  /** Open a work-order report by id: a ledger row's plan or order (v1.28). */
  onOpenReport?: (orderId: string) => void;
}

/**
 * The Commerce page (widescreen plan 4.2). Four tabs: Overview (KPIs and the briefing,
 * the recommendations with their ledger, products, then SEO and Merchant status),
 * Fixes (Hermes's catalog fixes to review), Compliance (property-wide, with the
 * pre-check first) and Ads & flights (ads hold, GA4, spark picks, spend). Pure:
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
  onTab,
  focus = null,
  onAskDesk,
  precheck,
  fixRecs,
  adsHold = null,
  sparks = null,
  onOpenReport,
}: CommerceViewProps) {
  const [tab, setTabState] = useState<CommerceTab>(fixes || initialTab !== 'fixes' ? initialTab : 'overview');
  const setTab = (t: CommerceTab) => {
    setTabState(t);
    onTab?.(t);
  };
  useEffect(() => {
    setTabState(fixes || initialTab !== 'fixes' ? initialTab : 'overview');
  }, [initialTab, fixes]);
  // A fix another panel linked to: the Fixes tab opens on its view.
  const [fixTarget, setFixTarget] = useState<string | null>(null);
  // A finding a patch card linked to: its rule group opens on the Compliance tab.
  const [findingTarget, setFindingTarget] = useState<string | null>(null);
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
  useEffect(() => {
    if (focus?.fix && fixes) {
      setFixTarget(focus.fix);
      setTabState('fixes');
      return scrollToWhenReady([`fix-${focus.fix}`]);
    }
    if (focus?.rec) {
      // A rec on the Overview; a spark or spend line (v1.29) on Ads & flights.
      setTabState(isAdsFocus(focus.rec) ? 'ads' : 'overview');
      return scrollToWhenReady([`rec-${focus.rec}`, focus.rec]);
    }
    return undefined;
    // Once per navigation: not on every fixes poll.
  }, [focus?.key, focus?.fix, focus?.rec]);
  const waiting = waitingCount(fixes?.data ?? null);
  const openFindings = feeds.compliance_findings.data?.counts.open ?? 0;
  // A ledger findings row (v1.28) or a patch card's finding chip: the Compliance tab.
  const openCompliance = (findingId?: string) => {
    setFindingTarget(findingId ?? null);
    setTab('compliance');
    const ids = findingId ? [`finding-${findingId}`, 'commerce-compliance'] : ['commerce-compliance'];
    scrollToWhenReady(ids);
  };
  const openFix = (id: string) => {
    setFixTarget(id);
    setTab('fixes');
    window.setTimeout(() => document.getElementById(`fix-${id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 50);
  };
  const tabs: { value: CommerceTab; label: string }[] = [
    { value: 'overview', label: ledger ? `Overview (${(ledger.open ?? []).length})` : 'Overview' },
    ...(fixes ? [{ value: 'fixes' as const, label: waiting ? `Fixes (${waiting})` : 'Fixes' }] : []),
    { value: 'compliance', label: openFindings ? `Compliance (${openFindings})` : 'Compliance' },
    { value: 'ads', label: 'Ads & flights' },
  ];
  return (
    <div>
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
          className="flex items-center justify-between gap-2 rounded-lg px-3 py-2 mb-4 text-ui-12"
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
      <div className="mb-4">
        <Segmented
          ariaLabel="Commerce view"
          value={tab}
          onChange={(t) => {
            setFixTarget(null);
            setTab(t);
          }}
          options={tabs}
        />
      </div>
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
          onOpenFinding={(id) => openCompliance(id)}
          notice={fixes.notice}
          onClearNotice={fixes.clearNotice}
          policy={fixes.policy}
          tierPending={fixes.tierPending}
          onSetTier={fixes.setTier}
          initialFocus={fixTarget}
        />
      ) : tab === 'compliance' ? (
        <ComplianceTab
          findings={feeds.compliance_findings.data}
          loading={feeds.compliance_findings.loading}
          error={feeds.compliance_findings.error}
          onOpenFix={fixes ? openFix : undefined}
          onAskDesk={onAskDesk?.finding}
          precheck={precheck}
          focusFinding={findingTarget}
        />
      ) : tab === 'ads' ? (
        <AdsFlightsTab
          stores={selectedDaily}
          adsHold={adsHold}
          sparks={sparks}
          spend={feeds.spend_ledger?.data ?? null}
          patches={fixes?.data?.patches ?? []}
          onOpenFix={fixes ? openFix : undefined}
          loading={{ daily: dailyState.loading, spend: feeds.spend_ledger?.loading }}
          error={{ daily: dailyState.error, spend: feeds.spend_ledger?.error }}
        />
      ) : (
        <>
          <div className="grid grid-cols-12 gap-4 mb-4">
            <KpiStrip
              stores={selectedDaily}
              loading={dailyState.loading}
              error={dailyState.error}
              onAskDesk={onAskDesk ? () => onAskDesk.kpis(selectedDaily) : undefined}
            />
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
              storeNames={storeNames}
              productTitles={productTitles}
              onDecide={onDecide}
              onAskDesk={onAskDesk?.rec}
              onOpenFix={fixes ? openFix : undefined}
              onOpenReport={onOpenReport}
              onOpenCompliance={() => openCompliance()}
              fixRecs={fixRecs}
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
          <div className="grid grid-cols-12 gap-4 mb-10">
            <SeoHealthPanel
              seo={feeds.ecom_seo_health.data}
              selectedStore={selectedStore}
              loading={feeds.ecom_seo_health.loading}
              error={feeds.ecom_seo_health.error}
            />
            <MerchantPanel
              merchant={feeds.merchant_status.data}
              selectedStore={selectedStore}
              stores={storeRefs}
              flights={false}
              size="half"
              band="short"
              loading={feeds.merchant_status.loading}
              error={feeds.merchant_status.error}
            />
          </div>
        </>
      )}
    </div>
  );
}
