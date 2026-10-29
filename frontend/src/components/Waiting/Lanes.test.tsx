import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { WaitingListView, WaitingTabsView, type RowActions } from './WaitingListView';
import { ReportsView } from './ReportsDrawer';
import { PANEL_ROWS, WaitingPanelView } from '../Dashboard/WaitingPanel';
import { CompliancePanel, groupFindings } from '../Commerce/CompliancePanel';
import type { ComplianceFindings } from '../../lib/commerce-api';
import {
  SNOOZE_DAYS,
  bellCount,
  dispatchLabel,
  filedRows,
  groupItems,
  laneCount,
  linkFor,
  rowStatusText,
  snoozeNote,
  type Waiting,
  type WaitingItem,
  type WorkOrderReport,
} from '../../lib/waiting-api';

// The app store (via WaitingContext) reads localStorage when it loads; node has none.
vi.hoisted(() => {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> }).localStorage ??= {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  };
});

// Neutral fixtures only: this repo is public.
const NOW = Date.parse('2026-10-29T18:00:00Z');
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60000).toISOString();
const noop = () => {};
const actions: RowActions = { status: {}, onDispatch: noop, onSnooze: noop };

const item = (over: Partial<WaitingItem>): WaitingItem => ({
  kind: 'rec',
  id: 'r-1',
  source_feed: 'ecom_recommendations',
  scope: 'store-a',
  title: 'A sample rec',
  detail: 'Why it matters',
  created_at: iso(600),
  due: null,
  priority: 1,
  link: { page: '/commerce', focus: 'r-1' },
  lane: 'act',
  delegate: null,
  times_seen: 1,
  last_seen: null,
  ...over,
});

const PATCH_CLASS = item({
  kind: 'patch_class',
  id: 'store-a:seo:foundry',
  source_feed: 'catalog_fixes',
  title: '3 invalid seo:foundry patches on store-a',
  detail: 'specs: seo.description: sample',
  link: { page: '/commerce#fixes', focus: 'abcdef654321' },
  lane: 'delegate',
  delegate: { target: 'workorder', repo: 'foundry', scope: 'read-only' },
  times_seen: null,
});
const DESK_REC = item({ id: 'r-2', title: 'A desk rec', lane: 'delegate', delegate: { target: 'desk', desk: 'commerce' } });
const SEEN = item({ id: 'r-3', title: 'A repeated rec', times_seen: 3, last_seen: iso(30) });

const laned = (over: Partial<Waiting> = {}): Waiting => ({
  generated_at: iso(0),
  counts: { total: 9, rec: 4, patch_class: 1, act: 3, delegate: 2, fyi: 4, workorder_done: 1 },
  items: [
    item({}),
    SEEN,
    item({ kind: 'proposal', id: 'p-1', source_feed: 'content_proposals', title: 'A sample proposal', link: { page: '/content', focus: 'p-1' }, times_seen: null }),
    DESK_REC,
    PATCH_CLASS,
  ],
  sources: { approvals: { generated_at: iso(2), age_seconds: 120, stale: false } },
  local: true,
  ...over,
});

describe('lanes', () => {
  it('the bell counts the act lane, uncapped from the server', () => {
    expect(bellCount(laned())).toBe(3);
    expect(bellCount(laned({ counts: { total: 9, act: 40 } }))).toBe(40);
    // An older feed without lane counts: every listed row is act.
    const old = laned({ counts: { total: 2 }, items: [item({ lane: undefined }), item({ id: 'r-9', lane: undefined })] });
    expect(bellCount(old)).toBe(2);
    expect(laneCount(laned(), 'delegate')).toBe(2);
  });

  it('groups only the lane asked for, counted as listed', () => {
    const act = groupItems(laned(), 'act');
    expect(act.map((g) => [g.kind, g.count])).toEqual([
      ['proposal', 1],
      ['rec', 2],
    ]);
    const del = groupItems(laned(), 'delegate');
    expect(del.map((g) => g.kind)).toEqual(['patch_class', 'rec']);
  });

  it('files counts only: Hermes fyi to its page, done work orders to the reports drawer', () => {
    expect(filedRows(laned())).toEqual([
      { key: 'recs', label: 'Compliance recommendations with a fix in hand', count: 3, href: '/commerce' },
      { key: 'workorders', label: 'Work order done', count: 1, opens: 'workorder' },
    ]);
  });
});

describe('WaitingTabsView', () => {
  const render = (tab: 'act' | 'delegate' | 'fyi') =>
    renderToStaticMarkup(
      <WaitingTabsView waiting={laned()} tab={tab} onTab={noop} now={NOW} onOpen={noop} onFiled={noop} actions={actions} />,
    );

  it('shows three tabs with their counts', () => {
    const html = render('act');
    expect(html).toMatch(/data-tab="act"[^>]*>For you <span data-tab-count="true">3</);
    expect(html).toMatch(/data-tab="delegate"[^>]*>Dispatch <span data-tab-count="true">2</);
    expect(html).toMatch(/data-tab="fyi"[^>]*>Filed <span data-tab-count="true">4</);
  });

  it('For you lists act rows only, with Snooze on a rec and its day options', () => {
    const html = render('act');
    expect(html).toContain('A sample proposal');
    expect(html).not.toContain('A desk rec');
    expect(html).toContain('data-snooze="rec:r-1"');
    expect(html).not.toContain('data-snooze="proposal:p-1"');
    for (const d of SNOOZE_DAYS) expect(html).toContain(`<option value="${d}"`);
    expect(html).toMatch(/<option value="7" selected=""/);
  });

  it('Dispatch lists delegate rows with their button by target', () => {
    const html = render('delegate');
    expect(html).toContain('Dispatch to Claude Code (read-only)');
    expect(html).toContain('Ask the Commerce desk');
    expect(html).toContain('data-dispatch="patch_class:store-a:seo:foundry"');
    expect(html).not.toContain('A sample proposal');
    // A patch_class row reads like a patch row and opens the Fixes tab on its focus.
    expect(html).toContain('3 invalid seo:foundry patches on store-a');
    expect(html).toContain('data-href="/commerce?focus=abcdef654321#fixes"');
    expect(html).not.toContain('data-snooze="patch_class');
  });

  it('Filed lists counts only', () => {
    const html = render('fyi');
    expect(html).toContain('data-filed="recs"');
    expect(html).toContain('Work order done');
    expect(html).not.toContain('A sample rec');
  });
});

describe('rows', () => {
  it('tags a rec seen twice or more and dates it by last_seen', () => {
    const html = renderToStaticMarkup(<WaitingListView groups={groupItems(laned(), 'act')} now={NOW} onOpen={noop} />);
    expect(html).toContain('seen 3 times');
    expect(html).not.toContain('seen 1 times');
    expect(html).toContain('30m ago'); // last_seen, not created_at
  });

  it('says what came back after an action', () => {
    expect(rowStatusText({ kind: 'dispatched', orderId: 'wo-1', waits: true, decided: true, decideError: null })).toBe(
      "Dispatched as wo-1; today's dispatch cap is reached, so it runs tomorrow; it leaves this list within 2 minutes",
    );
    expect(rowStatusText({ kind: 'error', message: 'days must be 1-30' })).toBe('days must be 1-30');
    const html = renderToStaticMarkup(
      <WaitingListView
        groups={groupItems(laned(), 'delegate')}
        now={NOW}
        onOpen={noop}
        actions={{ ...actions, status: { 'patch_class:store-a:seo:foundry': { kind: 'dispatched', orderId: 'wo-20261029-x-abc123', waits: false, decided: null, decideError: null } } }}
      />,
    );
    expect(html).toContain('Dispatched as wo-20261029-x-abc123');
    expect(html).not.toContain('data-dispatch="patch_class:store-a:seo:foundry"');
  });

  it('labels Dispatch by target and stage, and the snooze note', () => {
    expect(dispatchLabel({ target: 'workorder', repo: 'hermes', scope: 'edit' })).toBe('Dispatch to Claude Code (edit)');
    expect(dispatchLabel(null)).toBeNull();
    expect([1, 3, 7, 14, 30].map(snoozeNote)).toEqual(['1', '3', '', '14', '30']);
    expect(linkFor(PATCH_CLASS)).toBe('/commerce?focus=abcdef654321#fixes');
  });
});

describe('WaitingPanelView (Dashboard)', () => {
  it('shows the For you lane only, at most 10 rows, then "N more"', () => {
    const many = Array.from({ length: 14 }, (_, n) => item({ id: `r-${n}`, title: `Rec ${n}` }));
    const w = laned({ items: [...many, DESK_REC], counts: { total: 15, act: 14, delegate: 1, fyi: 0 } });
    const html = renderToStaticMarkup(
      <WaitingPanelView waiting={w} loading={false} error={null} now={NOW} onOpen={noop} onDecisions={noop} actions={actions} />,
    );
    expect(PANEL_ROWS).toBe(10);
    expect((html.match(/data-kind="rec"/g) ?? []).length).toBe(10);
    expect(html).toContain('4 more');
    expect(html).toContain('14 for you');
    expect(html).not.toContain('A desk rec');
  });
});

describe('ReportsView', () => {
  const report = (over: Partial<WorkOrderReport>): WorkOrderReport => ({
    id: 'wo-1',
    status: 'done',
    repo: 'hermes',
    scope: 'read-only',
    branch: null,
    costUsd: 0.4,
    finishedAt: iso(60),
    reason: null,
    needsHuman: null,
    summary: 'A sample summary',
    ...over,
  });

  it('shows one report read-only, or all of them', () => {
    const reports = [report({}), report({ id: 'wo-2', status: 'failed', summary: 'Another' })];
    const one = renderToStaticMarkup(<ReportsView reports={reports} open="wo-2" now={NOW} />);
    expect(one).toContain('Another');
    expect(one).not.toContain('A sample summary');
    expect(one).not.toContain('<button');
    const all = renderToStaticMarkup(<ReportsView reports={reports} open="*" now={NOW} />);
    expect(all).toContain('$0.40');
    expect(all).toContain('wo-1');
    expect(all).toContain('wo-2');
  });
});

describe('Compliance by rule (v1.22)', () => {
  const findings: ComplianceFindings = {
    generated_at: iso(60),
    age_seconds: 3600,
    stale: false,
    run_at: iso(60),
    counts: { open: 3, open_by_property: { propa: 3 } },
    store_properties: { 'store-a': 'propa' },
    by_rule: [
      { store: 'store-a', rule: 'Rule 9: Sample claims', open: 2, newest_at: iso(120), example_finding_id: 'f1' },
      { store: 'store-a', rule: '9. Sample claims', open: 1, newest_at: iso(240) },
    ],
    open_findings: [
      { id: 'f1', property: 'propa', rule: 'Rule 9: Sample claims', location: '/products/one', quote: 'first quote' },
      { id: 'f2', property: 'propa', rule: 'Rule 9: Sample claims', location: '/products/two' },
      { id: 'f3', property: 'propa', rule: '9. Sample claims', location: '/products/three' },
    ],
  } as ComplianceFindings;

  it('renders each group as served, collapsed, expanding to its findings', () => {
    const html = renderToStaticMarkup(<CompliancePanel findings={findings} />);
    expect(html).toContain('data-by-rule');
    expect((html.match(/<details data-rule-group="store-a"/g) ?? []).length).toBe(2);
    expect(html).toContain('Rule 9: Sample claims');
    expect(html).toContain('9. Sample claims'); // not merged in the app
    expect(html).toContain('newest 2h ago');
    expect(groupFindings(findings.by_rule![0], findings).map((f) => f.id)).toEqual(['f1', 'f2']);
    expect(groupFindings(findings.by_rule![1], findings).map((f) => f.id)).toEqual(['f3']);
  });

  it('shows nothing extra without by_rule', () => {
    const html = renderToStaticMarkup(<CompliancePanel findings={{ ...findings, by_rule: undefined }} />);
    expect(html).not.toContain('data-by-rule');
  });
});
