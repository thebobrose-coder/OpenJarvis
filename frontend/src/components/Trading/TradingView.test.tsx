import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  curveRows,
  curveSleeves,
  fmtMoney,
  fmtUsdc,
  haltTone,
  killCause,
  killWhen,
  recentEvents,
  sleeveNames,
  staleness,
  type Sleeve,
  type TradingDay,
  type TradingStatus,
} from '../../lib/trading-api';
import type { FeedState } from '../../hooks/useTradingData';
import { EquityCurve } from './EquityCurve';
import { EventsPanel, eventTone } from './EventsPanel';
import { AWS_FLAG_RULE, KillCard, LOCAL_FILE_RULE, NO_URL_HINT } from './KillCard';
import { Meter } from './Meter';
import { SleeveCard, markAsOf } from './SleeveCard';
import { NightlyCard, SpendCard } from './SpendCard';
import { STALE_BANNER, TradingHeader } from './TradingHeader';
import { NO_SLEEVES, NO_STATUS_YET, TradingView } from './TradingView';

// Invented numbers only: this repo is public. No real product ids, no URLs
// that exist, no account material.
const NOW = Date.parse('2026-10-06T17:00:00Z');
const META = { generated_at: '2026-10-06T16:55:00Z', age_seconds: 300, stale: false };

function sleeve(over: Partial<Sleeve> = {}): Sleeve {
  return {
    halt_state: 'NORMAL',
    day: { date: '2026-10-06', start_equity: '10000.00', entries_halted: false, paused: [] },
    equity: '10240.50',
    cash: '6100.25',
    realized_equity: '10100.00',
    hwm: '10300.00',
    realized_hwm: '10100.00',
    drawdown_pct: '0.58',
    positions: [{ product: 'SAMPLE-A', side: 'long', size: '12', entry: '101.25', stop: '96.00', held_days: 3 }],
    open_orders: [{ id: 'o-1', product: 'SAMPLE-B', side: 'buy', type: 'limit', size: '5', limit: '42.10', status: 'open', submitted_at: '2026-10-06T14:00:00Z' }],
    ticks: {
      today: [
        { time: '09:45', kind: 'monitor', done: true, at: '2026-10-06T13:45:10Z' },
        { time: '15:45', kind: 'entry', done: false },
      ],
      next_due: '2026-10-06T19:45:00Z',
    },
    last_tick: { at: '2026-10-06T13:45:10Z', kind: 'monitor', submitted: 0, duration_s: 10.7 },
    recent_events: [{ ts: '2026-10-06T13:45:10Z', type: 'HITL', summary: 'proposal approved' }],
    ...over,
  };
}

function status(over: Partial<TradingStatus> = {}): TradingStatus {
  return {
    ...META,
    schema: 1,
    written_at: '2026-10-06T16:54:25Z',
    mode: 'paper',
    app: { installed_commit: 'abc1234', run_from: '/opt/trader/app' },
    kill: { local_file: false, aws_flag: false, aws_checked_at: '2026-10-06T16:50:00Z', last_cause: null, cleared_at: null },
    heartbeat: { last_sent_at: '2026-10-06T16:54:00Z', last_ok: true, alarm: 'OK' },
    x402: { day: '2026-10-06', payments: 3, total_usdc: '0.030000', daily_cap_usdc: '3.00', entry_pool_usdc: '2.00', exit_reserve_usdc: '1.00', under_cap: true },
    sleeves: {
      equities: sleeve(),
      crypto: sleeve({
        equity: '5000.00',
        cash: '5000.00',
        realized_equity: '5000.00',
        hwm: '5000.00',
        drawdown_pct: '0',
        positions: [],
        open_orders: [],
        ticks: { interval_s: 300, entry_window: '00:00-00:15Z', entry_done: '2026-10-06' },
        recent_events: [],
      }),
    },
    alerts_24h: [{ ts: '2026-10-06T12:00:00Z', source: 'history', message: 'sample data pull failed, retried' }],
    nightly: { last_report: '2026-10-05', next_run: '2026-10-07T05:20:00Z', last_backup_copy: null },
    ...over,
  };
}

const KILLED: TradingStatus = status({
  kill: { local_file: true, aws_flag: true, aws_checked_at: '2026-10-06T16:50:00Z', last_cause: 'max_drawdown 8.4% (2026-10-06T00:01:23Z)', cleared_at: null },
  sleeves: {
    equities: sleeve({
      halt_state: 'KILL',
      drawdown_pct: '8.4',
      recent_events: [
        { ts: '2026-10-05T20:00:00Z', type: 'FILL', summary: 'sample fill' },
        { ts: '2026-10-06T00:01:23Z', type: 'KILL', summary: 'max_drawdown 8.4%' },
      ],
    }),
    crypto: sleeve({ halt_state: 'DEGRADED', positions: [], open_orders: [] }),
  },
});

const DAY: TradingDay = {
  ...META,
  date: '2026-10-05',
  mode: 'paper',
  g2: { reconcile_diffs: 0, alerts: 1, x402_under_cap: true, x402_total_usdc: '0.02', ok: false },
  sleeves: {
    equities: { paper: { starting_cash: '10000.00', cash: '6100.25', realized_equity: '10100.00', realized_pnl_total: '100.00' } },
    crypto: { paper: { starting_cash: '5000.00', cash: '5000.00', realized_equity: '5000.00', realized_pnl_total: '0' } },
  },
};

const ok = <T,>(data: T | null): FeedState<T> => ({ data, loading: false, error: null });

function view(s: TradingStatus | null, day: TradingDay | null = DAY, pageUrl: string | null = 'https://approvals.example.test/queue', now = NOW) {
  return renderToStaticMarkup(
    <TradingView status={ok(s)} day={ok(day)} config={{ page_url_set: pageUrl != null, page_url: pageUrl }} now={now} />,
  );
}

describe('trading-api helpers', () => {
  it('formats money strings and USDC, and reads halt tones', () => {
    expect(fmtMoney('10240.5')).toBe('10,240.50');
    expect(fmtMoney(null)).toBe('—');
    expect(fmtUsdc('0.030000')).toBe('0.03');
    expect(fmtUsdc('0')).toBe('0');
    expect(haltTone('NORMAL')).toBe('success');
    expect(haltTone('DEGRADED')).toBe('warning');
    expect(haltTone('KILL')).toBe('error');
    expect(haltTone('odd')).toBe('neutral');
    expect(sleeveNames(status())).toEqual(['equities', 'crypto']);
  });

  it('is stale from Hermes’s flag, the route age, or the trader’s own clock', () => {
    expect(staleness(status(), NOW)).toEqual({ stale: false, reason: null });
    expect(staleness(status({ stale: true, stale_reason: 'written_at is 22 minutes old' }), NOW)).toEqual({ stale: true, reason: 'written_at is 22 minutes old' });
    expect(staleness(status({ age_seconds: 16 * 60 }), NOW).stale).toBe(true);
    expect(staleness(status({ written_at: '2026-10-06T16:30:00Z' }), NOW)).toEqual({
      stale: true,
      reason: 'the trader last wrote its status 30 minutes ago',
    });
    expect(staleness(status({ written_at: undefined, age_seconds: 60 }), NOW).stale).toBe(false);
  });

  it('finds when and why a sleeve went to KILL', () => {
    expect(killWhen(KILLED, 'equities')).toBe('2026-10-06T00:01:23Z');
    expect(killCause(KILLED)).toBe('max_drawdown 8.4%');
    const noEvent = status({ kill: { local_file: true, aws_flag: true, last_cause: 'manual (2026-10-06T01:02:03Z)' } });
    expect(killWhen(noEvent, 'equities')).toBe('2026-10-06T01:02:03Z');
    expect(killCause(noEvent)).toBe('manual');
    expect(killWhen(status(), 'equities')).toBeNull();
  });

  it('builds the equity curve from `curve`, else the latest report alone', () => {
    const one = curveRows(DAY);
    expect(one).toEqual([{ date: '2026-10-05', equities: null, equities_realized: 10100, crypto: null, crypto_realized: 5000 }]);
    const many = curveRows({
      ...DAY,
      curve: [
        { date: '2026-10-05', sleeves: { equities: { equity: '10050', realized_equity: '10000' }, crypto: { equity: '5000', realized_equity: '5000' } } },
        { date: '2026-10-04', sleeves: { equities: { equity: '10000', realized_equity: '10000' }, crypto: { equity: '5000', realized_equity: '5000' } } },
      ],
    });
    expect(many.map((r) => r.date)).toEqual(['2026-10-04', '2026-10-05']);
    expect(many[1].equities).toBe(10050);
    expect(curveSleeves(many)).toEqual(['equities', 'crypto']);
    expect(curveRows(null)).toEqual([]);
  });

  it('lists the last 20 non-TICK events across sleeves, newest first', () => {
    const events = recentEvents(KILLED);
    expect(events.map((e) => e.ts)).toEqual([...events.map((e) => e.ts)].sort().reverse());
    expect(events).toContainEqual({ ts: '2026-10-06T00:01:23Z', type: 'KILL', summary: 'max_drawdown 8.4%', sleeve: 'equities' });
    expect(events.some((e) => e.type === 'TICK')).toBe(false);
    expect(eventTone('KILL')).toBe('error');
    expect(eventTone('FILL')).toBe('success');
  });
});

describe('TradingView (0014, read-only)', () => {
  it('renders the header strip: mode, both sleeves’ halt states, heartbeat, age, commit', () => {
    const html = view(status());
    expect(html).toContain('data-trading-header');
    expect(html).toContain('>paper<');
    expect(html).toContain('commit abc1234');
    expect(html).toContain('data-sleeve-pill="equities"');
    expect(html).toContain('data-sleeve-pill="crypto"');
    expect(html.match(/data-halt="NORMAL"/g)?.length).toBe(4); // two pills in the header, one per sleeve card
    expect(html).toContain('data-heartbeat="ok"');
    expect(html).toContain('Status · updated 5 min ago');
    expect(html).not.toContain('data-stale-banner');
  });

  it('shows the stale banner from the feed flag and from the age past 15 minutes', () => {
    expect(view(status({ stale: true, stale_reason: 'written_at is 22 minutes old' }))).toContain('data-stale-banner');
    expect(view(status({ stale: true, stale_reason: 'written_at is 22 minutes old' }))).toContain(STALE_BANNER);
    expect(view(status({ age_seconds: 20 * 60 }))).toContain('data-stale-banner');
    expect(view(status({ age_seconds: 14 * 60 }))).not.toContain('data-stale-banner');
    // The trader's own clock counts too, read against `now`.
    expect(view(status(), DAY, null, NOW + 40 * 60 * 1000)).toContain('data-stale-banner');
  });

  it('a KILL shows in the pill with the cause and the time, and both indicators say where to clear it', () => {
    const html = view(KILLED);
    expect(html).toContain('data-halt="KILL"');
    expect(html).toContain('data-kill-detail');
    expect(html).toContain('max_drawdown 8.4%');
    expect(html).toContain('data-halt="DEGRADED"');
    expect(html).toContain('data-kill-indicator="aws-flag"');
    expect(html).toContain('data-kill-state="set"');
    expect(html).toContain(AWS_FLAG_RULE);
    expect(html).toContain(LOCAL_FILE_RULE);
    expect(html).toContain('Last cause: max_drawdown 8.4%');
    expect(html).toContain('data-heartbeat="ok"');
  });

  it('flags a heartbeat failure', () => {
    const html = view(status({ heartbeat: { last_sent_at: '2026-10-06T16:00:00Z', last_ok: false, alarm: 'ALARM' } }));
    expect(html).toContain('data-heartbeat="alarm"');
    expect(html).toContain('last send failed');
  });

  it('the approval link opens only when a URL is configured, else a hint', () => {
    expect(view(status())).toContain('data-approval-link="enabled"');
    const none = view(status(), DAY, null);
    expect(none).toContain('data-approval-link="disabled"');
    expect(none).toContain(NO_URL_HINT);
    expect(none).toContain('disabled');
  });

  it('renders no action control anywhere: the only button is the approval link', () => {
    const html = view(KILLED);
    // Panel titles render as disabled <button>s (no onTitleClick); the view toggle is Chart | Table.
    const buttons = (html.match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? []).filter((b) => !/<button[^>]*\sdisabled(=|\s|>)/.test(b));
    const labels = buttons.map((b) => b.replace(/<[^>]+>/g, '').trim()).filter((t) => t && !/^(Chart|Table)$/.test(t));
    expect(labels).toEqual(['Open approval page']);
    expect(html).not.toMatch(/pause|resume|clear kill|request/i);
  });

  it('sleeve cards: tiles, the drawdown meter against 8%, positions, orders, ticks and the last tick', () => {
    const html = view(status());
    expect(html).toContain('data-sleeve-card="equities"');
    expect(html).toContain('10,240.50');
    expect(html).toContain('6,100.25');
    expect(html).toContain('data-meter="drawdown-equities"');
    expect(html).toContain('0.58% of 8% limit');
    expect(html).toContain('data-positions');
    expect(html).toContain('SAMPLE-A');
    expect(html).toContain('3 d');
    expect(html).toContain('data-open-orders');
    expect(html).toContain('buy 5 SAMPLE-B · limit @ 42.10 · open');
    // The nightly report's names are accepted as fallbacks.
    const report = renderToStaticMarkup(
      <SleeveCard name="equities" sleeve={sleeve({ open_orders: [{ client_order_id: 'o-2', product_id: 'SAMPLE-C', side: 'sell', type: 'limit', base_size: '2', limit_price: '9.50', status: 'open' }] })} />,
    );
    expect(report).toContain('sell 2 SAMPLE-C · limit @ 9.50 · open');
    expect(html).toContain('data-tick="done"');
    expect(html).toContain('data-tick="due"');
    expect(html).toContain('09:45 ET');
    expect(html).toContain('data-last-tick');
    // Crypto: interval and entry window instead of fixed times.
    expect(html).toContain('data-tick-interval');
    expect(html).toContain('Every 5 min · entry window 00:00-00:15Z · entry done 2026-10-06');
  });

  it('positions carry a Mark column between Entry and Stop, with the print’s time on hover (v1.7.2)', () => {
    const card = (positions: Sleeve['positions']) => renderToStaticMarkup(<SleeveCard name="equities" sleeve={sleeve({ positions })} now={NOW} />);
    const base = { product: 'SAMPLE-A', side: 'LONG', size: '4', entry: '101.25', stop: '96.00', held_days: 1 };
    const marked = card([{ ...base, mark: '108.42', mark_at: '2026-10-06T12:00:00Z' }]);
    expect([...marked.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1])).toEqual(['Product', 'Side', 'Size', 'Entry', 'Mark', 'Stop', 'Held']);
    expect(marked).toMatch(/<td class="pr-3" title="as of \d{2}:00 [^"]+ · 5 h ago" data-mark="true">108\.42<\/td>/);
    // A null mark, and an older file with neither key: a dash and no hover.
    for (const html of [card([{ ...base, mark: null, mark_at: null }]), card([base])]) {
      expect(html).toMatch(/<td class="pr-3" data-mark="true">—<\/td>/);
    }
    // Crypto with nothing held keeps its empty line.
    expect(renderToStaticMarkup(<SleeveCard name="crypto" sleeve={sleeve({ positions: [] })} now={NOW} />)).toContain('No open positions.');
  });

  it('a mark from an earlier day names the date in its hover', () => {
    expect(markAsOf('2026-10-05T12:30:00Z', NOW)).toMatch(/^as of Oct 5, \d{2}:30 \S+ · 28 h ago$/);
    expect(markAsOf(null, NOW)).toBeUndefined();
    expect(markAsOf('not a time', NOW)).toBeUndefined();
  });

  it('the drawdown meter turns red at the limit', () => {
    const html = view(KILLED);
    expect(html).toContain('8.4% of 8% limit');
    expect(html).toMatch(/data-meter="drawdown-equities" data-meter-ratio="1\.000"/);
  });

  it('x402 spend against the cap, the pools, and the nightly line', () => {
    const html = view(status());
    expect(html).toContain('data-spend-card');
    expect(html).toContain('3 payments today');
    expect(html).toContain('0.03 of 3.00 USDC');
    expect(html).toContain('data-meter="spend" data-meter-ratio="0.010"');
    expect(html).toContain('2.00 USDC');
    expect(html).toContain('data-nightly');
    expect(html).toContain('2026-10-05');
    expect(html).toContain('none yet');
    const over = view(status({ x402: { day: '2026-10-06', payments: 400, total_usdc: '3.10', daily_cap_usdc: '3.00', under_cap: false } }));
    expect(over).toContain('Over the daily cap: the trader stops paying for data until tomorrow.');
    expect(over).toContain('data-meter="spend" data-meter-ratio="1.000" data-meter-tone="error"');
    expect(html).toContain('data-meter-tone="accent"');
    const near = view(status({ x402: { day: '2026-10-06', payments: 250, total_usdc: '2.50', daily_cap_usdc: '3.00', under_cap: true } }));
    expect(near).toContain('data-meter="spend" data-meter-ratio="0.833" data-meter-tone="warning"');
    const exact = view(status({ x402: { day: '2026-10-06', payments: 240, total_usdc: '2.400000', daily_cap_usdc: '3.00', under_cap: true } }));
    expect(exact).toContain('data-meter="spend" data-meter-ratio="0.800" data-meter-tone="warning"');
  });

  it('the equity curve shows from day one, with a legend and a table view', () => {
    const html = view(status());
    expect(html).toContain('data-equity-curve="1"');
    expect(html).toContain('data-curve-legend');
    expect(html).toContain('Equities realized equity');
    expect(html).toContain('One day so far');
    const table = renderToStaticMarkup(<EquityCurve day={{ ...DAY, curve: [{ date: '2026-10-05', sleeves: { equities: { equity: '10050', realized_equity: '10000' } } }] }} />);
    expect(table).toContain('Equities equity');
    expect(table).toContain('Equities realized');
  });

  it('events carry type chips and alerts list the last 24 hours', () => {
    const html = view(KILLED);
    expect(html).toContain('data-events');
    expect(html).toContain('data-event-type="KILL"');
    expect(html).toContain('data-event-type="FILL"');
    expect(html).toContain('data-alerts');
    expect(html).toContain('sample data pull failed, retried');
  });

  it('says so before the first status, and when Hermes could not read the export', () => {
    expect(view(null, null, null)).toContain(NO_STATUS_YET);
    const unreadable = view(status({ stale: true, stale_reason: 'status.json missing', sleeves: undefined }));
    expect(unreadable).toContain(NO_SLEEVES);
    expect(unreadable).toContain('data-stale-banner');
  });

  it('renders each card on its own from the fixture', () => {
    expect(renderToStaticMarkup(<TradingHeader status={status()} now={NOW} />)).toContain('data-trading-header');
    expect(renderToStaticMarkup(<KillCard status={status()} config={null} />)).toContain(NO_URL_HINT);
    expect(renderToStaticMarkup(<SleeveCard name="equities" sleeve={null} />)).toContain('No status for this sleeve yet.');
    expect(renderToStaticMarkup(<SpendCard status={null} />)).toContain('No spend reported yet.');
    expect(renderToStaticMarkup(<NightlyCard status={null} />)).toContain('No nightly report yet.');
    expect(renderToStaticMarkup(<EquityCurve day={null} />)).toContain('No nightly report yet.');
    expect(renderToStaticMarkup(<EventsPanel status={null} />)).toContain('No events reported.');
    expect(renderToStaticMarkup(<Meter value={2} limit={8} label="x" />)).toContain('data-meter-ratio="0.250"');
    expect(renderToStaticMarkup(<Meter value={null} limit={8} label="x" />)).toContain('data-meter-ratio="0.000"');
  });
});
