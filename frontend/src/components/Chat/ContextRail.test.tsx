import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import type { Waiting, WaitingItem } from '../../lib/waiting-api';
import type { Conversation } from '../../types';
import { DeskRail, WaitingRail, latestCards, threadContext } from './ContextRail';

// The card buttons read the Decisions drawer setter from the Waiting context.
vi.mock('../../lib/WaitingContext', async (orig) => ({
  ...(await orig<typeof import('../../lib/WaitingContext')>()),
  useWaiting: () => ({ setDecisionsOpen: () => {} }),
}));

vi.hoisted(() => {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> }).localStorage ??= {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  };
});

// Invented fixtures only: this repo is public.
const NOW = Date.parse('2026-01-10T12:00:00Z');
const CARD = ['```card', JSON.stringify({ kind: 'ruling', label: 'Record it', body: { text: 'Prefer short hooks.' } }), '```'].join('\n');

const conv = (over: Partial<Conversation> = {}): Conversation => ({
  id: 't1',
  title: 'A desk thread',
  createdAt: NOW - 600_000,
  updatedAt: NOW,
  model: 'hermes-agent',
  desk: 'content',
  messages: [
    { id: 'u1', role: 'user', content: 'What about this?', timestamp: NOW - 120_000, context: { block: '```context\n{"page":"/content","id":"p-1"}\n```', label: 'proposal p-1' } },
    { id: 'a1', role: 'assistant', content: `Here is a ruling.\n${CARD}`, timestamp: NOW - 60_000 },
  ],
  ...over,
});

const item = (over: Partial<WaitingItem> = {}): WaitingItem => ({
  kind: 'rec',
  id: 'r-1',
  source_feed: 'ecom_recommendations',
  scope: 'store-a',
  title: 'A sample rec',
  detail: 'Why it matters',
  created_at: new Date(NOW - 3_600_000).toISOString(),
  due: null,
  priority: 1,
  link: { page: '/commerce', focus: 'r-1' },
  lane: 'act',
  delegate: null,
  times_seen: 1,
  last_seen: null,
  ...over,
});

const WAITING: Waiting = {
  generated_at: new Date(NOW).toISOString(),
  counts: { total: 1, rec: 1, act: 1, delegate: 0, fyi: 0 },
  items: [item()],
  sources: {},
  local: true,
} as Waiting;

const inRouter = (node: React.ReactNode) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);

describe('the Chat context rail (plan 4.8)', () => {
  it('reads the thread’s context and its newest reply’s cards', () => {
    expect(threadContext(conv())?.label).toBe('proposal p-1');
    expect(threadContext(conv({ messages: [] }))).toBeNull();
    expect(threadContext(conv({ messages: [], pendingContext: { block: 'b', label: 'pending item' } }))?.label).toBe('pending item');
    const cards = latestCards(conv(), 'content')!;
    expect(cards.messageId).toBe('a1');
    expect(cards.cards.map((c) => c.kind)).toEqual(['ruling']);
    expect(latestCards(conv({ messages: [] }), 'content')).toBeNull();
  });

  it('a desk thread shows its context block, its cards and the live trace', () => {
    const trace = [{ key: 'live:0', thread: 't1', at: NOW, call: { id: 'x', tool: 'episode', arguments: '{}', status: 'running' as const } }];
    const html = inRouter(<DeskRail conv={conv()} desk="content" trace={trace} live now={NOW} isLive={false} />);
    expect(html).toContain('data-rail="desk"');
    expect(html).toContain('proposal p-1');
    expect(html).toContain('data-context-block');
    expect(html).toContain('Record it');
    expect(html).toContain('data-rail-trace');
    expect(html).toContain('this thread');
    expect(html).toContain('>live<');
  });

  it('a desk thread with no context or calls says so', () => {
    const html = inRouter(<DeskRail conv={conv({ messages: [] })} desk="content" trace={[]} live={false} now={NOW} isLive={false} />);
    expect(html).toContain('No page context');
    expect(html).toContain('No cards yet');
    expect(html).toContain('No tool calls yet');
  });

  it('a plain chat shows the Waiting “For you” lane', () => {
    const html = inRouter(<WaitingRail waiting={WAITING} loading={false} error={null} now={NOW} onOpen={() => {}} onInbox={() => {}} />);
    expect(html).toContain('data-rail="waiting"');
    expect(html).toContain('A sample rec');
    expect(html).toContain('Open the Inbox');
    expect(inRouter(<WaitingRail waiting={null} loading error={null} now={NOW} onOpen={() => {}} onInbox={() => {}} />)).toContain('Loading…');
  });
});
