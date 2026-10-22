import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  dayChange,
  localizeStamps,
  localTime,
  pctRows,
  signedMoney,
  signedPct,
  sleeveColor,
  stopDistancePct,
  stopTone,
  tidyEvents,
  topRowGreen,
  untilLabel,
  utcWindowLocal,
  type Sleeve,
  type TradingStatus,
} from '../../lib/trading-api';
import { EquityCurve } from './EquityCurve';
import { EventsPanel } from './EventsPanel';
import { SleeveCard } from './SleeveCard';
import { StatusStrip } from './StatusStrip';
import { TradingHeader } from './TradingHeader';

// Reading aids (2026-10-22). Invented numbers only: this repo is public.
const NOW = Date.parse('2026-10-06T17:00:00Z');

function sleeve(over: Partial<Sleeve> = {}): Sleeve {
  return {
    halt_state: 'NORMAL',
    day: { date: '2026-10-06', start_equity: '10000.00' },
    equity: '9983.30',
    cash: '6100.25',
    realized_equity: '10000.00',
    hwm: '10050.00',
    drawdown_pct: '0.66',
    positions: [{ product: 'SAMPLE-A', side: 'LONG', size: '9', entry: '109.77', mark: '105.66', stop: '104.20', held_days: 5 }],
    open_orders: [],
    ticks: { today: [{ time: '15:45', kind: 'entry', done: false, at: '2026-10-06T19:45:00Z' }], next_due: '2026-10-06T19:45:00Z' },
    ...over,
  };
}

function status(over: Partial<TradingStatus> = {}): TradingStatus {
  return {
    generated_at: '2026-10-06T16:55:00Z',
    age_seconds: 60,
    stale: false,
    written_at: '2026-10-06T16:59:00Z',
    kill: { local_file: false, aws_flag: false, aws_checked_at: '2026-10-06T16:50:00Z' },
    x402: { payments: 1, total_usdc: '0.01', daily_cap_usdc: '3.00', under_cap: true },
    nightly: { last_report: '2026-10-05', next_run: '2026-10-07T05:20:00Z', last_backup_copy: '2026-10-06T00:00:00Z' },
    sleeves: { equities: sleeve(), crypto: sleeve({ positions: [] }), futures: sleeve({ positions: [] }) },
    ...over,
  };
}

describe("today's P&L and the distance to stop", () => {
  it('reads the change since the day start, signed', () => {
    const d = dayChange(sleeve())!;
    expect(d.abs).toBeCloseTo(-16.7);
    expect(signedMoney(d.abs)).toBe('−16.70');
    expect(signedPct(d.pct)).toBe('−0.17%');
    expect(signedMoney(12.5)).toBe('+12.50');
    expect(signedMoney(0.001)).toBe('0.00');
    expect(dayChange(sleeve({ day: {} }))).toBeNull();
  });

  it('the Equity tile carries it, red when down', () => {
    const html = renderToStaticMarkup(<SleeveCard name="equities" sleeve={sleeve()} now={NOW} />);
    expect(html).toMatch(/color:var\(--color-error\)[^>]*><span data-day-change="true"[^>]*>−16.70 \(−0.17%\) today/);
  });

  it('measures room to the stop for longs and shorts, amber under 2 %, red through it', () => {
    expect(stopDistancePct({ side: 'LONG', mark: '105.66', stop: '104.20' })).toBeCloseTo(1.38, 2);
    expect(stopDistancePct({ side: 'short', mark: '100', stop: '105' })).toBeCloseTo(5);
    expect(stopDistancePct({ side: 'long', mark: '100', stop: '101' })).toBeCloseTo(-1);
    expect(stopDistancePct({ side: 'long', mark: null, stop: '101' })).toBeNull();
    expect(stopTone(1.38)).toBe('warning');
    expect(stopTone(-1)).toBe('error');
    expect(stopTone(5)).toBeNull();
    const html = renderToStaticMarkup(<SleeveCard name="equities" sleeve={sleeve()} now={NOW} />);
    expect(html).toContain('data-stop-distance="1.38"');
    expect(html).toMatch(/color:var\(--color-warning\)[^>]*title="The mark is 1.4% from the stop">1.4%</);
  });
});

describe('the curve as % from start', () => {
  it('each series from its own first point; a later sleeve starts at 0 %', () => {
    const rows = pctRows([
      { date: '2026-10-04', equities_realized: 10000, futures_realized: null },
      { date: '2026-10-05', equities_realized: 10100, futures_realized: 20000 },
      { date: '2026-10-06', equities_realized: 9900, futures_realized: 21000 },
    ]);
    expect(rows.map((r) => Number((r.equities_realized as number).toFixed(6)))).toEqual([0, 1, -1]);
    expect(rows.map((r) => (r.futures_realized == null ? null : Number((r.futures_realized as number).toFixed(6))))).toEqual([null, 0, 5]);
  });

  it('defaults to %, with $ beside it', () => {
    const html = renderToStaticMarkup(
      <EquityCurve
        day={{ generated_at: '', age_seconds: 0, stale: false, date: '2026-10-05', curve: [{ date: '2026-10-05', sleeves: { futures: { realized_equity: '20000' } } }] }}
      />,
    );
    expect(html).toContain('data-curve-unit="pct"');
    expect(html).toContain('% from start');
    expect(html).toContain('border-color:var(--viz-series-3)');
  });
});

describe('one colour per sleeve', () => {
  it('assigns by name, so a missing sleeve never shifts the others', () => {
    expect(sleeveColor('futures')).toBe('var(--viz-series-3)');
    expect(sleeveColor('other')).toBe('var(--color-text-tertiary)');
    const header = renderToStaticMarkup(<TradingHeader status={status()} now={NOW} />);
    expect(header).toMatch(/data-sleeve-name="crypto"><span[^>]*background:var\(--viz-series-2\)/);
    const card = renderToStaticMarkup(<SleeveCard name="futures" sleeve={sleeve()} now={NOW} />);
    expect(card).toContain('color:var(--viz-series-3)');
  });
});

describe('events without repeats', () => {
  const s = status({
    alerts_24h: [{ ts: '2026-10-06T15:00:00.000Z', source: 'scheduler', message: 'market fetch failed' }],
    sleeves: {
      futures: sleeve({
        recent_events: [
          { ts: '2026-10-06T14:00:00Z', type: 'SIGNAL', summary: 'BUY SAMPLE: close > 10-day high' },
          { ts: '2026-10-06T14:00:00Z', type: 'PROPOSAL', summary: 'BUY 2 SAMPLE @ 100' },
          { ts: '2026-10-06T15:00:00Z', type: 'ALERT', summary: 'scheduler: market fetch failed' },
          { ts: '2026-10-06T15:30:00Z', type: 'ALERT', summary: 'kernel: other' },
          { ts: '2026-10-06T16:00:00Z', type: 'SIGNAL', summary: 'lone signal' },
          { ts: '2026-10-06T16:05:00Z', type: 'TICK' },
        ],
      }),
      equities: sleeve({ recent_events: [{ ts: '2026-10-06T13:00:00Z', type: 'FILL', summary: 'sample fill' }] }),
    },
  });

  it('folds a SIGNAL into its PROPOSAL and leaves alerts to the Alerts panel', () => {
    const ev = tidyEvents(s);
    expect(ev.map((e) => [e.type, e.sleeve])).toEqual([
      ['SIGNAL', 'futures'],
      ['ALERT', 'futures'],
      ['PROPOSAL', 'futures'],
      ['FILL', 'equities'],
    ]);
    expect(ev[2].reason).toBe('BUY SAMPLE: close > 10-day high');
    expect(tidyEvents(s, 'equities').map((e) => e.type)).toEqual(['FILL']);
  });

  it('folds back-to-back repeats into one row with a count', () => {
    const repeats = status({
      sleeves: {
        crypto: sleeve({
          recent_events: [
            { ts: '2026-10-06T10:00:00Z', type: 'ALERT', summary: 'scheduler: product refresh failed' },
            { ts: '2026-10-06T10:05:00Z', type: 'ALERT', summary: 'scheduler: product refresh failed' },
            { ts: '2026-10-06T10:10:00Z', type: 'ALERT', summary: 'scheduler: product refresh failed' },
            { ts: '2026-10-06T11:00:00Z', type: 'FILL', summary: 'sample fill' },
          ],
        }),
      },
    });
    const ev = tidyEvents(repeats);
    expect(ev.map((e) => [e.type, e.repeat ?? 1])).toEqual([
      ['FILL', 1],
      ['ALERT', 3],
    ]);
    expect(ev[1]).toMatchObject({ ts: '2026-10-06T10:10:00Z', first_ts: '2026-10-06T10:00:00Z' });
    expect(renderToStaticMarkup(<EventsPanel status={repeats} />)).toContain('data-event-repeat="3"');
  });

  it('renders columns, the reason line and a sleeve filter', () => {
    const html = renderToStaticMarkup(<EventsPanel status={s} />);
    expect(html).toContain('grid-cols-[auto_auto_auto_minmax(0,1fr)]');
    expect(html).toMatch(/data-event-reason="true"[^>]*>BUY SAMPLE: close &gt; 10-day high/);
    expect(html).toContain('aria-label="Events for"');
    expect(html).not.toContain('scheduler: market fetch failed');
  });
});

describe('one time zone', () => {
  it('local times, a relative next-due, the UTC window in local time', () => {
    expect(untilLabel('2026-10-06T19:10:00Z', NOW)).toBe('in 2 h 10 min');
    expect(untilLabel('2026-10-06T17:05:00Z', NOW)).toBe('in 5 min');
    expect(untilLabel('2026-10-06T16:48:00Z', NOW)).toBe('12 min overdue');
    expect(utcWindowLocal('00:01-00:16Z', NOW)).toBe(`${localTime('2026-10-06T00:01:00Z')}–${localTime('2026-10-06T00:16:00Z')}`);
    expect(utcWindowLocal('not a window', NOW)).toBeNull();
    const local = new Date('2026-10-06T00:01:23.411Z').toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    expect(localizeStamps(null)).toBe('');
    expect(renderToStaticMarkup(<EventsPanel status={status({ alerts_24h: [{ ts: '2026-10-06T15:00:00Z', source: 'kernel', message: null as unknown as string }] })} />)).toContain('kernel');
    expect(localizeStamps('max_drawdown: set at 2026-10-06T00:01:23.411Z')).toBe(`max_drawdown: set at ${local}`);
    const html = renderToStaticMarkup(<SleeveCard name="equities" sleeve={sleeve()} now={NOW} />);
    expect(html).toContain('title="15:45 ET"');
    expect(html).toContain(`${localTime('2026-10-06T19:45:00Z')}</span>`);
    expect(html).toContain(`Next due in 2 h 45 min (${localTime('2026-10-06T19:45:00Z')})`);
  });
});

describe('the status row folds while all is fine', () => {
  it('one line when green, with the approval link and Details', () => {
    expect(topRowGreen(status())).toBe(true);
    const html = renderToStaticMarkup(<StatusStrip status={status()} config={{ page_url_set: true, page_url: 'https://approvals.example.test/q' }} />);
    expect(html).toContain('data-status-row="folded"');
    expect(html).toContain('Kill switch clear');
    expect(html).toContain('Approval page');
    expect(html).toContain('Details');
    expect(html).not.toContain('data-status-row="full"');
  });

  it('the full cards whenever anything is off', () => {
    const off: [string, Partial<TradingStatus>][] = [
      ['kill flag', { kill: { local_file: true, aws_flag: false } }],
      ['aws unknown', { kill: { local_file: false, aws_flag: 'unknown' } }],
      ['spend 80 %', { x402: { payments: 9, total_usdc: '2.40', daily_cap_usdc: '3.00', under_cap: true } }],
      ['no off-VHD copy', { nightly: { last_report: '2026-10-05', last_backup_copy: null } }],
    ];
    for (const [why, over] of off) {
      expect(topRowGreen(status(over)), why).toBe(false);
      expect(renderToStaticMarkup(<StatusStrip status={status(over)} config={null} />), why).toContain('data-status-row="full"');
    }
    expect(renderToStaticMarkup(<StatusStrip status={null} config={null} loading />)).toContain('data-status-row="full"');
  });
});
