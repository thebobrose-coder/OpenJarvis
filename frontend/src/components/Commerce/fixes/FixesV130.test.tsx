import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { crawlComplete, type EcomSeoHealth, type SeoStore } from '../../../lib/commerce-api';
import { isCollectionPatch, supersededBy, type CatalogFixes, type FixStatus, type Patch } from '../../../lib/fixes-api';
import { ALL_STORES } from '../format';
import { fixFor } from '../MerchantPanel';
import { SeoHealthPanel } from '../SeoHealthPanel';
import { FixesTab, type FixesTabProps } from './FixesTab';
import { PatchCard } from './PatchCard';

// Neutral fixtures only: this repo is public. Invented handles, no store copy.
function patch(id: string, status: FixStatus, over: Partial<Patch> = {}): Patch {
  return {
    id,
    patch_sha256: id.padEnd(64, '0'),
    store: 'alpha',
    product_id: '1001',
    product_title: `Sample Item ${id.slice(-2)}`,
    admin_url: 'https://admin.example.test/products/1001',
    fix_class: { store: 'alpha', rule: 'seo:model', field: 'seo.title' },
    source: 'seo',
    checks_profile: 'seo',
    addresses: { finding_ids: [], rec_ids: [], seo_issues: ['title_length'] },
    changes: [{ field: 'seo.title', before: 'Old', before_sha256: 'b'.repeat(64), after: 'A sample title that is long enough to fit' }],
    validator: { passed: true, checks: [{ name: 'length', passed: true }] },
    status,
    edited: false,
    created_at: '2026-11-06T06:00:00Z',
    decided_at: null,
    note: null,
    history: [{ status: 'proposed', at: '2026-11-06T06:00:00Z' }],
    applied: null,
    verified: null,
    ...over,
  };
}

/** A v1.30 collection patch (§5.8): `product_id` is `collection:<n>`. */
const collectionPatch = (id: string, status: FixStatus = 'proposed', over: Partial<Patch> = {}) =>
  patch(id, status, {
    target: 'collection',
    collection_id: 'gid://shopify/Collection/77',
    collection_handle: 'sample-gear',
    product_id: 'collection:77',
    product_title: 'Sample Gear',
    product_url: 'https://shop.example.test/collections/sample-gear',
    admin_url: 'https://admin.example.test/collections/77',
    fix_class: { store: 'alpha', rule: 'seo:collection', field: 'seo.description' },
    addresses: { finding_ids: [], rec_ids: [], seo_issues: ['missing_meta_description'] },
    changes: [{ field: 'seo.description', before: '', before_sha256: 'b'.repeat(64), after: 'A sample description of a sample collection, long enough to sit in the range.' }],
    ...over,
  });

const card = (p: Patch, onOpenPatch?: (id: string) => void) =>
  renderToStaticMarkup(
    <PatchCard
      patch={p}
      storeName="Alpha"
      focused={false}
      panel={null}
      onPanel={() => {}}
      onFocus={() => {}}
      onDecide={() => {}}
      recTitles={{}}
      onOpenPatch={onOpenPatch}
    />,
  );

function feed(patches: Patch[]): CatalogFixes {
  return {
    generated_at: '2026-11-06T07:00:00Z',
    age_seconds: 60,
    stale: false,
    run_at: '2026-11-06T06:00:00Z',
    paused: false,
    writer: { live: true, writes_today: 0, writes_cap: 50, auto_today: 0, auto_cap: 20 },
    counts: {},
    patches,
    classes: [],
  };
}

const tab = (f: CatalogFixes, extra: Partial<FixesTabProps> = {}) =>
  renderToStaticMarkup(
    <FixesTab
      feed={f}
      pending={{}}
      cardNotes={{}}
      paused={false}
      pausePending={false}
      selectedStore={ALL_STORES}
      storeNames={{ alpha: 'Alpha' }}
      recTitles={{}}
      onDecide={async () => true}
      onDecideClass={async () => null}
      onPause={() => {}}
      {...extra}
    />,
  );

describe('collection patches (v1.30 §5.8)', () => {
  it('shows the collection chip beside the class, and both links', () => {
    const html = card(collectionPatch('p-c1'));
    expect(html).toContain('data-target="collection"');
    expect(html).toContain('>collection</span>');
    expect(html).toContain('data-rule="seo:collection"');
    expect(html).toMatch(/title="Open in Shopify admin">Sample Gear<\/button>/);
    expect(html).toContain('data-storefront-link');
    expect(html).toMatch(/title="Open the collection on the storefront">storefront<\/button>/);
    expect(html).toContain('missing meta description');
  });

  it('shows no chip and no storefront link on a product patch', () => {
    const html = card(patch('p-p1', 'proposed', { product_url: 'https://shop.example.test/products/sample' }));
    expect(html).not.toContain('data-target="collection"');
    expect(html).not.toContain('data-storefront-link');
  });

  it('knows a collection patch by target or by its id', () => {
    expect(isCollectionPatch({ target: 'collection', product_id: 'collection:77' })).toBe(true);
    expect(isCollectionPatch({ product_id: 'collection:77' })).toBe(true);
    expect(isCollectionPatch({ product_id: '1001' })).toBe(false);
    expect(isCollectionPatch({ product_id: 'gid://shopify/Product/77' })).toBe(false);
  });

  it('never joins a collection patch to a product row, even one with the same number', () => {
    const patches = [collectionPatch('p-c1'), { ...collectionPatch('p-c2'), product_id: '77' as string, target: 'collection' }];
    expect(fixFor(patches, '77')).toBeNull();
    expect(fixFor(patches, 'collection:77')).toBeNull();
    expect(fixFor([...patches, patch('p-p1', 'proposed', { product_id: '77' })], '77')).toBe('p-p1');
  });

  it('lists seo:collection in the class filter', () => {
    const html = tab(feed([collectionPatch('p-c1')]));
    expect(html).toContain('Alpha · seo:collection · seo.description');
  });
});

describe('superseded (v1.30)', () => {
  const stale = patch('p-old', 'stale', {
    superseded_by: 'p-new',
    history: [
      { status: 'proposed', at: '2026-11-01T06:00:00Z' },
      { status: 'stale', at: '2026-11-06T06:00:00Z', note: "superseded by p-new (applied), written over this patch's text" },
    ],
  });

  it('reads "superseded by <id>", not the live-copy text', () => {
    const html = card(stale);
    expect(html).toContain('data-superseded-by="p-new"');
    expect(html).toContain('superseded by');
    expect(html).toContain('p-new');
    expect(html).not.toContain('the live copy changed since the fix was made');
    expect(html).not.toMatch(/<button[^>]*>p-new<\/button>/);
  });

  it('wins over a writer stale reason on the same card', () => {
    const html = card({ ...stale, history: [...stale.history, { status: 'stale', at: '2026-11-06T07:00:00Z', reason: 'stale' }] });
    expect(html).not.toContain('data-status-reason');
    expect(html).toContain('Why stale: superseded by');
  });

  it('links the id when the patch is in the feed', () => {
    expect(card(stale, () => {})).toMatch(/<button[^>]*title="Open the patch that replaced this one"[^>]*>p-new<\/button>/);
    const inFeed = tab(feed([stale, patch('p-new', 'proposed')]), { initialFocus: 'p-old' });
    expect(inFeed).toMatch(/<button[^>]*>p-new<\/button>/);
    const missing = tab(feed([stale]), { initialFocus: 'p-old' });
    expect(missing).toContain('data-superseded-by="p-new"');
    expect(missing).not.toMatch(/<button[^>]*>p-new<\/button>/);
  });

  it('keeps the generic stale text without superseded_by', () => {
    const html = card({ ...stale, superseded_by: null, history: [{ status: 'stale', at: '2026-11-06T06:00:00Z', reason: 'stale' }] });
    expect(html).toContain('the live copy changed since the fix was made');
    expect(supersededBy({ status: 'stale', superseded_by: null })).toBeNull();
    expect(supersededBy({ status: 'proposed', superseded_by: 'p-new' })).toBeNull();
  });
});

describe('the SEO tile: crawl reach and the collections block (v1.30 §4.3)', () => {
  const store = (over: Partial<SeoStore> = {}): SeoStore => ({
    slug: 'alpha',
    display_name: 'Alpha',
    domain: 'example.test',
    site: { robots_txt: 200, robots_has_sitemap: true, www_redirects_to_apex: true, missing_page_status: 404 },
    pages_checked: 120,
    issue_counts: {},
    index_summary: {},
    pages: [],
    ...over,
  } as SeoStore);
  const tile = (s: SeoStore) => {
    const seo = { generated_at: '', age_seconds: 0, stale: false, run_at: '2026-11-08T05:00:00Z', stores: [s] } as unknown as EcomSeoHealth;
    return renderToStaticMarkup(<SeoHealthPanel seo={seo} selectedStore={ALL_STORES} />);
  };

  it('renders nothing for the blocks before the key exists', () => {
    const html = tile(store());
    expect(html).not.toContain('data-crawl');
    expect(html).not.toContain('Collections:');
  });

  it('shows the collections block beside the product crawl, with its counts', () => {
    const html = tile(
      store({
        product_crawl: { read: 95, total: 100, partial: false, gave_up: [] },
        collections: {
          read: 14,
          total: 15,
          partial: false,
          gave_up: [],
          complete: true,
          issue_counts: { missing_meta_description: 9, title_length: 3, meta_description_length: 0 },
          items: [],
        },
      }),
    );
    expect(html).toContain('data-crawl="Products"');
    expect(html).toContain('Products: 95/100 read');
    expect(html).toContain('data-crawl="Collections"');
    expect(html).toContain('Collections: 14/15 read');
    expect(html).toContain('data-collection-issue="missing_meta_description"');
    expect(html).toContain('missing meta description · 9');
    expect(html).not.toContain('data-collection-issue="meta_description_length"');
    expect(html).not.toContain('incomplete');
  });

  it('marks a partial or under-90 % collections crawl incomplete, naming the host', () => {
    const html = tile(
      store({
        collections: {
          read: 15,
          total: 15,
          partial: true,
          gave_up: [{ host: 'shop.example.test', attempted: 12, refused: 4, rule: 'share' }],
          issue_counts: {},
        },
      }),
    );
    expect(html).toContain('data-complete="false"');
    expect(html).toContain('incomplete');
    expect(html).toContain('gave up on shop.example.test');
  });

  it('applies the complete-crawl rule: 90 % floor, partial forces incomplete, Hermes verdict wins', () => {
    expect(crawlComplete({ read: 90, total: 100 })).toBe(true);
    expect(crawlComplete({ read: 89, total: 100 })).toBe(false);
    expect(crawlComplete({ read: 100, total: 100, partial: true })).toBe(false);
    expect(crawlComplete({ read: 50, total: 100, complete: true })).toBe(true);
    expect(crawlComplete({ read: 0, total: 0 })).toBe(true);
  });
});
