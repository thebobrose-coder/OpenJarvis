import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SearchConsolePage, SearchConsolePerformanceSection, SearchQueryClass } from '../../lib/api';
import { pageLabel, storeHost, StoreSearchView } from './StorePerformancePanel';

// Invented hosts, queries and numbers only: this repo is public.
const noop = () => {};

function render(gsc: SearchConsolePerformanceSection, tab: SearchQueryClass = 'non_brand', pagesOpen = false) {
  return renderToStaticMarkup(
    <StoreSearchView gsc={gsc} tab={tab} onTab={noop} pagesOpen={pagesOpen} onTogglePages={noop} />,
  );
}

function page(over: Partial<SearchConsolePage> = {}): SearchConsolePage {
  return {
    page: 'https://shop.example.com/products/sample-widget',
    page_class: 'product',
    clicks: 0,
    impressions: 3,
    ctr: 0,
    position: 12.5,
    organic: { sessions: 2, purchases: 0, revenue: 0 },
    ...over,
  };
}

const q = (query: string, cls: SearchQueryClass | undefined, impressions: number) => ({
  query,
  clicks: 0,
  impressions,
  ctr: 0,
  position: 20,
  ...(cls ? { class: cls } : {}),
});

const PRODUCT_SEARCH = {
  pages: 4,
  clicks: 1,
  impressions: 9,
  position: 14.2,
  non_brand_clicks: 1,
  non_brand_impressions: 5,
  brand_impressions: 1,
  noise_impressions: 0,
  unclassified_impressions: 3,
  organic_sessions: 2,
  organic_purchases: 0,
  organic_revenue: 0,
};

const CLASSED: SearchConsolePerformanceSection = {
  connected: true,
  total_clicks: 2,
  total_impressions: 40,
  avg_position: 18.3,
  visible_query_impressions: 31,
  hidden_impressions: 9,
  window: { start: '2026-09-01', end: '2026-09-28' },
  terms_version: 3,
  top_queries: [
    q('sample widget size chart', 'non_brand', 12),
    q('examplebrand widgets', 'brand', 6),
    q('unrelated thing', 'noise', 13),
  ],
  by_class: {
    brand: { queries: 1, clicks: 0, impressions: 6 },
    non_brand: { queries: 2, clicks: 1, impressions: 12 },
    noise: { queries: 1, clicks: 0, impressions: 13 },
  },
  top_pages: [
    page(),
    page({ page: 'https://old.example.org/2025/post', page_class: 'legacy', impressions: 13, organic: null }),
  ],
  product_search: PRODUCT_SEARCH,
};

describe('StoreSearchView', () => {
  it('renders an old-shape store as before', () => {
    const html = render({
      connected: true,
      total_clicks: 3,
      total_impressions: 50,
      avg_position: 9.1,
      top_queries: [q('sample query one', undefined, 30), q('sample query two', undefined, 20)],
    });
    expect(html).toContain('3 clicks');
    expect(html).toContain('50 impressions');
    expect(html).toContain('sample query one');
    expect(html).toContain('sample query two');
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain('Product search');
    expect(html).not.toContain('Top pages');
    expect(html).not.toContain('keeps private');
    expect(render({ connected: true, total_clicks: 0, total_impressions: 0, avg_position: 0, top_queries: [] }))
      .toContain('No query data yet.');
  });

  it('falls back to pages and the hidden note when no query is visible', () => {
    const html = render({
      connected: true,
      total_clicks: 1,
      total_impressions: 4,
      avg_position: 3,
      visible_query_impressions: 0,
      hidden_impressions: 4,
      top_queries: [],
      top_pages: [page(), page({ page: 'https://example.com/', page_class: 'content', organic: null })],
    });
    expect(html).toContain('4 impressions on searches Google keeps private');
    expect(html).toContain('Top pages');
    expect(html).toContain('/products/sample-widget');
    expect(html).toContain('example.com');
    expect(html).not.toContain('No query data yet.');
  });

  it('shows class tabs with counts, Non-brand first and selected', () => {
    const html = render(CLASSED);
    expect(html).toContain('Non-brand · 12');
    expect(html).toContain('Brand · 6');
    expect(html).toContain('Noise · 13');
    expect(html.indexOf('Non-brand · 12')).toBeLessThan(html.indexOf('Brand · 6'));
    expect(html).toMatch(/aria-selected="true"[^>]*>Non-brand · 12/);
    expect(html).toContain('sample widget size chart');
    expect(html).not.toContain('examplebrand widgets');
    expect(html).not.toContain('unrelated thing');
  });

  it('keeps noise reachable, with its tooltip', () => {
    const html = render(CLASSED, 'noise');
    expect(html).toContain('title="Counted in totals; labelled by the Hermes term list"');
    expect(html).toContain('unrelated thing');
    expect(html).not.toContain('sample widget size chart');
    expect(render(CLASSED, 'brand')).toContain('examplebrand widgets');
  });

  it('collapses pages behind a toggle when queries exist', () => {
    expect(render(CLASSED)).not.toContain('/products/sample-widget');
    const open = render(CLASSED, 'non_brand', true);
    expect(open).toContain('/products/sample-widget');
    expect(open).toContain('old.example.org/2025/post');
    expect(open).toContain('legacy');
  });

  it('shows the product-search block as page impressions, zeros as zeros', () => {
    const html = render(CLASSED);
    expect(html).toContain('Product search · page impressions');
    expect(html).toContain('9 impr.');
    expect(html).toContain('5 impr.');
    expect(html).toContain('2 sessions');
    expect(html).toContain('0 purchases · 0.00 revenue');
    expect(html).toContain('terms v3 · 2026-09-01–2026-09-28');
    const zero = render({
      ...CLASSED,
      product_search: { ...PRODUCT_SEARCH, impressions: 0, clicks: 0, pages: 0, organic_sessions: 0 },
    });
    expect(zero).toContain('0 impr.');
    expect(zero).toContain('0 sessions');
  });

  it('says GA4 unavailable when organic is null', () => {
    const html = render({
      ...CLASSED,
      product_search: { ...PRODUCT_SEARCH, organic_sessions: null, organic_purchases: null, organic_revenue: null },
    });
    expect(html).toContain('GA4 unavailable');
  });

  it('hides the product-search block without product_search', () => {
    const { product_search: _, ...rest } = CLASSED;
    expect(render(rest)).not.toContain('Product search');
  });
});

describe('page labels', () => {
  const pages = [
    page({ page: 'https://example.com/', page_class: 'content' }),
    page({ page: 'https://shop.example.com/collections/all', page_class: 'collection' }),
  ];

  it('takes the store host from store pages', () => {
    expect(storeHost(pages)).toBe('shop.example.com');
    expect(storeHost([pages[0]])).toBeNull();
  });

  it('shows paths on the store host and host + path elsewhere', () => {
    expect(pageLabel('https://shop.example.com/collections/all', 'shop.example.com')).toBe('/collections/all');
    expect(pageLabel('https://example.com/', 'shop.example.com')).toBe('example.com');
    expect(pageLabel('https://www.example.com/2025/a', 'shop.example.com')).toBe('www.example.com/2025/a');
  });
});
