import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router';
import { FeedAge } from './FeedAge';
import { StackHealthPanelView } from './StackHealthPanelView';
import { InboxView } from '../Waiting/InboxView';
import { FreshnessProvider } from '../../lib/freshness';
import type { StackHealth } from '../../lib/stack-api';
import type { Waiting } from '../../lib/waiting-api';

const NOW = Date.parse('2026-11-09T12:00:00Z');
const noop = () => undefined;

// Neutral fixtures only.
const HEALTH: StackHealth = {
  ran_at: '2026-11-09T11:00:00Z',
  age_seconds: 3600,
  stale: false,
  counts: { OK: 30, WARN: 2, FAIL: 1, SKIP: 3 },
  failing: [{ area: 'windows', check: 'task', status: 'FAIL', evidence: 'result 1' } as StackHealth['failing'][number]],
  warning: [],
  skipped: 3,
  cloud_events: [],
};

const WAITING: Waiting = {
  generated_at: '2026-11-09T11:59:00Z',
  age_seconds: 60,
  stale: false,
  counts: { total: 3, act: 2, delegate: 1, fyi: 0 },
  sources: {},
  items: [
    { kind: 'rec', id: 'r1', title: 'Sample rec', created_at: '2026-11-09T10:00:00Z', lane: 'act', link: { page: '/commerce', focus: 'r1' } },
    { kind: 'rec', id: 'r2', title: 'Another rec', created_at: '2026-11-09T10:00:00Z', lane: 'act', link: { page: '/commerce', focus: 'r2' } },
    { kind: 'rec', id: 'r3', title: 'A desk rec', created_at: '2026-11-09T10:00:00Z', lane: 'delegate', delegate: { target: 'desk' } },
  ] as Waiting['items'],
} as unknown as Waiting;

describe('Phase 1: Inbox page', () => {
  it('shows the three lanes with their counts and the Decisions button', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <InboxView waiting={WAITING} loading={false} error={null} now={NOW} tab="act" onTab={noop} onDecisions={noop} onOpen={noop} onFiled={noop} />
      </MemoryRouter>,
    );
    expect(html).toContain('>Inbox<');
    expect(html).toContain('2 for you · 1 to dispatch · 0 filed');
    expect(html).toContain('data-tab="act"');
    expect(html).toContain('data-tab="delegate"');
    expect(html).toContain('data-tab="fyi"');
    expect(html).toContain('Decisions');
    expect(html).toContain('Sample rec');
    expect(html).not.toContain('A desk rec');
  });
});

describe('Phase 1: Stack health panel', () => {
  it('shows the counts, the headline and a Details button', () => {
    const html = renderToStaticMarkup(
      <StackHealthPanelView health={HEALTH} level="fail" age={3600} noticeOnly={false} missing={false} error={null} onOpen={noop} />,
    );
    expect(html).toContain('1 FAIL');
    expect(html).toContain('2 WARN');
    expect(html).toContain('30 OK');
    expect(html).toContain('data-stack-level="fail"');
    expect(html).toContain('Details');
  });
  it('reads all clear when green', () => {
    const green = { ...HEALTH, counts: { OK: 33, WARN: 0, FAIL: 0, SKIP: 0 }, failing: [] };
    const html = renderToStaticMarkup(
      <StackHealthPanelView health={green} level="ok" age={600} noticeOnly={false} missing={false} error={null} onOpen={noop} />,
    );
    expect(html).toContain('All systems operating nominally.');
    expect(html).not.toContain('FAIL');
  });
  it('says so when no run exists', () => {
    const html = renderToStaticMarkup(
      <StackHealthPanelView health={null} level="unavailable" age={null} noticeOnly={false} missing error={null} onOpen={noop} />,
    );
    expect(html).toContain('No stack-health run yet');
  });
});

describe('Phase 1: FeedAge', () => {
  it('is the full line without a page registry', () => {
    expect(renderToStaticMarkup(<FeedAge label="A" ageSeconds={120} />)).toContain('Updated 2 min ago');
  });
  it('reports to the page and shows nothing while fresh', () => {
    const html = renderToStaticMarkup(
      <FreshnessProvider>
        <FeedAge label="A" ageSeconds={120} />
      </FreshnessProvider>,
    );
    expect(html).toBe('');
  });
  it('keeps the amber line when stale or late, even with a registry', () => {
    const stale = renderToStaticMarkup(
      <FreshnessProvider>
        <FeedAge label="A" ageSeconds={120} stale />
      </FreshnessProvider>,
    );
    expect(stale).toContain('stale');
    const late = renderToStaticMarkup(
      <FreshnessProvider>
        <FeedAge label="A" ageSeconds={5000} staleAfterSeconds={900} />
      </FreshnessProvider>,
    );
    expect(late).toContain('Updated');
  });
});
