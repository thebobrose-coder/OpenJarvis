import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type {
  ComplianceFindings,
  DailyStore,
  EcomBriefing,
  EcomDaily,
  EcomProducts,
  EcomRecommendations,
  EcomSeoHealth,
  LedgerItem,
} from '../../lib/commerce-api';
import { applyDecisions, reconcileDecisions, type FeedStates } from '../../hooks/useCommerceData';
import { CommerceView } from './CommerceView';
import { ALL_STORES, kpiTotals } from './format';

// Neutral fixtures only: this repo is public.
const META = { generated_at: '2026-09-28T12:00:00Z', age_seconds: 3600, stale: false };

function dailyStore(slug: string, name: string, over: Partial<DailyStore> = {}): DailyStore {
  const w = (orders: number, revenue: number, units: number) => ({ orders, revenue, units });
  return {
    slug,
    display_name: name,
    sales: {
      currency: 'USD',
      yesterday: w(1, 20, 1),
      last_7: w(4, 80, 5),
      prior_7: w(2, 40, 2),
      last_28: w(9, 180, 11),
    },
    catalog: { active: 12, in_stock: 10, out_of_stock: 2, no_custom_seo_meta: 3, missing_barcode: 1 },
    ga4: { connected: false, reason: 'GA4 property not linked yet' },
    alerts: [],
    ...over,
  };
}

const DAILY: EcomDaily = {
  ...META,
  run_at: '2026-09-28T06:45:00',
  stores: [
    dailyStore('store-a', 'Store A', {
      ga4: {
        connected: true,
        sessions_28: 300,
        purchases_28: 4,
        revenue_28: 80,
        ads: {
          cost_28: 40,
          clicks_28: 50,
          impressions_28: 2000,
          revenue_28: 80,
          roas_28: 2,
          campaigns: [
            {
              sessionGoogleAdsCampaignName: 'Sample Campaign',
              advertiserAdCost: 40,
              advertiserAdClicks: 50,
              advertiserAdImpressions: 2000,
              purchaseRevenue: 80,
            },
          ],
          top_queries: [],
        },
      },
    }),
    dailyStore('store-b', 'Store B'),
  ],
};

const PRODUCTS: EcomProducts = {
  ...META,
  run_at: '2026-09-28T06:45:00',
  stores: [
    {
      slug: 'store-a',
      display_name: 'Store A',
      products: [
        {
          id: 'p1',
          title: 'Sample Product',
          price: 19.99,
          inventory: 5,
          in_stock: true,
          url: 'https://example.com/products/sample',
          admin_url: 'https://example.com/admin/products/1',
          score: 7.5,
          ad_policy: null,
          search: { impressions: 120, clicks: 6, position: 8.2 },
          traffic: { paid_sessions: 3 },
          item: { add_to_cart: 2, purchased: 1, revenue: 19.99 },
          flags: ['open_compliance_finding'],
        },
        {
          id: 'p2',
          title: 'Restricted Sample',
          price: 9,
          inventory: 0,
          in_stock: false,
          score: 0,
          ad_policy: 'Restricted category',
          flags: ['ad_policy_excluded'],
        },
      ],
    },
  ],
};

const SEO: EcomSeoHealth = {
  ...META,
  run_at: '2026-09-27T05:00:00',
  stores: [
    {
      slug: 'store-a',
      display_name: 'Store A',
      site: { robots_txt: 200, robots_has_sitemap: true, www_redirects_to_apex: false, missing_page_status: 404 },
      pages_checked: 40,
      issue_counts: { missing_meta_description: 3, not_indexed: 2 },
      index_summary: { PASS: 30, NEUTRAL: 10 },
      pages: [
        {
          url: 'https://example.com/pages/about',
          kind: 'content',
          status: 200,
          issues: [{ severity: 'error', code: 'not_indexed', detail: 'Crawled, not indexed' }],
          index: { verdict: 'NEUTRAL' },
        },
      ],
    },
  ],
};

const BRIEFING: EcomBriefing = {
  ...META,
  run_at: '2026-09-28T07:05:00',
  doc_version: 2,
  headline: 'Start with the best-scored product.',
  sections: {
    products: {
      focus: 'products',
      run_at: '2026-09-28T07:00:00',
      model: 'sample-model',
      headline: 'Advertise Sample Product first.',
      stores: [
        {
          slug: 'store-a',
          summary: 'Store A has one strong candidate.',
          top_targets: [{ product_id: 'p1', title: 'Sample Product', why: 'Best score', suggested_action: 'Run a small test campaign' }],
        },
      ],
    },
    growth: { focus: 'growth', run_at: '2026-09-28T07:05:00', model_error: 'Model call timed out' },
  },
};

function ledgerItem(id: string, over: Partial<LedgerItem> = {}): LedgerItem {
  return {
    id,
    created_at: '2026-09-28T07:00:00',
    store: 'store-a',
    category: 'spend',
    priority: 1,
    title: `Recommendation ${id}`,
    status: 'open',
    decided_at: null,
    note: null,
    detail: {
      id,
      store: 'store-a',
      category: 'spend',
      priority: 1,
      title: `Recommendation ${id}`,
      target: { type: 'product', ref: 'Sample Product', url: 'https://example.com/products/sample' },
      action: 'Start a test campaign',
      rationale: 'Highest score in the catalog',
      expected_impact: 'First paid sales',
      confidence: 'medium',
      effort: 'low',
      owner: 'operator',
      spend: { daily_budget_usd: 10, change: 'start' },
    },
    ...over,
  };
}

const LEDGER: EcomRecommendations = {
  ...META,
  run_at: '2026-09-28T07:10:00',
  counts: { open: 2, accepted: 0, rejected: 0, done: 0, expired: 0 },
  acceptance_rate: null,
  open: [
    ledgerItem('aaaaaaaaaaa1', { priority: 2, category: 'content', title: 'Write a buying guide' }),
    ledgerItem('aaaaaaaaaaa2'),
  ],
  recent_decided: [],
};

const COMPLIANCE: ComplianceFindings = {
  ...META,
  run_at: '2026-09-28T10:30:00',
  counts: { open: 2, new: 1, open_by_property: { 'property-a': 2 } },
};

function state<T>(data: T | null) {
  return { data, loading: false, error: null };
}

function feeds(over: Partial<FeedStates> = {}): FeedStates {
  return {
    ecom_daily: state(DAILY),
    ecom_products: state(PRODUCTS),
    ecom_seo_health: state(SEO),
    ecom_briefing: state(BRIEFING),
    ecom_recommendations: state(LEDGER),
    compliance_findings: state(COMPLIANCE),
    ...over,
  };
}

function render(f: FeedStates, selectedStore = ALL_STORES, pending = {}) {
  return renderToStaticMarkup(
    <CommerceView
      feeds={f}
      pending={pending}
      refreshStatus={{}}
      selectedStore={selectedStore}
      onSelectStore={vi.fn()}
      onRefresh={vi.fn()}
      onDecide={vi.fn()}
    />,
  );
}

describe('CommerceView', () => {
  it('renders every section from the feeds', () => {
    const html = render(feeds());

    // Header: store switcher and per-feed freshness.
    expect(html).toContain('All stores');
    expect(html).toContain('Store A');
    expect(html).toContain('Data · updated 60 min ago');
    // KPIs, summed across stores.
    expect(html).toContain('$40.00'); // yesterday revenue, 2 stores
    expect(html).toContain('+100% vs prior 7');
    // Briefing: first tab, with its top target.
    expect(html).toContain('Advertise Sample Product first.');
    expect(html).toContain('Run a small test campaign');
    // Queue: P1 sorts first; spend suggestion; decision buttons.
    expect(html.indexOf('Recommendation aaaaaaaaaaa2')).toBeLessThan(html.indexOf('Write a buying guide'));
    expect(html).toContain('$10/day · start');
    expect(html).toContain('Accept');
    expect(html).toContain('Reject');
    // Products, ads, SEO, compliance.
    expect(html).toContain('Sample Product');
    expect(html).toContain('title="Restricted category"');
    expect(html).toContain('Sample Campaign');
    expect(html).toContain('2×'); // campaign ROAS
    expect(html).toContain('www → apex');
    expect(html).toContain('property-a · 2');
  });

  it('shows "no data yet" for feeds that have never run, not errors', () => {
    const html = render(
      feeds({
        ecom_briefing: state(null),
        ecom_seo_health: state(null),
        ecom_recommendations: state(null),
        compliance_findings: state(null),
      }),
    );

    expect(html).toContain('No briefing yet');
    expect(html).toContain('No SEO audit yet');
    expect(html).toContain('No recommendations yet');
    expect(html).toContain('No compliance run yet');
    expect(html).not.toContain('var(--color-error)');
  });

  it('keeps zero sales calm and explains a disconnected GA4', () => {
    const zero = dailyStore('store-b', 'Store B', {
      sales: {
        currency: null,
        yesterday: { orders: 0, revenue: 0, units: 0 },
        last_7: { orders: 0, revenue: 0, units: 0 },
        prior_7: { orders: 0, revenue: 0, units: 0 },
        last_28: { orders: 0, revenue: 0, units: 0 },
      },
    });
    const html = render(feeds({ ecom_daily: state({ ...DAILY, stores: [zero] }) }), 'store-b');

    expect(html).toContain('GA4 not connected -- GA4 property not linked yet');
    expect(html).toContain('GA4 isn’t connected');
    expect(html).not.toContain('var(--color-error)');
  });

  it('shows a failed briefing section plainly', () => {
    const html = renderToStaticMarkup(
      <CommerceView
        feeds={feeds({
          ecom_briefing: state({
            ...BRIEFING,
            sections: { products: { focus: 'products', run_at: '2026-09-28T07:00:00', model_error: 'Model call timed out' } },
          }),
        })}
        pending={{}}
        refreshStatus={{}}
        selectedStore={ALL_STORES}
        onSelectStore={vi.fn()}
        onRefresh={vi.fn()}
        onDecide={vi.fn()}
      />,
    );
    expect(html).toContain('model step failed');
    expect(html).toContain('Model call timed out');
    // The rest of the page still renders.
    expect(html).toContain('Recommendation aaaaaaaaaaa2');
  });

  it('filters by the selected store', () => {
    const html = render(feeds(), 'store-b');
    // Store A's product row and top target are gone; the briefing headline,
    // which covers all stores, stays.
    expect(html).not.toContain('Open in the storefront');
    expect(html).not.toContain('Run a small test campaign');
    expect(html).toContain('Advertise Sample Product first.');
    expect(html).toContain('Nothing open for this filter.');
  });

  it('moves an optimistically decided item out of the queue', () => {
    const html = render(feeds(), ALL_STORES, {
      aaaaaaaaaaa2: { decision: 'accepted', note: 'Go ahead', at: Date.now() },
    });
    expect(html).toContain('Go ahead');
    expect(html).toContain('>accepted<');
  });
});

describe('decision reconciliation', () => {
  it('applies local decisions over the ledger', () => {
    const { open, recent } = applyDecisions(LEDGER, {
      aaaaaaaaaaa1: { decision: 'rejected', note: '', at: 1 },
    });
    expect(open.map((i) => i.id)).toEqual(['aaaaaaaaaaa2']);
    expect(recent[0]).toMatchObject({ id: 'aaaaaaaaaaa1', status: 'rejected' });
  });

  it('drops a local decision once the ledger records it', () => {
    const recorded: EcomRecommendations = {
      ...LEDGER,
      open: [LEDGER.open[1]],
      recent_decided: [{ ...LEDGER.open[0], status: 'rejected' }],
    };
    const r = reconcileDecisions(recorded, { aaaaaaaaaaa1: { decision: 'rejected', note: '', at: 1 } }, 2);
    expect(r.pending).toEqual({});
    expect(r.lost).toEqual([]);
  });

  it('keeps a recent unrecorded decision, and gives up after 10 minutes', () => {
    const pending = { aaaaaaaaaaa1: { decision: 'accepted' as const, note: '', at: 0 } };
    expect(reconcileDecisions(LEDGER, pending, 60_000).pending).toEqual(pending);
    expect(reconcileDecisions(LEDGER, pending, 11 * 60_000)).toEqual({ pending: {}, lost: ['aaaaaaaaaaa1'] });
  });
});

describe('kpiTotals', () => {
  it('does not sum money across different currencies', () => {
    const t = kpiTotals([
      dailyStore('store-a', 'Store A'),
      dailyStore('store-b', 'Store B', {
        sales: { ...dailyStore('x', 'x').sales!, currency: 'EUR' },
      }),
    ]);
    expect(t.mixedCurrency).toBe(true);
    expect(t.currency).toBeNull();
  });
});
