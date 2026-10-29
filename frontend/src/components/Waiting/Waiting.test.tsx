import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { EMPTY, WaitingListView, isOpenable } from './WaitingListView';
import { DEFAULT_HINT, DecisionsView } from './DecisionsDrawer';
import { WaitingPanelView } from '../Dashboard/WaitingPanel';
import {
  dueLabel,
  groupItems,
  linkFor,
  sourceAges,
  staleSources,
  type DecisionBox,
  type Decisions,
  type Waiting,
  type WaitingItem,
} from '../../lib/waiting-api';

// The app store reads localStorage when it loads; node has none.
vi.hoisted(() => {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> }).localStorage ??= {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  };
});

// Neutral fixtures only: this repo is public.
const NOW = Date.parse('2026-10-23T18:00:00Z');
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60000).toISOString();
const noop = () => {};

const item = (over: Partial<WaitingItem>): WaitingItem => ({
  kind: 'proposal',
  id: 'p-1',
  source_feed: 'content_proposals',
  scope: 'prop-a',
  title: 'A sample proposal',
  detail: 'Why it matters',
  created_at: iso(90),
  due: null,
  priority: 1,
  link: { page: '/content', focus: 'p-1' },
  ...over,
});

const waiting = (over: Partial<Waiting> = {}): Waiting => ({
  generated_at: iso(0),
  counts: { total: 6, proposal: 1, thesis_prompt: 0, patch: 1, follow_up: 1, rec: 1, g0: 0, decision: 1, x402: 1, workorder: 0 },
  items: [
    item({}),
    item({ kind: 'patch', id: 'abcdef123456', title: 'Sample product · title', link: { page: '/commerce#fixes', focus: 'abcdef123456' } }),
    item({ kind: 'rec', id: 'r-9', title: 'A sample rec', link: { page: '/commerce', focus: 'r-9' } }),
    item({ kind: 'follow_up', id: 42, title: 'Follow-up 2 to Sample', due: '2026-10-22', link: { page: '/bizdev', focus: 42 } }),
    item({ kind: 'decision', id: 'sample/brief.md:4', title: 'D1. Keep the default', link: null, opens: 'decisions' }),
    item({ kind: 'x402', id: 'kill-crypto', title: 'KILL: crypto', link: { page: '/trading', focus: null } }),
  ],
  sources: {
    approvals: { generated_at: iso(2), age_seconds: 120, stale: false, feeds: { content_proposals: iso(3), catalog_fixes: null } },
    trading_status: { generated_at: iso(1), age_seconds: 60, stale: false },
  },
  local: true,
  ...over,
});

describe('waiting-api', () => {
  it('builds each deep link with the focus id', () => {
    expect(linkFor(item({}))).toBe('/content?focus=p-1');
    expect(linkFor(item({ link: { page: '/commerce#fixes', focus: 'abcdef123456' } }))).toBe('/commerce?focus=abcdef123456#fixes');
    expect(linkFor(item({ link: { page: '/commerce', focus: 'r 9' } }))).toBe('/commerce?focus=r%209');
    expect(linkFor(item({ link: { page: '/bizdev', focus: 42 } }))).toBe('/bizdev?focus=42');
    expect(linkFor(item({ link: { page: '/trading', focus: null } }))).toBe('/trading');
    expect(linkFor(item({ link: null }))).toBeNull();
  });

  it('groups by kind in order, keeping the uncapped count', () => {
    const w = waiting({ counts: { ...waiting().counts, rec: 250, total: 255 } });
    const groups = groupItems(w);
    expect(groups.map((g) => g.kind)).toEqual(['x402', 'decision', 'proposal', 'follow_up', 'patch', 'rec']);
    expect(groups.find((g) => g.kind === 'rec')!.count).toBe(250);
    expect(groups.find((g) => g.kind === 'rec')!.items).toHaveLength(1);
    expect(groupItems(null)).toEqual([]);
  });

  it('warns on failed and missing sources and an old index, not on a daily feed', () => {
    const w = waiting({
      sources: {
        approvals: { generated_at: iso(2), age_seconds: 120, feeds: { content_proposals: iso(3), catalog_fixes: null, ecom_recommendations: iso(600) } },
        trading_status: { generated_at: null, age_seconds: null, error: 'No data yet' },
        studio: { generated_at: iso(45), age_seconds: 2700 },
      },
    });
    expect(staleSources(w).map((n) => n.name).sort()).toEqual(['catalog_fixes', 'studio', 'trading_status']);
    const ages = sourceAges(w, NOW);
    expect(ages.find((a) => a.name === 'ecom_recommendations')!.age).toBe(36000);
    expect(ages.find((a) => a.name === 'catalog_fixes')!.age).toBeNull();
  });

  it('labels due dates', () => {
    const now = new Date(2026, 9, 23, 12).getTime();
    expect(dueLabel('2026-10-23', now)).toBe('due today');
    expect(dueLabel('2026-10-21', now)).toBe('2d overdue');
    expect(dueLabel('2026-10-25', now)).toBe('due in 2d');
    expect(dueLabel(null, now)).toBeNull();
  });
});

describe('WaitingListView', () => {
  const html = renderToStaticMarkup(<WaitingListView groups={groupItems(waiting())} now={NOW} onOpen={noop} />);

  it('deep-links every row to its page and focus', () => {
    expect(html).toContain('data-href="/content?focus=p-1"');
    expect(html).toContain('data-href="/commerce?focus=abcdef123456#fixes"');
    expect(html).toContain('data-href="/commerce?focus=r-9"');
    expect(html).toContain('data-href="/bizdev?focus=42"');
    expect(html).toContain('data-href="/trading"');
  });

  it('opens the Decisions drawer for a decision row, and a row without a page is inert', () => {
    expect(isOpenable(item({ kind: 'decision', link: null, opens: 'decisions' }))).toBe(true);
    expect(isOpenable(item({ kind: 'workorder', link: null }))).toBe(false);
    const inert = renderToStaticMarkup(
      <WaitingListView groups={groupItems({ items: [item({ kind: 'workorder', link: null })], counts: { total: 1, workorder: 1 } })} now={NOW} onOpen={noop} />,
    );
    expect(inert).toContain('disabled=""');
  });

  it('shows ages, due dates and group counts', () => {
    expect(html).toContain('1h ago');
    expect(html).toContain('1d overdue');
    expect(html).toMatch(/data-group="rec".*?data-count="true">1</s);
  });

  it('caps rows per group but not the count', () => {
    const many = Array.from({ length: 12 }, (_, i) => item({ kind: 'rec', id: `r-${i}` }));
    const out = renderToStaticMarkup(
      <WaitingListView groups={groupItems({ items: many, counts: { total: 40, rec: 40 } })} now={NOW} perGroup={5} onOpen={noop} />,
    );
    expect(out).toContain('+ 35 more on the page');
  });

  it('reads "Nothing waiting on you" when empty', () => {
    expect(renderToStaticMarkup(<WaitingListView groups={[]} now={NOW} onOpen={noop} />)).toContain(EMPTY);
  });
});

describe('WaitingPanelView', () => {
  it('shows the For you count (an older feed: every row is act), and a stale source', () => {
    const w = waiting({
      sources: { approvals: { generated_at: iso(45), age_seconds: 2700, stale: false } },
    });
    const html = renderToStaticMarkup(
      <WaitingPanelView waiting={w} loading={false} error={null} now={NOW} onOpen={noop} onDecisions={noop} />,
    );
    expect(html).toContain('Waiting on you');
    expect(html).toContain('6 for you');
    expect(html).toContain('Hermes index: 45m old');
    expect(html).toContain('Hermes index 45m old');
  });

  it('is empty without errors when nothing waits', () => {
    const w = waiting({ items: [], counts: { total: 0 } });
    const html = renderToStaticMarkup(
      <WaitingPanelView waiting={w} loading={false} error={null} now={NOW} onOpen={noop} onDecisions={noop} />,
    );
    expect(html).toContain(EMPTY);
  });
});

describe('DecisionsView', () => {
  const box: DecisionBox = {
    file: 'sample/brief.md',
    folder: 'sample',
    title: 'Sample brief',
    modified_at: iso(30),
    number: 1,
    ticked: false,
    decision: 'Sample topic',
    default: 'do the usual thing',
    alternative: 'do less',
    text: '**D1. Sample topic.** ...',
    decided_note: null,
    line: 4,
    hash: 'h',
    paragraph: 'Some context.\n- [ ] **D1. Sample topic.** ...',
  };
  const decisions: Decisions = {
    open: [box],
    waiting_briefs: [{ file: 'sample/brief.md', folder: 'sample', title: 'Sample brief', modified_at: iso(30) }],
    recently_decided: [{ ...box, number: 2, ticked: true, decision: 'An old call', archived: true, decided_note: '**DECIDED 2026-10-01 (app)** ok' }],
  };
  const render = (states = {}) =>
    renderToStaticMarkup(
      <DecisionsView decisions={decisions} loading={false} error={null} states={states} notes={{}} message={null} now={NOW} onNote={noop} onArm={noop} onTick={noop} />,
    );

  it('lists each box with its default, alternative and the unticked-means-default hint', () => {
    const html = render();
    expect(html).toContain('D1. Sample topic');
    expect(html).toContain('do the usual thing');
    expect(html).toContain('do less');
    expect(html).toContain(DEFAULT_HINT.replace(/'/g, '&#x27;'));
    expect(html).toContain('Tick D1');
    expect(html).not.toContain('Confirm tick');
  });

  it('asks for a confirm before writing', () => {
    expect(render({ 'sample/brief.md:4': 'armed' })).toContain('Confirm tick');
    expect(render({ 'sample/brief.md:4': 'done' })).toContain('Ticked');
  });

  it('shows briefs waiting on a session and the recently decided', () => {
    const html = render();
    expect(html).toContain('Briefs waiting on a session (1)');
    expect(html).toContain('An old call');
    expect(html).toContain('archived');
  });
});
