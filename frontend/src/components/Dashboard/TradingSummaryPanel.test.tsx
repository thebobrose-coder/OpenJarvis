import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OVER_CAP, spendTone, type Sleeve, type TradingStatus } from '../../lib/trading-api';
import { SOURCE_LABELS } from '../../lib/voice-api';
import { ORDER_EVENT_TYPES, TradingSummaryView } from './TradingSummaryPanel';

// Invented numbers only: this repo is public.
const NOW = Date.parse('2026-10-06T17:00:00Z');

function sleeve(over: Partial<Sleeve> = {}): Sleeve {
  return {
    halt_state: 'NORMAL',
    equity: '10240.50',
    cash: '6100.25',
    realized_equity: '10100.00',
    hwm: '10300.00',
    drawdown_pct: '0.58',
    positions: [],
    open_orders: [],
    recent_events: [],
    ...over,
  };
}

function status(over: Partial<TradingStatus> = {}): TradingStatus {
  return {
    generated_at: '2026-10-06T16:55:00Z',
    age_seconds: 300,
    stale: false,
    written_at: '2026-10-06T16:54:25Z',
    mode: 'paper',
    kill: { local_file: false, aws_flag: false, last_cause: null },
    heartbeat: { last_sent_at: '2026-10-06T16:54:00Z', last_ok: true, alarm: 'OK' },
    x402: { day: '2026-10-06', payments: 3, total_usdc: '0.030000', daily_cap_usdc: '3.00' },
    sleeves: {
      equities: sleeve({
        positions: [{ product: 'SAMPLE-A', side: 'long', size: '12', entry: '101.25', stop: '96.00', held_days: 3 }],
        recent_events: [
          { ts: '2026-10-06T13:45:10Z', type: 'PROPOSAL', summary: 'buy 12 SAMPLE-A (sample strategy)' },
          { ts: '2026-10-06T13:46:00Z', type: 'HITL', summary: 'approved' },
          { ts: '2026-10-06T14:00:00Z', type: 'DEGRADED_CLEARED', summary: 'data back' },
        ],
      }),
      crypto: sleeve({ equity: '5000.00', drawdown_pct: '0' }),
    },
    ...over,
  };
}

const view = (s: TradingStatus, now = NOW) => renderToStaticMarkup(<TradingSummaryView status={s} now={now} onOpen={() => {}} />);

describe('Trading Summary (Dashboard)', () => {
  it('shows each sleeve’s halt state and equity, open positions, the latest order activity and spend', () => {
    const html = view(status());
    expect(html).toContain('data-trading-sleeves');
    expect(html.match(/data-halt="NORMAL"/g)?.length).toBe(2);
    expect(html).toContain('10,240.50');
    expect(html).toContain('5,000.00');
    expect(html).toContain('data-summary-positions');
    expect(html).toContain('long 12 SAMPLE-A @ 101.25 · stop 96.00 · 3 d');
    expect(html).toContain('data-latest-order');
    // The newest order-activity event wins; the DEGRADED_CLEARED event is not order activity.
    expect(html).toContain('>HITL<');
    expect(html).not.toContain('DEGRADED_CLEARED');
    expect(html).toContain('x402 today: 3 payments');
    expect(html).toContain('0.03 of 3.00 USDC');
    expect(html).toContain('Trading view');
    expect(html).not.toContain('data-trading-warnings');
    expect(ORDER_EVENT_TYPES.has('FILL')).toBe(true);
  });

  it('shows today’s spend as a meter above the sleeves, and not in the footer', () => {
    const html = view(status());
    expect(html).toContain('data-meter="summary-spend" data-meter-ratio="0.010" data-meter-tone="accent"');
    expect(html.indexOf('data-meter="summary-spend"')).toBeLessThan(html.indexOf('data-trading-sleeves'));
    expect(html.indexOf('data-summary-spend')).toBeLessThan(html.indexOf('data-trading-sleeves'));
    const footer = html.slice(html.indexOf('data-summary-footer'));
    expect(footer).toContain('Trading view');
    expect(footer).not.toContain('x402');
    expect(footer).not.toContain('USDC');
  });

  it('colours the spend meter like the Trading page: amber from 80 %, red with the sentence over the cap', () => {
    const near = { day: '2026-10-06', payments: 250, total_usdc: '2.50', daily_cap_usdc: '3.00' };
    expect(view(status({ x402: near }))).toContain('data-meter="summary-spend" data-meter-ratio="0.833" data-meter-tone="warning"');
    expect(view(status({ x402: near }))).not.toContain(OVER_CAP);
    const over = { day: '2026-10-06', payments: 400, total_usdc: '3.10', daily_cap_usdc: '3.00', under_cap: false };
    const html = view(status({ x402: over }));
    expect(html).toContain('data-meter-tone="error"');
    expect(html).toContain(OVER_CAP);
    expect(spendTone(over)).toBe('error');
    expect(spendTone(near)).toBe('warning');
    expect(spendTone(status().x402)).toBe('accent');
  });

  it('says spend is not reported, at the top and without a meter, when the status has no x402 block', () => {
    const html = view(status({ x402: undefined }));
    expect(html).toContain('x402 spend not reported');
    expect(html).not.toContain('data-meter="summary-spend"');
    expect(html.indexOf('x402 spend not reported')).toBeLessThan(html.indexOf('data-trading-sleeves'));
  });

  it('warns on KILL with the cause and where it is cleared, on a heartbeat alarm, and on a stale status', () => {
    const killed = view(
      status({
        kill: { local_file: true, aws_flag: true, last_cause: 'max_drawdown 8.4% (2026-10-06T00:01:23Z)' },
        heartbeat: { last_sent_at: '2026-10-06T16:00:00Z', last_ok: false, alarm: 'ALARM' },
        sleeves: { equities: sleeve({ halt_state: 'KILL', drawdown_pct: '8.4' }), crypto: sleeve() },
      }),
    );
    expect(killed).toContain('data-trading-warnings');
    expect(killed).toContain('Equities is in KILL: max_drawdown 8.4%');
    expect(killed).toContain('approval page with MFA');
    expect(killed).toContain('Heartbeat alarm');
    expect(killed).toContain('data-halt="KILL"');
    const stale = view(status({ stale: true, stale_reason: 'written_at is 22 minutes old' }));
    expect(stale).toContain('Status is stale (written_at is 22 minutes old)');
    expect(view(status(), NOW + 40 * 60 * 1000)).toContain('Status is stale');
  });

  it('says so with no positions, no order activity, or no sleeves', () => {
    const quiet = view(status({ sleeves: { equities: sleeve(), crypto: sleeve() } }));
    expect(quiet).toContain('No open positions.');
    expect(quiet).toContain('No proposals or fills in the recent events.');
    expect(view(status({ sleeves: undefined }))).toContain('could not read the trader');
  });

  it('labels the trading speech source for the Listen lineup', () => {
    expect(SOURCE_LABELS.trading_status).toBe('Trading');
  });
});
