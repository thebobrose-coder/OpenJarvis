import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AddSummary, OutreachView, type AngleState, type OutreachViewProps } from './OutreachView';
import { accountEdits } from './AccountDrawer';
import { withUsed } from '../../hooks/useOutreachData';
import {
  engagedWords,
  figure,
  logWords,
  openCandidates,
  roundLine,
  sortAccounts,
  verdict,
  type Account,
  type BrandState,
  type IgCandidates,
  type IgReach,
  type OutreachState,
  type RoundRow,
} from '../../lib/outreach-api';
import { KIND_LABEL, groupItems, linkFor, type Waiting } from '../../lib/waiting-api';

// The app store (via the shared UI) reads localStorage when it loads; node has none.
vi.hoisted(() => {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> }).localStorage ??= {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  };
});

// Neutral fixtures only: this repo is public.
const NOW = Date.parse('2026-03-10T18:00:00Z');
const noop = () => {};

const account = (handle: string, over: Partial<Account> = {}): Account => ({
  handle,
  profile_url: `https://www.instagram.com/${handle}/`,
  niche: '',
  tier: 'peer',
  why: '',
  source: 'operator',
  status: 'active',
  last_engaged_at: null,
  collab_state: 'none',
  notes: '',
  added_at: '2026-02-01T12:00:00Z',
  updated_at: '2026-02-01T12:00:00Z',
  ...over,
});

const row = (handle: string, over: Partial<RoundRow> = {}): RoundRow => ({ ...account(handle), state: 'open', at: null, angle: null, ...over });

const alpha: BrandState = {
  id: 'alpha',
  accounts: [
    account('one.maker', { niche: 'field kits', why: 'posts weekly', tier: 'creator' }),
    account('two.maker', { last_engaged_at: '2026-03-09T15:00:00Z' }),
    account('old.maker', { status: 'paused' }),
  ],
  dismissed: ['noisy.maker'],
  round: {
    day: '2026-03-10',
    size: 5,
    rows: [
      row('one.maker', { niche: 'field kits', why: 'posts weekly', tier: 'creator' }),
      row('two.maker', { state: 'done', at: '2026-03-10T17:00:00Z', angle: 'Clean build on that rack.', last_engaged_at: '2026-03-10T17:00:00Z' }),
    ],
    open: 1,
    done: 1,
    skipped: 0,
    complete: false,
  },
  checklist: { day: '2026-03-10', comments_answered: true, reel_to_stories: false, round_done: false, days_kept: 4, streak: 2 },
  log: [{ at: '2026-03-10T17:00:00Z', day: '2026-03-10', brand: 'alpha', kind: 'done', handle: 'two.maker', angle: 'Clean build on that rack.' }],
};

const beta: BrandState = {
  id: 'beta',
  accounts: [],
  dismissed: [],
  round: { day: '2026-03-10', size: 5, rows: [], open: 0, done: 0, skipped: 0, complete: false },
  checklist: { day: '2026-03-10', comments_answered: false, reel_to_stories: false, round_done: false, days_kept: 0, streak: 0 },
  log: [],
};

const STATE: OutreachState = { configured: true, day: '2026-03-10', round_size: 5, brands: [alpha, beta] };

const REACH: IgReach = {
  week: '2026-W11',
  age_seconds: 3600,
  properties: [
    {
      id: 'alpha',
      week: { from: '2026-03-02', to: '2026-03-08', reels: 6, median_reach: 80, shares_per_reel: 0.5, saves: 3, comments: 2, followers: null, followers_change: null, bio_sessions: null },
      baseline: { as_of: '2026-02-01', median_reach: 30, shares_per_reel: 0 },
      test: { started: '2026-03-01', day: 9, read_on: '2026-03-16', reels_at_day7: 2, median_reach_day7: 95 },
      pass_line: { median_reach_min: 60, shares_per_reel_min: 1, followers_up: true },
      meets: { median_reach: true, shares_per_reel: false, followers: null, all: false },
    },
  ],
};

const CANDIDATES: IgCandidates = {
  week: '2026-W11',
  age_seconds: 3600,
  properties: [
    {
      id: 'alpha',
      candidates: [
        { handle: 'found.maker', why: 'Builds the same kind of kit', found_on: 'https://example.org/list' },
        { handle: 'one.maker', why: 'already on the list' },
        { handle: 'noisy.maker', why: 'dismissed before' },
      ],
    },
  ],
};

const none = { data: null, loading: false, error: null };

const props = (over: Partial<OutreachViewProps> = {}): OutreachViewProps => ({
  state: STATE,
  reach: none,
  candidates: none,
  selectedBrand: 'alpha',
  onSelectBrand: noop,
  now: NOW,
  onOpenProfile: noop,
  onAngles: noop,
  onCopyAngle: noop,
  onMark: noop,
  onCheck: noop,
  onAdd: async () => ({ added: [], duplicates: [], invalid: [] }),
  onEdit: async () => {},
  onCandidate: noop,
  ...over,
});

const render = (over: Partial<OutreachViewProps> = {}) => renderToStaticMarkup(<OutreachView {...props(over)} />);

describe('OutreachView', () => {
  it('shows the round with Open, Angles, Done and Skip on an open row, and Undo on a marked one', () => {
    const html = render();
    expect(html).toContain('Today’s round');
    expect(html).toContain('1 of 2 left');
    expect(html).toContain('data-round-row="one.maker" data-state="open"');
    expect(html).toContain('data-done="one.maker"');
    expect(html).toContain('data-skip="one.maker"');
    expect(html).not.toContain('data-undo="one.maker"');
    expect(html).toContain('title="Open https://www.instagram.com/one.maker/ in your browser"');
    expect(html).toContain('field kits · posts weekly');
    expect(html).toContain('data-round-row="two.maker" data-state="done"');
    expect(html).toContain('data-undo="two.maker"');
    expect(html).not.toContain('data-done="two.maker"');
    expect(html).toContain('Angle used: “Clean build on that rack.”');
    expect(html).toContain('The app never posts, likes, follows or messages.');
  });

  it('never renders a profile as a link the webview could follow', () => {
    const html = render({ openHandle: 'one.maker' });
    expect(html).not.toMatch(/<a [^>]*instagram\.com/);
    expect(html).not.toMatch(/<form/);
  });

  it('shows three angles with copy buttons, the one copied, and how many the screen refused', () => {
    const ready: AngleState = { status: 'ready', angles: ['First angle.', 'Second angle.', 'Third angle.'], screenedOut: 2, used: 'Second angle.' };
    const html = render({ angles: { 'alpha:one.maker': ready } });
    expect(html.match(/<li class="flex items-start gap-2"/g)?.length).toBe(3);
    expect(html).toContain('First angle.');
    expect(html).toContain('data-used="yes"');
    expect(html).toContain('Copied');
    expect(html).toContain('2 drafted angles were not shown');
    expect(html).toContain('New angles');
    expect(render({ angles: { 'alpha:one.maker': { status: 'loading' } } })).toContain('Drafting on this machine');
    const refused = render({ angles: { 'alpha:one.maker': { status: 'error', error: 'No drafted angle passed the screen; ask again' } } });
    expect(refused).toContain('data-angle-error');
    expect(refused).toContain('No drafted angle passed the screen');
  });

  it('shows the checklist, the days kept and the log', () => {
    const html = render();
    expect(html).toContain('4 days kept');
    expect(html).toMatch(/<input[^>]*data-check="comments_answered"[^>]*checked=""/);
    expect(html).not.toMatch(/<input[^>]*data-check="reel_to_stories"[^>]*checked=""/);
    expect(html).toContain('data-check-round="open"');
    expect(html).toContain('2 days in a row.');
    expect(html).toContain('Done @two.maker: “Clean build on that rack.”');
  });

  it('lists the targets, active first, with tier, status and last engaged', () => {
    const html = render();
    expect(html).toContain('2 active of 3');
    const order = ['one.maker', 'two.maker', 'old.maker'].map((h) => html.indexOf(`data-account="${h}"`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('yesterday');
    expect(html).toContain('paused');
    expect(html).toContain('Paste handles or profile links');
  });

  it('reads "not yet" for the strip and the tab while Hermes has not built the feeds', () => {
    const html = render({ tab: 'candidates' });
    expect(html).toContain('data-reach="none"');
    expect(html).toContain('Results: not yet.');
    expect(html).toContain('data-candidates="none"');
    expect(html).toContain('Candidates: not yet.');
  });

  it('shows the weekly read against the baseline and the pass line, and "not read" for a null', () => {
    const html = render({ reach: { data: REACH, loading: false, error: null } });
    expect(html).toContain('data-reach="alpha"');
    expect(html).toContain('baseline 30, pass 60 · meets the pass line');
    expect(html).toContain('baseline 0, pass 1 · short of the pass line');
    expect(html).toContain('counted by hand in the app');
    expect(html).toContain('not read');
    expect(html).not.toMatch(/Followers<\/span><span[^>]*>0</);
    expect(html).toContain('Day 9 of 14');
    expect(html).toContain('read on 2026-03-16 · not passing');
    expect(html).toContain('median reach 95 over 2 Reels');
    // The other brand has no row in the feed.
    const other = render({ reach: { data: REACH, loading: false, error: null }, selectedBrand: 'beta' });
    expect(other).toContain('no row for this brand yet');
  });

  it('offers only the candidates that are new, with Accept and Dismiss', () => {
    const html = render({ tab: 'candidates', candidates: { data: CANDIDATES, loading: false, error: null } });
    expect(html).toContain('data-candidate="found.maker"');
    expect(html).not.toContain('data-candidate="one.maker"');
    expect(html).not.toContain('data-candidate="noisy.maker"');
    expect(html).toContain('Accept');
    expect(html).toContain('Dismiss');
    expect(html).toContain('Candidates (1)');
    expect(html).toContain('https://example.org/list');
  });

  it('says so when a brand has no account, and when the page is not set up', () => {
    const empty = render({ selectedBrand: 'beta' });
    expect(empty).toContain('No active account yet: add some below');
    expect(empty).toContain('No accounts yet.');
    const off = render({ state: { configured: false, day: '2026-03-10', round_size: 5, brands: [] } });
    expect(off).toContain('data-unconfigured');
    expect(off).toContain('OUTREACH_BRANDS');
    expect(render({ state: null, error: 'The outreach store is unreadable' })).toContain('The outreach store is unreadable');
  });

  it('marks each brand tab with what is left', () => {
    const html = render();
    expect(html).toContain('<span data-brand-tab="alpha">alpha · 1 left</span>');
    expect(html).toContain('<span data-brand-tab="beta">beta</span>');
  });

  it('opens the account drawer with its fields', () => {
    const html = render({ openHandle: 'one.maker' });
    expect(html).toContain('aria-label="@one.maker"');
    expect(html).toContain('Open the profile');
    expect(html).toContain('Why it is on the list');
    expect(html).toContain('value="field kits"');
  });
});

describe('outreach helpers', () => {
  it('drops known and dismissed candidates', () => {
    expect(openCandidates(CANDIDATES, alpha).map((c) => c.handle)).toEqual(['found.maker']);
    expect(openCandidates(null, alpha)).toEqual([]);
    expect(openCandidates(CANDIDATES, beta)).toEqual([]);
  });

  it('sorts active first, then the longest waiting', () => {
    expect(sortAccounts(alpha.accounts).map((a) => a.handle)).toEqual(['one.maker', 'two.maker', 'old.maker']);
  });

  it('words the engagement age, the round and a figure', () => {
    expect(engagedWords(null, NOW)).toBe('never');
    expect(engagedWords('2026-03-10T15:00:00Z', NOW)).toBe('today');
    expect(engagedWords('2026-03-05T15:00:00Z', NOW)).toBe('5 d ago');
    expect(roundLine(alpha.round, 2)).toBe('1 of 2 left');
    expect(roundLine({ ...alpha.round, open: 0, done: 4, skipped: 1, complete: true }, 5)).toBe('Round done: 4 done, 1 skipped');
    expect(roundLine(beta.round, 3)).toBe('Every active account was engaged today');
    expect(figure(null)).toBe('not read');
    expect(figure(0)).toBe('0');
    expect(figure(1432)).toBe('1,432');
    expect(verdict(null)).toBe('unread');
    expect(verdict(false)).toBe('short');
  });

  it('words every log line', () => {
    expect(logWords({ at: '', day: '', brand: 'alpha', kind: 'skip', handle: 'one.maker' })).toBe('Skipped @one.maker');
    expect(logWords({ at: '', day: '', brand: 'alpha', kind: 'undo', handle: 'one.maker' })).toBe('Undid @one.maker');
    expect(logWords({ at: '', day: '', brand: 'alpha', kind: 'check', item: 'reel_to_stories', checked: false })).toContain('Unticked');
    expect(logWords({ at: '', day: '', brand: 'alpha', kind: 'round', complete: true, done: 4, skipped: 1 })).toBe('Round done (4 done, 1 skipped)');
  });

  it('sends only what changed from the drawer', () => {
    const a = alpha.accounts[0];
    const same = { niche: a.niche, tier: a.tier, why: a.why, status: a.status, collab_state: a.collab_state, notes: a.notes };
    expect(accountEdits(a, same)).toEqual({});
    expect(accountEdits(a, { ...same, niche: ' field kits ', status: 'paused', notes: 'met at a show' })).toEqual({ status: 'paused', notes: 'met at a show' });
  });

  it('keeps the copied angle for Done', () => {
    const ready: AngleState = { status: 'ready', angles: ['A', 'B'], screenedOut: 0, used: null };
    expect(withUsed({ k: ready }, 'k', 'B').k).toEqual({ ...ready, used: 'B' });
    expect(withUsed({ k: { status: 'loading' } }, 'k', 'B').k).toEqual({ status: 'loading' });
  });

  it('summarises a paste', () => {
    const html = renderToStaticMarkup(<AddSummary result={{ added: ['a', 'b'], duplicates: ['c'], invalid: ['d!'] }} />);
    expect(html).toContain('2 added · already on the list: @c · not a handle: d!');
  });
});

describe('the outreach row on Waiting on you', () => {
  it('groups under its own label and links to the brand on the page', () => {
    const item = {
      kind: 'outreach',
      id: 'outreach:alpha:2026-03-10',
      source_feed: 'social',
      scope: 'alpha',
      title: 'Outreach round: alpha',
      detail: '5 of 5 accounts left today',
      created_at: '2026-03-10T06:00:00Z',
      due: null,
      priority: null,
      link: { page: '/outreach', focus: 'alpha' },
      lane: 'act' as const,
      delegate: null,
    };
    const w = { items: [item], counts: { total: 1, outreach: 1 } } as unknown as Waiting;
    const groups = groupItems(w, 'act');
    expect(groups.map((g) => g.label)).toEqual(['Outreach rounds']);
    expect(KIND_LABEL.outreach).toBe('Outreach rounds');
    expect(linkFor(item)).toBe('/outreach?focus=alpha');
  });
});
