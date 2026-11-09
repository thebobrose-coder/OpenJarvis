import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AdsFlightsTab } from './AdsFlightsTab';
import { ComplianceTab } from './ComplianceTab';
import { RECS_VISIBLE } from './RecommendationsQueue';
import { linkFor } from '../../lib/waiting-api';
import type { AdsHold } from '../../lib/commerce-api';
import type { Spark } from '../../lib/content-api';

// Neutral fixtures only.
const HOLD: AdsHold = {
  flights: {
    'flight-1': {
      verdict: 'hold',
      scope: 'collection sample',
      unresolved: ['product sample-handle: no Merchant Center offer'],
      targets: [{ kind: 'product', target: 'sample-handle', product_id: 'p1' }],
      merchant: { role_confirmed: 'READ_ONLY', items: [] },
    },
    'flight-2': { verdict: 'clear', scope: 'collection other', unresolved: [], targets: [], merchant: null },
  },
} as unknown as AdsHold;

const SPARKS: Spark[] = [
  {
    flight: 'flight-1',
    rule: 'top Short by viewed share',
    candidates: [{ video_id: 'v1', title: 'Sample Short', views: 120, avg_view_pct: 61.5 }],
    pick: 'v1',
    reason: 'Highest viewed share in the window.',
  },
];

describe('Phase 2: Ads & flights tab', () => {
  it('one card per flight, the spark picks and the spend ledger, dimmed', () => {
    const html = renderToStaticMarkup(<AdsFlightsTab stores={[]} adsHold={HOLD} sparks={SPARKS} spend={null} />);
    expect(html).toContain('data-flight="flight-1"');
    expect(html).toContain('data-flight="flight-2"');
    expect(html).toContain('no Merchant Center offer');
    expect(html).toContain('id="spark-flight-1"');
    expect(html).toContain('pick ready');
    expect(html).toContain('moves to Ops');
    expect(html).toContain('No spend ledger read yet.');
  });
  it('says so without verdicts or picks', () => {
    const html = renderToStaticMarkup(<AdsFlightsTab stores={[]} adsHold={null} sparks={[]} spend={null} />);
    expect(html).toContain('No ads-hold verdict yet');
    expect(html).toContain('No spark picks');
  });
});

describe('Phase 2: Compliance tab', () => {
  it('leads with the pre-check card and keeps the compliance anchor', () => {
    const html = renderToStaticMarkup(<ComplianceTab findings={null} />);
    expect(html).toContain('id="commerce-compliance"');
    expect(html.indexOf('Paste and check')).toBeLessThan(html.indexOf('No compliance run yet'));
  });
});

describe('Phase 2: links and caps', () => {
  it('spark and spend rows land on the Ads & flights tab whatever page the feed names', () => {
    expect(linkFor({ link: { page: '/content', focus: 'spark-flight-1' } })).toBe('/commerce?tab=ads&focus=spark-flight-1');
    expect(linkFor({ link: { page: '/commerce', focus: 'spend-aws-total' } })).toBe('/commerce?tab=ads&focus=spend-aws-total');
    expect(linkFor({ link: { page: '/commerce', focus: 'abc' } })).toBe('/commerce?focus=abc');
  });
  it('the recommendations panel shows 18 before Show all', () => {
    expect(RECS_VISIBLE).toBe(18);
  });
});
