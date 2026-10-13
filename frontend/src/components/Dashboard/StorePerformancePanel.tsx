import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Search, ShoppingBag, TrendingDown, TrendingUp } from 'lucide-react';
import { fetchStorePerformance } from '../../lib/api';
import type {
  ProductSearch,
  SearchConsolePage,
  SearchConsolePerformanceSection,
  SearchConsoleQuery,
  SearchPageClass,
  SearchQueryClass,
  StorePerformancePayload,
  StorePerformanceEntry,
} from '../../lib/api';
import { Chip, Segmented, SmallButton, Tile, type Tone } from '../shared/ui';
import { DashboardPanel } from './DashboardPanel';
import { FeedFreshness } from './FeedFreshness';

const REFRESH_MS = 30 * 60 * 1000;

function StoreSection({ store }: { store: StorePerformanceEntry }) {
  const { shopify, search_console: gsc } = store;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <div>
        <div className="flex items-center gap-1.5 mb-2">
          <ShoppingBag size={12} style={{ color: 'var(--color-accent)' }} />
          <span className="text-xs font-semibold" style={{ color: 'var(--color-text)' }}>
            Shopify
          </span>
        </div>
        {!shopify?.connected ? (
          <p style={{ color: 'var(--color-text-tertiary)' }}>
            Hermes has no Shopify data for this store yet.
          </p>
        ) : shopify.error ? (
          <p style={{ color: 'var(--color-error)' }}>{shopify.error}</p>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
              {shopify.catalog_count} products tracked
            </div>
            {(shopify.new_today?.length ?? 0) === 0 &&
            (shopify.price_changes?.length ?? 0) === 0 &&
            (shopify.stockouts?.length ?? 0) === 0 ? (
              <p style={{ color: 'var(--color-text-tertiary)' }}>No changes since yesterday.</p>
            ) : (
              <>
                {shopify.new_today && shopify.new_today.length > 0 && (
                  <div>
                    <div className="text-[10px] uppercase tracking-wide mb-1" style={{ color: 'var(--color-text-tertiary)' }}>
                      New today ({shopify.new_today.length})
                    </div>
                    {shopify.new_today.slice(0, 5).map((p, i) => (
                      <div key={i}>{p.title}</div>
                    ))}
                  </div>
                )}
                {shopify.price_changes && shopify.price_changes.length > 0 && (
                  <div>
                    <div className="text-[10px] uppercase tracking-wide mb-1" style={{ color: 'var(--color-text-tertiary)' }}>
                      Price changes ({shopify.price_changes.length})
                    </div>
                    {shopify.price_changes.slice(0, 5).map((p, i) => (
                      <div key={i} className="flex items-center gap-1.5">
                        {p.new_price != null && p.old_price != null && p.new_price > p.old_price ? (
                          <TrendingUp size={11} style={{ color: 'var(--color-error)' }} />
                        ) : (
                          <TrendingDown size={11} style={{ color: 'var(--color-success)' }} />
                        )}
                        <span>
                          {p.title}: {p.old_price} → {p.new_price}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {shopify.stockouts && shopify.stockouts.length > 0 && (
                  <div>
                    <div className="text-[10px] uppercase tracking-wide mb-1" style={{ color: 'var(--color-error)' }}>
                      Stockouts ({shopify.stockouts.length})
                    </div>
                    {shopify.stockouts.slice(0, 5).map((p, i) => (
                      <div key={i}>{p.title}</div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      <div>
        <div className="flex items-center gap-1.5 mb-2">
          <Search size={12} style={{ color: 'var(--color-accent)' }} />
          <span className="text-xs font-semibold" style={{ color: 'var(--color-text)' }}>
            Search Console (28d)
          </span>
        </div>
        {!gsc?.connected ? (
          <p style={{ color: 'var(--color-text-tertiary)' }}>
            Hermes has no Search Console data for this store yet.
          </p>
        ) : gsc.error ? (
          <p style={{ color: 'var(--color-error)' }}>{gsc.error}</p>
        ) : (
          <StoreSearch gsc={gsc} />
        )}
      </div>
    </div>
  );
}

// --- Search Console (contract v1.11 "Store search segments") ---------------
// Hermes sets every class (query and page) from the operator's term list;
// this panel only groups rows by the label it is given. Every key past the
// three totals is optional, so an old feed renders the plain query list.

const QUERY_LIMIT = 8;
const PAGE_LIMIT = 8;
const QUERY_TABS: { value: SearchQueryClass; label: string; title?: string }[] = [
  { value: 'non_brand', label: 'Non-brand' },
  { value: 'brand', label: 'Brand' },
  { value: 'noise', label: 'Noise', title: 'Counted in totals; labelled by the Hermes term list' },
];
const PAGE_CLASS: Record<SearchPageClass, { label: string; tone: Tone }> = {
  product: { label: 'product', tone: 'accent' },
  collection: { label: 'collection', tone: 'accent' },
  store_other: { label: 'store', tone: 'neutral' },
  content: { label: 'content', tone: 'muted' },
  legacy: { label: 'legacy', tone: 'warning' },
};
const STORE_CLASSES: SearchPageClass[] = ['product', 'collection', 'store_other'];

const muted = { color: 'var(--color-text-tertiary)' };

function num(n: number | undefined | null): string {
  return (n ?? 0).toLocaleString('en-US');
}

function pos(n: number | undefined | null): string {
  return n == null ? '–' : n.toFixed(1);
}

/** The store host is wherever Hermes found store pages (product, collection, other store). */
export function storeHost(pages: SearchConsolePage[]): string | null {
  for (const p of pages) {
    if (!STORE_CLASSES.includes(p.page_class)) continue;
    try {
      return new URL(p.page).host;
    } catch {
      // not a URL; try the next page
    }
  }
  return null;
}

/** A path on the store host; host + path anywhere else, so content and legacy pages stay recognisable. */
export function pageLabel(page: string, host: string | null): string {
  try {
    const u = new URL(page);
    const path = `${u.pathname}${u.search}`;
    return u.host === host ? path : `${u.host}${u.pathname === '/' ? '' : u.pathname}${u.search}`;
  } catch {
    return page;
  }
}

function ProductSearchBlock({ ps }: { ps: ProductSearch }) {
  const ga4 = ps.organic_sessions == null;
  return (
    <div className="flex flex-col gap-1">
      <div
        className="text-[10px] uppercase tracking-wide"
        style={muted}
        title="Product and collection pages. Counted per page shown, so it can be larger than the property total."
      >
        Product search · page impressions
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <Tile
          label="Search"
          value={`${num(ps.impressions)} impr.`}
          sub={`${num(ps.clicks)} clicks · pos ${pos(ps.position)} · ${num(ps.pages)} pages`}
        />
        <Tile
          label="Non-brand"
          value={`${num(ps.non_brand_impressions)} impr.`}
          sub={`${num(ps.non_brand_clicks)} clicks`}
        />
        <Tile
          label="GA4 organic"
          value={ga4 ? 'GA4 unavailable' : `${num(ps.organic_sessions)} sessions`}
          sub={
            ga4
              ? undefined
              : `${num(ps.organic_purchases)} purchases · ${(ps.organic_revenue ?? 0).toFixed(2)} revenue`
          }
        />
      </div>
    </div>
  );
}

function QueryRows({ queries }: { queries: SearchConsoleQuery[] }) {
  return (
    <>
      {queries.slice(0, QUERY_LIMIT).map((q, i) => (
        <div key={i} className="flex items-center justify-between gap-2">
          <span className="truncate">{q.query}</span>
          <span className="text-[11px] shrink-0" style={muted}>
            {q.clicks}c / {q.impressions}i / pos {q.position.toFixed(1)}
          </span>
        </div>
      ))}
    </>
  );
}

function PageRows({ pages }: { pages: SearchConsolePage[] }) {
  const host = storeHost(pages);
  return (
    <>
      {pages.slice(0, PAGE_LIMIT).map((p, i) => {
        const cls = PAGE_CLASS[p.page_class] ?? { label: p.page_class, tone: 'neutral' as Tone };
        return (
          <div key={i} className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 min-w-0">
              <Chip tone={cls.tone}>{cls.label}</Chip>
              <span className="truncate" title={p.page}>
                {pageLabel(p.page, host)}
              </span>
            </span>
            <span className="text-[11px] shrink-0" style={muted}>
              {p.impressions}i / pos {p.position.toFixed(1)}
              {p.organic ? ` / ${p.organic.sessions} sessions` : ''}
            </span>
          </div>
        );
      })}
    </>
  );
}

function SubHead({ children }: { children: ReactNode }) {
  return (
    <div className="text-[10px] uppercase tracking-wide" style={muted}>
      {children}
    </div>
  );
}

/** The Search Console column, pure: the tab and the pages toggle come in as props. */
export function StoreSearchView({
  gsc,
  tab,
  onTab,
  pagesOpen,
  onTogglePages,
}: {
  gsc: SearchConsolePerformanceSection;
  tab: SearchQueryClass;
  onTab: (t: SearchQueryClass) => void;
  pagesOpen: boolean;
  onTogglePages: () => void;
}) {
  const queries = gsc.top_queries ?? [];
  const pages = gsc.top_pages ?? [];
  const hidden = gsc.hidden_impressions ?? 0;
  const classed = gsc.by_class != null || queries.some((q) => q.class != null);
  const tabRows = queries.filter((q) => q.class === tab);
  const tabCount = (c: SearchQueryClass) =>
    gsc.by_class?.[c]?.impressions ?? queries.filter((q) => q.class === c).reduce((s, q) => s + q.impressions, 0);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <div className="flex gap-4 text-[11px]" style={muted}>
          <span>{gsc.total_clicks} clicks</span>
          <span>{gsc.total_impressions} impressions</span>
          <span>avg pos {gsc.avg_position}</span>
        </div>
        {hidden > 0 && (
          <div className="text-[11px]" style={muted}>
            {num(hidden)} impressions on searches Google keeps private
          </div>
        )}
      </div>

      {gsc.product_search && <ProductSearchBlock ps={gsc.product_search} />}

      {queries.length === 0 ? (
        pages.length > 0 ? (
          <>
            <SubHead>Top pages</SubHead>
            <PageRows pages={pages} />
          </>
        ) : hidden > 0 ? null : (
          <p style={muted}>No query data yet.</p>
        )
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            {classed ? (
              <Segmented
                ariaLabel="Query class"
                value={tab}
                onChange={onTab}
                options={QUERY_TABS.map((t) => ({ ...t, label: `${t.label} · ${num(tabCount(t.value))}` }))}
              />
            ) : (
              <SubHead>Top queries</SubHead>
            )}
            {pages.length > 0 && (
              <SmallButton onClick={onTogglePages} title="Top pages by impressions">
                {pagesOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                Top pages ({Math.min(pages.length, PAGE_LIMIT)})
              </SmallButton>
            )}
          </div>
          {!classed ? (
            <QueryRows queries={queries} />
          ) : tabRows.length > 0 ? (
            <QueryRows queries={tabRows} />
          ) : (
            <p style={muted}>No {QUERY_TABS.find((t) => t.value === tab)!.label.toLowerCase()} queries in this window.</p>
          )}
          {pagesOpen && pages.length > 0 && (
            <>
              <SubHead>Top pages</SubHead>
              <PageRows pages={pages} />
            </>
          )}
        </>
      )}

      {(gsc.terms_version != null || gsc.window) && (
        <div className="text-[10px]" style={muted}>
          {[
            gsc.terms_version != null ? `terms v${gsc.terms_version}` : null,
            gsc.window ? `${gsc.window.start}–${gsc.window.end}` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </div>
      )}
    </div>
  );
}

function StoreSearch({ gsc }: { gsc: SearchConsolePerformanceSection }) {
  const [tab, setTab] = useState<SearchQueryClass>('non_brand');
  const [pagesOpen, setPagesOpen] = useState(false);
  return (
    <StoreSearchView
      gsc={gsc}
      tab={tab}
      onTab={setTab}
      pagesOpen={pagesOpen}
      onTogglePages={() => setPagesOpen((o) => !o)}
    />
  );
}

/**
 * Store Performance -- live Shopify catalog diff (new listings, price
 * changes, stockouts) + Search Console totals, product-search metric, query
 * classes and top pages (contract v1.11), per configured store.
 * First genuinely operational dashboard panel (Phase A of
 * BUSINESS_ROADMAP.md). Multi-store: one section per store in the Hermes
 * feed; each store's two sources are still independent (a store can have Shopify connected without Search
 * Console configured, or vice versa). Since 2026-09-25 the data comes from
 * the Hermes panel feed (proxied by /api/store-performance), so the panel
 * also shows its age and a stale marker when Hermes has fallen behind.
 */
export function StorePerformancePanel() {
  const [data, setData] = useState<StorePerformancePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await fetchStorePerformance();
      setData(d);
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load store performance.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, REFRESH_MS);
    return () => clearInterval(interval);
  }, [load]);

  const stores = data?.stores ?? [];

  return (
    <DashboardPanel
      icon={ShoppingBag}
      title="Store Performance"
      tag="30 min"
      size="full"
      priority
      loading={loading}
      error={error}
      onRegenerate={load}
    >
      <FeedFreshness
        ageSeconds={data?.age_seconds}
        stale={data?.stale}
        staleTitle="The Hermes feed has missed its last refreshes -- showing the last good copy."
        className="mb-3"
      />
      {stores.length === 0 ? (
        <p style={{ color: 'var(--color-text-tertiary)' }}>
          No stores in the Hermes feed yet.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {stores.map((store, i) => (
            <div key={store.slug}>
              {stores.length > 1 && (
                <div
                  className="text-[11px] font-semibold uppercase tracking-wide mb-2"
                  style={{
                    color: 'var(--color-text-secondary)',
                    borderTop: i > 0 ? '1px solid var(--color-border)' : 'none',
                    paddingTop: i > 0 ? 12 : 0,
                  }}
                >
                  {store.display_name}
                </div>
              )}
              <StoreSection store={store} />
            </div>
          ))}
        </div>
      )}
    </DashboardPanel>
  );
}
