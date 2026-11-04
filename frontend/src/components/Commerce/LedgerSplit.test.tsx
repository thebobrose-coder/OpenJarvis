import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LedgerGroups, RecommendationsQueue, splitLedger, splitNote, waitsOnRecheck } from './RecommendationsQueue';
import { ReportsView } from '../Waiting/ReportsDrawer';
import type { EcomRecommendations, LedgerItem, RecRoute } from '../../lib/commerce-api';
import { fetchReport, type WorkOrderReport } from '../../lib/waiting-api';
import { ALL_STORES } from './format';

// The app store (via waiting-api) reads localStorage when it loads; node has none.
vi.hoisted(() => {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> }).localStorage ??= {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  };
});

// Neutral fixtures only: this repo is public.
const ORDER = 'wo-20260101-sample-plan-order-0a1b2c';
const route = (over: Partial<RecRoute>): RecRoute => ({ route: 'operator', reason: 'owner operator: a check only the operator makes', ref: null, closed_at: null, ...over });
const rec = (id: string, over: Partial<LedgerItem> = {}): LedgerItem => ({
  id,
  created_at: '2026-01-01T00:00:00Z',
  store: 'store-a',
  category: 'content',
  priority: 2,
  title: `Sample rec ${id}`,
  detail: { action: 'Do a sample thing.' } as LedgerItem['detail'],
  status: 'accepted',
  decided_at: '2026-01-02T00:00:00Z',
  note: null,
  ...over,
});

const OPERATOR = rec('op0000000001', { route: route({}) });
const PLAN = rec('plan00000001', { route: route({ reason: 'plan ready: Can the sample be carried out?', ref: ORDER }) });
const UNROUTED = rec('none00000001');
const FIXES = rec('fix000000001', { route: route({ route: 'fixes', reason: 'product copy: the catalog fixer writes it', ref: 'patch-sample-1' }) });
const FINDINGS = rec('find00000001', {
  route: route({ route: 'findings', reason: "store-wide: the sentinel's findings drive the patches — waits on a compliance-sentinel run after its acceptance" }),
});
const WORKORDER = rec('wo0000000001', { route: route({ route: 'workorder', reason: 'delegated by the lane table; a read-only order', ref: 'wo-20260101-sample-order-order-3d4e5f' }) });
const DUPLICATE = rec('dup000000001', {
  status: 'done',
  note: 'auto: duplicate of op0000000001',
  route: route({ reason: 'a duplicate of op0000000001', ref: 'op0000000001', closed_at: '2026-01-03T00:00:00Z' }),
});
const REJECTED = rec('rej000000001', { status: 'rejected', note: 'not this one' });

// Unrouted first in the feed, so "plan ready first" is the sort, not the input.
const ITEMS = [UNROUTED, OPERATOR, FIXES, PLAN, FINDINGS, WORKORDER, DUPLICATE, REJECTED];
const noop = () => {};

const ids = (html: string, attr: string) => [...html.matchAll(new RegExp(`${attr}="([^"]+)"`, 'g'))].map((m) => m[1]);
const between = (html: string, from: string, to?: string) => {
  const start = html.indexOf(from);
  const end = to ? html.indexOf(to, start) : html.length;
  return html.slice(start, end === -1 ? html.length : end);
};

const groups = () =>
  renderToStaticMarkup(
    <LedgerGroups items={ITEMS} storeNames={{ 'store-a': 'Store A' }} onDecide={noop} links={{ onOpenFix: noop, onOpenReport: noop, onOpenCompliance: noop }} />,
  );

describe('the ledger split (v1.28, hq 0027 D6)', () => {
  it('splits accepted recs by route, plan ready first, and keeps the rest as history', () => {
    const { needsYou, inFlight, history } = splitLedger(ITEMS);
    expect(needsYou.map((i) => i.id)).toEqual([PLAN.id, UNROUTED.id, OPERATOR.id]);
    expect(inFlight.map((i) => i.id)).toEqual([FIXES.id, FINDINGS.id, WORKORDER.id]);
    expect(history.map((i) => i.id)).toEqual([DUPLICATE.id, REJECTED.id]);
  });

  it('acceptance 1: three Needs you rows with Done, three In flight rows with links and no Done', () => {
    const html = groups();
    expect(ids(html, 'data-needs-you')).toEqual([PLAN.id, UNROUTED.id, OPERATOR.id]);
    expect(ids(html, 'data-in-flight')).toEqual([FIXES.id, FINDINGS.id, WORKORDER.id]);

    const mine = between(html, 'data-group="needs-you"', 'data-group="in-flight"');
    expect(mine.match(/title="Done: it has been carried out/g)).toHaveLength(3);
    const flying = between(html, 'data-group="in-flight"', 'data-group="history"');
    expect(flying).not.toContain('Done: it has been carried out');
    expect(flying).toContain('data-open-patch="patch-sample-1"');
    expect(flying).toContain('data-open-compliance="store-a"');
    expect(flying).toContain(`data-open-report="${WORKORDER.route!.ref}"`);
  });

  it('a plan ready row shows its reason and opens its report', () => {
    const mine = between(groups(), 'data-group="needs-you"', 'data-group="in-flight"');
    expect(mine).toContain('data-plan-ready');
    expect(mine).toContain('plan ready: Can the sample be carried out?');
    expect(ids(mine, 'data-open-report')).toEqual([ORDER]);
  });

  it('a waits-on reason gets the re-check chip; a plain one does not', () => {
    const flying = between(groups(), 'data-group="in-flight"', 'data-group="history"');
    expect(flying.match(/data-recheck/g)).toHaveLength(1);
    expect(between(flying, `data-in-flight="${FINDINGS.id}"`)).toContain('waiting on a re-check');
    expect(waitsOnRecheck('… — waits on an SEO audit run after its acceptance')).toBe(true);
    expect(waitsOnRecheck('product copy: the catalog fixer writes it')).toBe(false);
  });

  it('a duplicate closes into history with its auto note, and nothing links it', () => {
    const history = between(groups(), 'data-group="history"');
    expect(history).toContain(DUPLICATE.title);
    expect(history).toContain('data-auto-close');
    expect(history).toContain('auto: duplicate of op0000000001');
    expect(history).not.toContain('data-open-');
    expect(history).not.toContain('Done: it has been carried out');
  });

  it('a fixes rec naming a class shows the class; a workorder with no order says so', () => {
    const html = renderToStaticMarkup(
      <LedgerGroups
        items={[
          rec('cls000000001', { route: route({ route: 'fixes', reason: 'store-wide image alt text', ref: 'seo:image_alt' }) }),
          rec('wo0000000002', { route: route({ route: 'workorder', reason: 'delegated', ref: null }) }),
        ]}
        storeNames={{}}
        onDecide={noop}
        links={{ onOpenFix: noop, onOpenReport: noop }}
      />,
    );
    expect(html).toContain('data-fix-class="seo:image_alt"');
    expect(html).not.toContain('data-open-patch');
    expect(html).toContain('no order sent yet');
  });

  it('splits a note into its own part and the router parts', () => {
    expect(splitNote('kept with it | auto: reported done | auto: reopened')).toEqual({ own: 'kept with it', auto: ['auto: reported done', 'auto: reopened'] });
    expect(splitNote(null)).toEqual({ own: '', auto: [] });
  });
});

describe('the panel count (O2)', () => {
  const ledger: EcomRecommendations = {
    generated_at: '2026-01-03T00:00:00Z',
    age_seconds: 60,
    stale: false,
    run_at: '2026-01-03T00:00:00Z',
    counts: { open: 0, accepted: 6, done: 1, rejected: 1, expired: 0 } as EcomRecommendations['counts'],
    acceptance_rate: 0.5,
    open: [],
    recent_decided: ITEMS,
  } as EcomRecommendations;
  const panel = () =>
    renderToStaticMarkup(
      <RecommendationsQueue
        ledger={ledger}
        pending={{}}
        selectedStore={ALL_STORES}
        onSelectStore={noop}
        stores={[{ slug: 'store-a', display_name: 'Store A' }]}
        storeNames={{ 'store-a': 'Store A' }}
        productTitles={{}}
        onDecide={noop}
      />,
    );

  it('the tag reads "3 need you · 3 in flight" and the Accepted tile keeps the full count', () => {
    const html = panel();
    expect(html).toContain('3 need you · 3 in flight');
    expect(html).toMatch(/Accepted<\/[^>]+>\s*<[^>]+>6</);
  });
});

describe('one report by id (A1)', () => {
  afterEach(() => vi.unstubAllGlobals());
  const REPORT: WorkOrderReport = {
    id: ORDER,
    status: 'done',
    repo: 'sample',
    scope: 'read-only',
    branch: null,
    costUsd: 0.1,
    finishedAt: '2026-01-01T00:00:00Z',
    reason: null,
    needsHuman: null,
    summary: 'A sample plan.',
  } as WorkOrderReport;

  it('reads /api/workorders/reports/<id>, and a 404 is no report', async () => {
    const fn = vi.fn(async () => new Response(JSON.stringify(REPORT), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fn);
    expect(await fetchReport(ORDER)).toEqual([REPORT]);
    expect(String((fn.mock.calls[0] as unknown[])[0])).toContain(`/api/workorders/reports/${ORDER}`);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"detail":"No report"}', { status: 404 })));
    expect(await fetchReport(ORDER)).toEqual([]);
  });

  it('an old report renders by id; a missing one says it is gone', () => {
    expect(renderToStaticMarkup(<ReportsView reports={[REPORT]} open={ORDER} now={Date.parse('2026-02-01T00:00:00Z')} />)).toContain('A sample plan.');
    const gone = renderToStaticMarkup(<ReportsView reports={[]} open={ORDER} now={0} />);
    expect(gone).toContain('That report is gone.');
    expect(gone).not.toContain('7 days');
  });
});
