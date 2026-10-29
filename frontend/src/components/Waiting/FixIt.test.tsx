import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FiledView, WaitingListView, type RowActions } from './WaitingListView';
import { ReportsView } from './ReportsDrawer';
import { CompliancePanel, groupFindings, orderGroups, ruleNo } from '../Commerce/CompliancePanel';
import { RecommendationCard } from '../Commerce/RecommendationsQueue';
import type { ComplianceFindings, LedgerItem } from '../../lib/commerce-api';
import {
  dismissOrder,
  filedRows,
  fixRec,
  groupItems,
  patchHref,
  rowStatusText,
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
const actions: RowActions = { status: {}, onDispatch: noop, onSnooze: noop, onFix: noop, onDismiss: noop, onNavigate: noop };

const item = (over: Partial<WaitingItem>): WaitingItem => ({
  kind: 'rec',
  id: 'aaa111aaa111',
  source_feed: 'ecom_recommendations',
  scope: 'store-a',
  title: 'Content brief: a sample product page',
  detail: 'Add a sample section',
  created_at: iso(600),
  due: null,
  priority: 1,
  link: { page: '/commerce', focus: 'aaa111aaa111' },
  lane: 'act',
  delegate: null,
  times_seen: 1,
  last_seen: null,
  ...over,
});

const FIX = item({ fix: true, fix_patch_id: null });
const READY = item({ id: 'bbb222bbb222', fix: true, fix_patch_id: 'cdcdcdcdcdcd' });
const DELEGATE = item({
  id: 'ccc333ccc333',
  lane: 'delegate',
  fix: false,
  delegate: { target: 'workorder', repo: 'foundry', scope: 'read-only' },
});
const WORKORDER = item({
  kind: 'workorder',
  id: 'wo-20260101-sample-order-a1b2c3',
  source_feed: 'workorders',
  title: 'Work order wo-20260101-sample-order-a1b2c3: blocked',
  link: null,
  opens: 'workorder',
});

const list = (items: WaitingItem[], lane: 'act' | 'delegate' = 'act', a: RowActions = actions) =>
  renderToStaticMarkup(
    <WaitingListView
      groups={groupItems({ items, counts: { total: items.length } }, lane)}
      now={NOW}
      onOpen={noop}
      actions={a}
    />,
  );

afterEach(() => vi.unstubAllGlobals());

const stubFetch = () => {
  const fn = vi.fn(async () => new Response('{}', { status: 202, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fn);
  return fn;
};

describe('Fix it (hq 0024 J1)', () => {
  it('a fix: true rec shows Fix it in place of Dispatch, with Snooze beside it', () => {
    const html = list([FIX]);
    expect(html).toContain('data-fix="rec:aaa111aaa111"');
    expect(html).toContain('>Fix it<');
    expect(html).not.toContain('Dispatch to Claude Code');
    expect(html).toContain('data-snooze="rec:aaa111aaa111"');
  });

  it('a fix: false rec renders Dispatch or nothing, as before', () => {
    const del = list([DELEGATE], 'delegate');
    expect(del).toContain('Dispatch to Claude Code (read-only)');
    expect(del).not.toContain('>Fix it<');
    // A row without the field reads as fix: false.
    const plain = list([item({ fix: undefined })]);
    expect(plain).not.toContain('>Fix it<');
    expect(plain).not.toContain('Dispatch to Claude Code');
  });

  it('fix_patch_id shows "patch ready" linking the patch on the Fixes tab', () => {
    expect(patchHref('cdcdcdcdcdcd')).toBe('/commerce?focus=cdcdcdcdcdcd#fixes');
    const html = list([READY]);
    expect(html).toContain('data-patch-ready="cdcdcdcdcdcd"');
    expect(html).toContain('data-href="/commerce?focus=cdcdcdcdcdcd#fixes"');
    expect(list([FIX])).not.toContain('patch ready');
  });

  it('posts the existing accepted decision with the note "fix requested"', async () => {
    const fn = stubFetch();
    await fixRec('aaa111aaa111');
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/api/commerce/recommendations/aaa111aaa111/accepted');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ note: 'fix requested' });
  });

  it('says what came back', () => {
    expect(rowStatusText({ kind: 'fixed' })).toContain('Fix requested');
    const html = list([FIX], 'act', { ...actions, status: { 'rec:aaa111aaa111': { kind: 'fixed' } } });
    expect(html).toContain('data-row-status="fixed"');
    expect(html).not.toContain('>Fix it<');
  });

  it('a rec card on the Commerce page shows "patch ready" and a theme note', () => {
    const rec: LedgerItem = {
      id: 'bbb222bbb222',
      created_at: iso(600),
      store: 'store-a',
      category: 'content',
      priority: 2,
      title: 'A sample rec',
      detail: { id: 'bbb222bbb222', store: 'store-a', category: 'content', priority: 2, title: 'A sample rec', note: 'needs the theme (sample)' },
      status: 'open',
      decided_at: null,
      note: null,
      fix_patch_id: 'cdcdcdcdcdcd',
    };
    const html = renderToStaticMarkup(
      <RecommendationCard item={rec} storeName="Store A" productTitles={{}} onDecide={noop} onOpenFix={noop} />,
    );
    expect(html).toContain('data-patch-ready="cdcdcdcdcdcd"');
    expect(html).toContain('needs the theme (sample)');
  });
});

describe('Filed (hq 0024 J1, J4)', () => {
  const w = (over: Partial<Waiting>): Pick<Waiting, 'counts' | 'filed'> => ({ counts: { total: 0 }, ...over });

  it('lists theme recs with their note, apart from the compliance count', () => {
    const theme = [{ id: 'ddd444ddd444', store: 'store-a', title: 'Add structured data', note: 'needs the theme (sample)' }];
    const rows = filedRows(w({ counts: { total: 9, fyi: 4, workorder_done: 1 }, filed: { theme } }));
    expect(rows.map((r) => [r.key, r.count])).toEqual([
      ['recs', 2],
      ['theme', 1],
      ['workorders', 1],
    ]);
    const html = renderToStaticMarkup(<FiledView rows={rows} onOpen={noop} />);
    expect(html).toContain('data-filed-note="ddd444ddd444"');
    expect(html).toContain('needs the theme (sample)');
  });

  it('keeps dismissed work orders reachable', () => {
    const rows = filedRows(w({ counts: { total: 0, fyi: 0, workorder_dismissed: 1 } }));
    expect(rows).toEqual([{ key: 'dismissed', label: 'Work order dismissed', count: 1, opens: 'workorder' }]);
  });
});

describe('Dismiss (hq 0024 J4)', () => {
  it('a work-order row shows Dismiss; other rows do not', () => {
    const html = list([WORKORDER, FIX]);
    expect(html).toContain('data-dismiss="wo-20260101-sample-order-a1b2c3"');
    expect((html.match(/data-dismiss=/g) ?? []).length).toBe(1);
    const gone = list([WORKORDER], 'act', { ...actions, status: { [`workorder:${WORKORDER.id}`]: { kind: 'dismissed' } } });
    expect(gone).not.toContain('data-dismiss=');
    expect(gone).toContain('the report still opens from Filed');
  });

  it('posts the id and a one-line note of at most 200 characters', async () => {
    const fn = stubFetch();
    await dismissOrder('wo-20260101-sample-order-a1b2c3', `read it\n${'x'.repeat(300)}`);
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/api/workorders/wo-20260101-sample-order-a1b2c3/dismiss');
    const note = JSON.parse(String(init.body)).note as string;
    expect(note.startsWith('read it x')).toBe(true);
    expect(note).not.toContain('\n');
    expect(note.length).toBe(200);
  });

  const report = (over: Partial<WorkOrderReport>): WorkOrderReport => ({
    id: 'wo-20260101-sample-order-a1b2c3',
    status: 'blocked',
    repo: 'hermes',
    scope: 'read-only',
    branch: null,
    costUsd: 0.4,
    finishedAt: iso(60),
    reason: null,
    needsHuman: 'A sample question',
    summary: 'A sample summary',
    ...over,
  });

  it('the drawer offers Dismiss, and marks a dismissed report', () => {
    const open = renderToStaticMarkup(<ReportsView reports={[report({})]} open="*" now={NOW} onDismiss={noop} />);
    expect(open).toContain('data-dismiss="wo-20260101-sample-order-a1b2c3"');
    const done = renderToStaticMarkup(
      <ReportsView
        reports={[report({ dismissedAt: '2026-10-29T12:00:00Z', dismissNote: 'moot now' })]}
        open="*"
        now={NOW}
        onDismiss={noop}
      />,
    );
    expect(done).toContain('data-dismissed="wo-20260101-sample-order-a1b2c3"');
    expect(done).toContain('dismissed ');
    expect(done).toContain('moot now');
    expect(done).not.toContain('data-dismiss=');
    // Without the callback the drawer stays read-only.
    expect(renderToStaticMarkup(<ReportsView reports={[report({})]} open="*" now={NOW} />)).not.toContain('<button');
  });
});

describe('Compliance severity (hq 0024 J3)', () => {
  const findings = {
    generated_at: iso(60),
    age_seconds: 3600,
    stale: false,
    run_at: iso(60),
    counts: { open: 3, open_by_property: { propa: 3 }, block: 1, fix: 2 },
    store_properties: { 'store-a': 'propa' },
    by_rule: [
      { store: 'store-a', rule: 'Rule 2: Sample wording', rule_no: 2, open: 2, newest_at: iso(120), severity: 'fix' },
      { store: 'store-a', rule: 'Rule 9: Sample claims', rule_no: 9, open: 1, newest_at: iso(240), severity: 'block' },
    ],
    open_findings: [
      { id: 'f1', property: 'propa', rule: 'Rule 2: Sample wording', severity: 'fix' },
      { id: 'f2', property: 'propa', rule: '2. Sample wording, older text', severity: 'fix' },
      { id: 'f3', property: 'propa', rule: 'R9 sample claims', severity: 'block' },
    ],
  } as ComplianceFindings;

  it('chips every group, block groups first, with the counts in the header', () => {
    const html = renderToStaticMarkup(<CompliancePanel findings={findings} />);
    expect(html).toContain('data-severity-counts');
    expect(html).toContain('1 block');
    expect(html).toContain('2 fix');
    const groups = html.split('<details data-rule-group').slice(1);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toContain('data-severity="block"');
    expect(groups[0]).toContain('Rule 9: Sample claims');
    expect(groups[1]).toContain('data-severity="fix"');
    expect(orderGroups(findings.by_rule!).map((g) => g.rule_no)).toEqual([9, 2]);
  });

  it('shows each finding its severity, matched to its group by rule number', () => {
    expect(ruleNo('Rule 9: x')).toBe(9);
    expect(ruleNo('Rule #9 x')).toBe(9);
    expect(ruleNo('R9 x')).toBe(9);
    expect(ruleNo('12. x')).toBe(12);
    expect(ruleNo('Real-world claims')).toBeNull();
    expect(groupFindings(findings.by_rule![0], findings).map((f) => f.id)).toEqual(['f1', 'f2']);
    expect(groupFindings(findings.by_rule![1], findings).map((f) => f.id)).toEqual(['f3']);
    const html = renderToStaticMarkup(<CompliancePanel findings={findings} />);
    expect((html.match(/data-severity="fix"/g) ?? []).length).toBe(1 + 2);
  });

  it('an older feed shows no severity', () => {
    const old = {
      ...findings,
      counts: { open: 3 },
      by_rule: findings.by_rule!.map(({ severity: _s, ...g }) => g),
      open_findings: findings.open_findings!.map(({ severity: _s, ...f }) => f),
    } as ComplianceFindings;
    const html = renderToStaticMarkup(<CompliancePanel findings={old} />);
    expect(html).not.toContain('data-severity');
  });
});
