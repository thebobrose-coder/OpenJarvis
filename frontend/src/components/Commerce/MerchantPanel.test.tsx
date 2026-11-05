import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AdsHold, MerchantStatus, MerchantStore } from '../../lib/commerce-api';
import type { Patch } from '../../lib/fixes-api';
import { ALL_STORES } from './format';
import { MerchantPanel, WAITING_ON_FOUNDRY, clipCount, fixFor, merchantBlockers, roleOk } from './MerchantPanel';

// Neutral fixtures only: this repo is public.
const META = { generated_at: '2026-11-04T08:04:00Z', age_seconds: 600, stale: false };

function row(over: Partial<MerchantStore> = {}): MerchantStore {
  return {
    store: 'store-a',
    display_name: 'Store A',
    property_id: 'property-a',
    offers_total: 120,
    approved: 118,
    pending: 1,
    disapproved: 1,
    limited: 30,
    disapproved_by_context: { DEMAND_GEN_ADS: 12 },
    with_video: 7,
    video_coverage: {
      clips_in_feed: null,
      offers_with_video: 7,
      products_with_video: 2,
      clips_under_review: null,
      products_clip_no_video: null,
    },
    top_issues: [{ code: 'sample_issue_code', count: 4, severity: 'DISAPPROVED' }],
    last_checked: '2026-11-04T08:03:00Z',
    role_confirmed: 'READ_ONLY',
    error: null,
    ...over,
  };
}

const FEED = (stores: MerchantStore[]): MerchantStatus => ({ ...META, run_at: '2026-11-04T08:03:00Z', stores });
const STORES = [
  { slug: 'store-a', display_name: 'Store A' },
  { slug: 'store-b', display_name: 'Store B' },
];

const patch = (id: string, product_id: string, status: Patch['status'], created_at: string) =>
  ({ id, product_id, status, created_at }) as Pick<Patch, 'id' | 'product_id' | 'status' | 'created_at'>;

function render(props: Partial<Parameters<typeof MerchantPanel>[0]> = {}) {
  return renderToStaticMarkup(
    <MerchantPanel merchant={FEED([row()])} selectedStore={ALL_STORES} stores={STORES} {...props} />,
  );
}

describe('MerchantPanel', () => {
  it('renders a store card with counts, limited, video coverage and the READ_ONLY chip', () => {
    const html = render();
    expect(html).toContain('data-merchant-store="store-a"');
    expect(html).toContain('data-role-ok="true"');
    expect(html).toContain('data-role="READ_ONLY"');
    expect(html).toContain('>READ_ONLY<');
    expect(html).toContain('>120<');
    expect(html).toContain('30 limited');
    expect(html).toContain('demand gen ads 12');
    expect(html).toContain('data-issue="sample_issue_code"');
    expect(html).toContain('Offers with a video link');
  });

  it('shows the clip-side keys as waiting on Foundry, never 0', () => {
    const html = render();
    expect(html.split(WAITING_ON_FOUNDRY).length - 1).toBe(3);
    expect(clipCount(null)).toBe(WAITING_ON_FOUNDRY);
    expect(clipCount(0)).toBe('0');
  });

  it('greys the card and shows a red chip on any other role', () => {
    const bad = row({ role_confirmed: 'STANDARD', offers_total: null, approved: null, pending: null, disapproved: null });
    const html = render({ merchant: FEED([bad]) });
    expect(html).toContain('data-role-ok="false"');
    expect(html).toContain('role STANDARD');
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('Fix the principal in Merchant Center');
    expect(html).not.toContain('>READ_ONLY<');
    expect(roleOk('READ_ONLY')).toBe(true);
    expect(roleOk('ADMIN')).toBe(false);
    expect(roleOk(null)).toBe(false);
  });

  it('names a store with no principal yet, and filters by the selected store', () => {
    expect(render()).toContain('No Merchant Center principal yet for Store B');
    const onlyA = render({ selectedStore: 'store-a' });
    expect(onlyA).not.toContain('Store B');
    const onlyB = render({ selectedStore: 'store-b' });
    expect(onlyB).not.toContain('data-merchant-store');
    expect(onlyB).toContain('No Merchant Center principal yet for Store B');
  });

  it('says so when the feed has not run', () => {
    expect(render({ merchant: null })).toContain('No Merchant Center read yet.');
  });

  it('has no button that writes: the only button opens a Fixes entry', () => {
    const html = render({ adsHold: HOLD });
    expect(html).not.toContain('data-open-fix');
    expect(html).not.toMatch(/<form|method="post"/i);
  });
});

const HOLD: AdsHold = {
  run_at: '2026-11-05T11:30:00Z',
  flights: {
    'flight-1': {
      verdict: 'clear',
      open: 0,
      items: [],
      scope: "compliance only; Merchant Center status is the operator's check",
    },
    'flight-2': {
      verdict: 'blocked',
      open: 0,
      items: [],
      scope: 'compliance and Merchant Center (live read 2026-11-05T11:10:00Z, role READ_ONLY)',
      targets: [
        { kind: 'product', target: 'sample-handle', product_id: '1001' },
        { kind: 'product', target: 'other-handle', product_id: '1002' },
      ],
      unresolved: ['product third-handle: no Merchant Center offer', 'page /x: never checked by the sentinel'],
      merchant: {
        last_checked: '2026-11-05T11:10:00Z',
        role_confirmed: 'READ_ONLY',
        items: [
          { handle: 'sample-handle', codes: ['sample_code'], contexts: ['SHOPPING_ADS'], offers: 2, offers_total: 2, severity: 'block' },
          { handle: 'other-handle', codes: ['sample_code'], contexts: ['DEMAND_GEN_ADS'], offers: 1, offers_total: 3, severity: 'fix' },
        ],
      },
    },
  },
};

describe('ads hold, Merchant part', () => {
  const patches = [patch('fix-old', '1001', 'verified', '2026-10-01T00:00:00Z'), patch('fix-new', '1001', 'proposed', '2026-09-01T00:00:00Z')];

  it('shows each flight with its scope; the Merchant part only where Hermes supplies it', () => {
    const html = render({ adsHold: HOLD });
    expect(html).toContain('data-flight="flight-1"');
    expect(html).toContain('Merchant Center status is the operator');
    expect(html).toContain('data-verdict="blocked"');
    expect(html).toContain('compliance and Merchant Center (live read');
    expect(html).toContain('data-hold-item="sample-handle"');
    expect(html).toContain('data-severity="block"');
    expect(html).toContain('data-severity="fix"');
    expect(html).toContain('2 of 2 offers');
    // Only the Merchant blockers, not the sentinel's.
    expect(html).toContain('third-handle: no Merchant Center offer');
    expect(html).not.toContain('never checked by the sentinel');
    expect(html.split('data-merchant-role').length - 1).toBe(1);
  });

  it('links a disapproval to its Fixes entry when one exists, nothing else', () => {
    const html = render({ adsHold: HOLD, patches: patches as Patch[], onOpenFix: vi.fn() });
    expect(html).toContain('data-open-fix="fix-new"');
    expect(html.split('data-open-fix=').length - 1).toBe(1);
    // Without the Fixes tab there is no link.
    expect(render({ adsHold: HOLD, patches: patches as Patch[] })).not.toContain('data-open-fix');
  });

  it('fixFor prefers a fix waiting on the operator, then the newest', () => {
    expect(fixFor(patches, '1001')).toBe('fix-new');
    expect(fixFor([patch('a', '1', 'verified', '2026-01-01'), patch('b', '1', 'applied', '2026-02-01')], '1')).toBe('b');
    expect(fixFor(patches, '9999')).toBeNull();
    expect(fixFor(patches, undefined)).toBeNull();
  });

  it('merchantBlockers keeps only Merchant lines', () => {
    expect(merchantBlockers(HOLD.flights['flight-2'])).toEqual(['product third-handle: no Merchant Center offer']);
  });
});
