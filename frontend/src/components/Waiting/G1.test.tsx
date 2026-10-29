import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ALREADY, G1View, expiresLabel } from './G1Drawer';
import { isOpenable } from './WaitingListView';
import { decideG1, type G1Item, type G1Outcome } from '../../lib/g1-api';
import { KIND_LABEL, groupItems, type WaitingItem } from '../../lib/waiting-api';

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
const NOW = Date.parse('2026-10-24T08:00:00Z');

function item(over: Partial<G1Item> = {}): G1Item {
  return {
    approvalId: 'ap-1',
    gate: 'G1',
    propertyId: 'alpha',
    contentType: 'short',
    executionName: 'alpha-run-1',
    createdAt: '2026-10-24T06:00:00Z',
    expiresAt: '2026-10-25T06:00:00Z',
    headline: 'A sample headline',
    caption: 'A sample caption',
    disclosures: ['A sample disclosure'],
    escalation: null,
    targets: ['instagram'],
    motion: { release: 'instagram', beat: 'A sample beat' },
    decidable: true,
    hasStill: true,
    hasClip: false,
    ...over,
  };
}

const view = (i: G1Item, outcome: G1Outcome | null = null) =>
  renderToStaticMarkup(<G1View item={i} now={NOW} outcome={outcome} busy={false} onDecide={() => undefined} load={async () => 'blob:x'} />);

describe('the G1 drawer', () => {
  it('shows the card as Telegram does, with Approve and Reject', () => {
    const html = view(item());
    for (const text of ['A sample headline', 'A sample caption', 'A sample disclosure', 'instagram', 'A sample beat', 'Motion (instagram)', 'expires in 22 h']) {
      expect(html).toContain(text);
    }
    expect(html).toContain('Approve');
    expect(html).toContain('Reject');
    expect(html).toContain('aria-label="G1 note"');
    expect(html).not.toContain('Decide in Telegram');
  });

  it('a G2 row shows everything and no buttons', () => {
    const html = view(item({ gate: 'G2', decidable: false, escalation: 'A sample compliance reason' }));
    expect(html).toContain('Decide in Telegram');
    expect(html).toContain('A sample compliance reason');
    expect(html).toContain('A sample headline');
    expect(html).not.toMatch(/<\/svg>\s*(Approve|Reject)/);
    expect(html).not.toContain('aria-label="G1 note"');
  });

  it('shows an episode as an episode, with its tags and what approving does', () => {
    const html = view(item({ contentType: 'episode', targets: ['sample-tag'], motion: null, hasClip: true }));
    expect(html).toContain('>episode<');
    expect(html).toContain('Title');
    expect(html).toContain('Description');
    expect(html).toContain('Tags');
    expect(html).toContain('sample-tag');
    expect(html).toContain('Approving publishes the full cut to YouTube');
    expect(html).toContain('Loading the 60 s cut');
  });

  it('a row from before the card was stored reads by its label with no media', () => {
    const html = view(item({ hasStill: false, hasClip: false, caption: '', disclosures: [], targets: null, motion: null }));
    expect(html).toContain('No still or clip on this row');
  });

  it('a 409 says already decided and drops the buttons', () => {
    const html = view(item(), { kind: 'already', status: 'APPROVED' });
    expect(html).toContain(`${ALREADY}: approved.`);
    expect(html).not.toMatch(/<\/svg>\s*Approve/);
  });

  it('a decision says what happens next', () => {
    expect(view(item(), { kind: 'decided', status: 'APPROVED' })).toContain('Approved: Foundry posts it now.');
    expect(view(item(), { kind: 'decided', status: 'REJECTED' })).toContain('Rejected.');
  });

  it('counts the hours left in the 24 h window', () => {
    expect(expiresLabel('2026-10-24T08:30:00Z', NOW)).toBe('expires in 30 min');
    expect(expiresLabel('2026-10-24T07:00:00Z', NOW)).toBe('expired');
  });
});

describe('G1 rows in "Waiting on you"', () => {
  const row: WaitingItem = {
    kind: 'g1',
    id: 'ap-1',
    source_feed: 'g1_mirror',
    scope: 'alpha',
    title: 'A sample headline',
    detail: 'short',
    created_at: '2026-10-24T06:00:00Z',
    due: '2026-10-25T06:00:00Z',
    priority: 1,
    link: null,
    opens: 'g1',
  };

  it('open the drawer and sit right after trading', () => {
    expect(isOpenable(row)).toBe(true);
    const x402: WaitingItem = { ...row, kind: 'x402', id: 'kill', opens: undefined, link: { page: '/trading', focus: null } };
    const groups = groupItems({ items: [row, x402], counts: { total: 2, g1: 1, x402: 1 } });
    expect(groups.map((g) => g.kind)).toEqual(['x402', 'g1']);
    expect(KIND_LABEL.g1).toBe('Posts to approve (G1)');
  });
});

describe('decideG1', () => {
  afterEach(() => vi.unstubAllGlobals());

  const answer = (status: number, body: unknown) =>
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })));

  it('maps the mirror answers', async () => {
    answer(200, { status: 'APPROVED' });
    expect(await decideG1('ap-1', 'approve', '')).toEqual({ kind: 'decided', status: 'APPROVED' });
    answer(409, { status: 'REJECTED' });
    expect(await decideG1('ap-1', 'approve', '')).toEqual({ kind: 'already', status: 'REJECTED' });
    answer(403, { error: 'g2-decide-in-telegram' });
    expect((await decideG1('ap-1', 'approve', '')).kind).toBe('error');
  });

  it('sends the note only when there is one', async () => {
    answer(200, { status: 'REJECTED' });
    await decideG1('ap-1', 'reject', '  ');
    const init = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ decision: 'reject' });
  });
});
