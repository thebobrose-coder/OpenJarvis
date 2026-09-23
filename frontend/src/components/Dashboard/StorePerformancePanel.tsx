import { useCallback, useEffect, useState } from 'react';
import { Search, ShoppingBag, TrendingDown, TrendingUp } from 'lucide-react';
import { fetchStorePerformance } from '../../lib/api';
import type { StorePerformancePayload, StorePerformanceEntry } from '../../lib/api';
import { DashboardPanel } from './DashboardPanel';

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
            Connect this store in Data Sources to populate this.
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
            Connect Google Search Console in Data Sources to populate this.
          </p>
        ) : gsc.error ? (
          <p style={{ color: 'var(--color-error)' }}>{gsc.error}</p>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex gap-4 text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
              <span>{gsc.total_clicks} clicks</span>
              <span>{gsc.total_impressions} impressions</span>
              <span>avg pos {gsc.avg_position}</span>
            </div>
            {(gsc.top_queries?.length ?? 0) === 0 ? (
              <p style={{ color: 'var(--color-text-tertiary)' }}>No query data yet.</p>
            ) : (
              gsc.top_queries!.slice(0, 8).map((q, i) => (
                <div key={i} className="flex items-center justify-between gap-2">
                  <span className="truncate">{q.query}</span>
                  <span className="text-[11px] shrink-0" style={{ color: 'var(--color-text-tertiary)' }}>
                    {q.clicks}c / {q.impressions}i / pos {q.position.toFixed(1)}
                  </span>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Store Performance -- live Shopify catalog diff (new listings, price
 * changes, stockouts) + Search Console query totals, per configured store.
 * First genuinely operational dashboard panel (Phase A of
 * BUSINESS_ROADMAP.md). Multi-store (2026-09-22): one section per store
 * added via Data Sources' "Add Store" flow; each store's two sources are
 * still independent (a store can have Shopify connected without Search
 * Console configured, or vice versa).
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
      {stores.length === 0 ? (
        <p style={{ color: 'var(--color-text-tertiary)' }}>
          No stores configured -- add one in Data Sources.
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
