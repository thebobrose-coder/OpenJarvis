import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CompanySitesCard } from './CompanySitesCard';
import { StackHealthDrawer } from './StackHealthDrawer';
import { WaitingListView, isOpenable, type RowActions } from '../Waiting/WaitingListView';
import { checkedStale, ga4Text, gscText, noticeLine, PRIVACY_NOTE, type EntityWatch, type SiteRow } from '../../lib/sites-api';
import { KIND_ORDER, KIND_LABEL, groupItems, type Waiting, type WaitingItem } from '../../lib/waiting-api';

// The app store reads localStorage when it loads; node has none.
vi.hoisted(() => {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> }).localStorage ??= {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  };
});

// Invented fixtures only: this repo is public.
const NOW = Date.parse('2026-11-04T18:00:00Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3600000).toISOString();
const noop = () => {};
const actions: RowActions = { status: {}, onDispatch: noop, onSnooze: noop, onFix: noop, onDismiss: noop };

const notice = (over: Partial<WaitingItem>): WaitingItem => ({
  kind: 'notice',
  id: 'aaaaaaaaaaaa',
  source_feed: 'entity_watch',
  scope: 'site-a',
  title: 'Company site not serving',
  detail: 'https://alpha.example.test/app/privacy.html: status 503',
  created_at: hoursAgo(1),
  due: null,
  priority: null,
  link: { page: '/ops', focus: 'aaaaaaaaaaaa' },
  lane: 'act',
  delegate: null,
  opens: 'sites',
  notice_kind: 'serve_failed',
  ...over,
});

const SERVE = notice({});
const PRIVACY = notice({
  id: 'bbbbbbbbbbbb',
  title: 'Company privacy page changed',
  detail: "https://alpha.example.test/app/privacy.html: the page's text changed since the last run",
  notice_kind: 'privacy_changed',
});
const LASTMOD = notice({
  id: 'cccccccccccc',
  scope: 'site-b',
  title: 'Company site page updated',
  detail: 'https://beta.example.test/: Last-Modified a -> b (no deploy ledger to compare)',
  notice_kind: 'last_modified_changed',
});

const site = (over: Partial<SiteRow>): SiteRow => ({
  id: 'site-a',
  apex: 'https://alpha.example.test',
  checked_at: hoursAgo(2),
  serve: [
    { path: '/', status: 200, content_type: 'text/html', last_modified: 'Mon, 02 Nov 2026 10:00:00 GMT', ok: true },
    { path: '/app/privacy.html', status: 503, content_type: null, last_modified: null, ok: false, error: 'status 503' },
  ],
  privacy_sha256: '0123456789abcdef0123456789abcdef',
  gsc: { clicks: 4, impressions: 120, position: 7.25, inspection: { verdict: 'PASS' } },
  ga4: { days: 28, sessions: 31 },
  ...over,
});

const watch = (entities: SiteRow[]): EntityWatch => ({
  run_at: hoursAgo(2),
  notices: [],
  briefing_line: null,
  baseline: false,
  entities,
  generated_at: hoursAgo(2),
  age_seconds: 7200,
  stale: false,
});

describe('company-site notices on Waiting on you', () => {
  it('groups notices under "Company sites", just before work orders', () => {
    expect(KIND_LABEL.notice).toBe('Company sites');
    expect(KIND_ORDER.indexOf('notice')).toBe(KIND_ORDER.indexOf('workorder') - 1);
    const w: Pick<Waiting, 'items' | 'counts'> = { items: [SERVE, PRIVACY], counts: { total: 2, notice: 2 } };
    const groups = groupItems(w, 'act');
    expect(groups.map((g) => [g.kind, g.label, g.count])).toEqual([['notice', 'Company sites', 2]]);
  });

  it('reads each notice kind in words, with the site and the path', () => {
    expect(noticeLine(SERVE)).toBe('alpha.example.test is not serving /app/privacy.html (503)');
    expect(noticeLine(PRIVACY)).toBe('alpha.example.test: privacy page changed');
    expect(noticeLine(LASTMOD)).toBe('beta.example.test: / Last-Modified changed');
    expect(noticeLine(notice({ notice_kind: null, detail: null, title: 'Company site notice' }))).toBe('site-a: Company site notice');
  });

  it('renders the rows with no action button, opening the card, and the privacy line', () => {
    const groups = groupItems({ items: [SERVE, PRIVACY], counts: { total: 2, notice: 2 } }, 'act');
    const html = renderToStaticMarkup(<WaitingListView groups={groups} now={NOW} onOpen={noop} actions={actions} />);
    expect(html).toContain('data-group="notice"');
    expect(html).toContain('alpha.example.test is not serving /app/privacy.html (503)');
    expect(html).toContain('data-notice="privacy_changed"');
    expect(html).toContain(PRIVACY_NOTE.replace("'", '&#x27;'));
    expect(html).toContain('Open the Company sites card');
    expect(html).not.toContain('/ops');
    for (const attr of ['data-dispatch', 'data-fix', 'data-snooze', 'data-dismiss', 'data-patch-ready']) expect(html).not.toContain(attr);
    expect(html.match(/<button/g)).toHaveLength(2); // the two rows themselves
    expect(isOpenable(SERVE)).toBe(true);
    expect(isOpenable({ ...SERVE, opens: undefined })).toBe(false);
  });

  it('never shows Dispatch on a notice, even with a delegate', () => {
    const odd = notice({ lane: 'delegate', delegate: { target: 'desk', desk: 'commerce' } });
    const html = renderToStaticMarkup(
      <WaitingListView groups={groupItems({ items: [odd], counts: { total: 1 } }, 'delegate')} now={NOW} onOpen={noop} actions={actions} />,
    );
    expect(html).not.toContain('data-dispatch');
  });
});

describe('Company sites card', () => {
  it('renders each entity: serve chips with Last-Modified, the hash, GSC, GA4 and checked_at', () => {
    const html = renderToStaticMarkup(
      <CompanySitesCard
        sites={watch([site({}), site({ id: 'site-b', apex: 'https://beta.example.test', gsc: 'not configured', ga4: 'no property id' })])}
        now={NOW}
      />,
    );
    expect(html.match(/data-site=/g)).toHaveLength(2);
    expect(html).toContain('alpha.example.test');
    expect(html).toContain('beta.example.test');
    expect(html).toContain('data-serve="ok"');
    expect(html).toContain('data-serve="fail"');
    expect(html).toContain('Mon, 02 Nov 2026 10:00:00 GMT');
    expect(html).toContain('0123456789ab<');
    expect(html).not.toContain('0123456789abc');
    expect(html).toContain('4 clicks · 120 impressions · position 7.3 · PASS');
    expect(html).toContain('31 sessions / 28 d');
    expect(html).toContain('not configured');
    expect(html).toContain('no property id');
    expect(html).toContain('checked 2 h ago');
    expect(html).not.toContain('<button');
  });

  it('reads a checked_at older than 36 h as stale, in amber', () => {
    const html = renderToStaticMarkup(<CompanySitesCard sites={watch([site({ checked_at: hoursAgo(40) })])} now={NOW} />);
    expect(html).toContain('data-checked="stale"');
    expect(html).toContain('var(--color-warning)');
    expect(checkedStale(hoursAgo(35), NOW)).toBe(false);
    expect(checkedStale(hoursAgo(37), NOW)).toBe(true);
    expect(checkedStale(null, NOW)).toBe(true);
  });

  it('shows a string or error GSC and GA4 as given', () => {
    expect(gscText('not verified')).toBe('not verified');
    expect(gscText({ error: 'Search Console not connected' })).toBe('Search Console not connected');
    expect(ga4Text('no property id')).toBe('no property id');
    expect(ga4Text({ error: 'GA4 not connected' })).toBe('GA4 not connected');
    expect(gscText({ clicks: 0, impressions: 0, position: null, inspection: { error: 403 } })).toBe(
      '0 clicks · 0 impressions · position — · inspection error 403',
    );
  });

  it('sits in the Stack health drawer, which opens even with no stack-health file', () => {
    const html = renderToStaticMarkup(
      <StackHealthDrawer
        health={null}
        now={NOW}
        run={{ state: 'idle', detail: null }}
        onRun={noop}
        onClose={noop}
        onAskDesk={noop}
        sites={{ sites: watch([site({})]), error: null }}
      />,
    );
    expect(html).toContain('Stack health · unavailable');
    expect(html).toContain('Company sites');
    expect(html).toContain('data-company-sites');
    expect(html).not.toContain('Run now');
    expect(html).not.toContain('Ask the desk');
  });

  it('shows the error line when the feed is unavailable', () => {
    const html = renderToStaticMarkup(<CompanySitesCard sites={null} error="No company-site data yet" now={NOW} />);
    expect(html).toContain('No company-site data yet');
  });
});
