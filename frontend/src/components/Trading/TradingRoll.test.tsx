import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { rollFolded, rollTone, stopDistancePct, stopTone, type Roll, type Sleeve, type TradingStatus } from '../../lib/trading-api';
import { TradingSummaryView } from '../Dashboard/TradingSummaryPanel';
import { EventsPanel, eventTone } from './EventsPanel';
import { RollBlock, SleeveCard } from './SleeveCard';

// The futures roll and short positions (v1.23.4). Invented contract codes
// and numbers only: this repo is public.
const NOW = Date.parse('2026-11-20T17:00:00Z');

function sleeve(over: Partial<Sleeve> = {}): Sleeve {
  return {
    halt_state: 'NORMAL',
    day: { date: '2026-11-20', start_equity: '10000.00' },
    equity: '10010.00',
    cash: '9000.00',
    realized_equity: '10000.00',
    hwm: '10050.00',
    drawdown_pct: '0.40',
    positions: [],
    open_orders: [],
    recent_events: [],
    ...over,
  };
}

function status(over: Partial<TradingStatus> = {}, futures: Partial<Sleeve> = {}): TradingStatus {
  return {
    generated_at: '2026-11-20T16:55:00Z',
    age_seconds: 60,
    stale: false,
    written_at: '2026-11-20T16:59:00Z',
    mode: 'paper',
    kill: { local_file: false, aws_flag: false },
    x402: { payments: 0, total_usdc: '0', daily_cap_usdc: '3.00', under_cap: true },
    sleeves: { equities: sleeve(), futures: sleeve(futures) },
    ...over,
  };
}

const SHORT = { product: 'SAMPLE-27NOV26-X', side: 'SHORT', size: '1', entry: '100.00', mark: '98.00', stop: '101.00', held_days: 2 };
const SHORT_PAST = { ...SHORT, mark: '101.50' };

const roll = (over: Partial<Roll> = {}): Roll => ({
  id: 'roll-sample-1',
  source: 'auto',
  requested_at: '2026-11-20T14:00:00Z',
  state: 'exiting',
  legs: [{ from: 'SAMPLE-27NOV26-X', to: 'SAMPLE-25DEC26-X', state: 'exiting', reason: null }],
  ...over,
});

describe('short positions (R1)', () => {
  it('a short is safe with the mark below the stop, and through it above', () => {
    expect(stopDistancePct(SHORT)).toBeCloseTo((3 / 98) * 100, 3);
    expect(stopTone(stopDistancePct(SHORT))).toBeNull();
    expect(stopDistancePct(SHORT_PAST)!).toBeLessThan(0);
    expect(stopTone(stopDistancePct(SHORT_PAST))).toBe('error');
  });

  it('the positions table shows SHORT with its distance, and "past" once through', () => {
    const ok = renderToStaticMarkup(<SleeveCard name="futures" sleeve={sleeve({ positions: [SHORT] })} now={NOW} />);
    expect(ok).toContain('>SHORT<');
    expect(ok).toContain('data-stop-distance="3.06"');
    expect(ok).not.toContain('>past<');
    const past = renderToStaticMarkup(<SleeveCard name="futures" sleeve={sleeve({ positions: [SHORT_PAST] })} now={NOW} />);
    expect(past).toContain('>past<');
    expect(past).toContain('var(--color-error)');
  });

  it('the Dashboard summary shows SHORT with its stop distance', () => {
    const ok = renderToStaticMarkup(<TradingSummaryView status={status({}, { positions: [SHORT] })} now={NOW} />);
    expect(ok).toContain('SHORT 1 SAMPLE-27NOV26-X');
    expect(ok).toContain('data-summary-stop-distance="3.06"');
    expect(ok).toContain('3.1% away');
    const past = renderToStaticMarkup(<TradingSummaryView status={status({}, { positions: [SHORT_PAST] })} now={NOW} />);
    expect(past).toContain('past the stop');
    expect(past).toContain('var(--color-error)');
  });
});

describe('the roll on the Futures card (R2)', () => {
  it('null or absent shows nothing', () => {
    expect(renderToStaticMarkup(<RollBlock roll={null} now={NOW} />)).toBe('');
    expect(renderToStaticMarkup(<RollBlock roll={undefined} now={NOW} />)).toBe('');
    const card = renderToStaticMarkup(<SleeveCard name="futures" sleeve={sleeve({ roll: null })} now={NOW} />);
    expect(card).not.toContain('data-roll');
    expect(renderToStaticMarkup(<SleeveCard name="futures" sleeve={sleeve()} now={NOW} />)).not.toContain('data-roll');
  });

  it('the line: source, state and the requested time; a row per leg', () => {
    const html = renderToStaticMarkup(<SleeveCard name="futures" sleeve={sleeve({ roll: roll({ source: 'manual' }) })} now={NOW} />);
    expect(html).toContain('data-roll="exiting"');
    expect(html).toContain('Roll (manual),');
    expect(html).toContain('requested ');
    expect(html).toContain('SAMPLE-27NOV26-X → SAMPLE-25DEC26-X');
    expect(html).toContain('data-roll-leg="exiting"');
  });

  it('tones: in flight is info, refused a warning, done and skipped muted', () => {
    for (const st of ['pending', 'exiting', 'entering']) expect(rollTone(st)).toBe('accent');
    expect(rollTone('refused')).toBe('warning');
    expect(rollTone('done')).toBe('muted');
    expect(rollTone('skipped')).toBe('muted');
    for (const st of ['pending', 'exiting', 'entering', 'done', 'refused']) {
      expect(renderToStaticMarkup(<RollBlock roll={roll({ state: st })} now={NOW} />)).toContain(`data-roll="${st}"`);
    }
  });

  it('every leg state, a refused leg with its reason, and no next contract', () => {
    const html = renderToStaticMarkup(
      <RollBlock
        roll={roll({
          state: 'refused',
          legs: [
            { from: 'SAMPLE-A-NOV', to: 'SAMPLE-A-DEC', state: 'done', reason: null },
            { from: 'SAMPLE-B-NOV', to: 'SAMPLE-B-DEC', state: 'refused', reason: 'sample: margin check failed' },
            { from: 'SAMPLE-C-NOV', to: null, state: 'skipped', reason: 'sample: no next contract' },
            { from: 'SAMPLE-D-NOV', to: 'SAMPLE-D-DEC', state: 'entering' },
            { from: 'SAMPLE-E-NOV', to: 'SAMPLE-E-DEC', state: 'exiting' },
          ],
        })}
        now={NOW}
      />,
    );
    for (const st of ['done', 'refused', 'skipped', 'entering', 'exiting']) expect(html).toContain(`data-roll-leg="${st}"`);
    expect(html).toContain('sample: margin check failed');
    expect(html).toContain('SAMPLE-C-NOV → none');
    expect(html).toContain('var(--color-warning)');
  });

  it('a done roll over 7 days old folds to one muted line; a fresh one does not', () => {
    const old = roll({ state: 'done', requested_at: '2026-11-10T14:00:00Z' });
    expect(rollFolded(old, NOW)).toBe(true);
    const html = renderToStaticMarkup(<RollBlock roll={old} now={NOW} />);
    expect(html).toContain('data-roll="folded"');
    expect(html).not.toContain('data-roll-legs');
    expect(rollFolded(roll({ state: 'done' }), NOW)).toBe(false);
    // An old roll that was refused stays open: it says why an underlying is flat.
    expect(rollFolded(roll({ state: 'refused', requested_at: '2026-11-10T14:00:00Z' }), NOW)).toBe(false);
  });
});

describe('roll events (R3)', () => {
  it('ROLL_REFUSED is a warning, the other ROLL_* types the default', () => {
    expect(eventTone('ROLL_REFUSED')).toBe('warning');
    for (const t of ['ROLL_REQUEST', 'ROLL_EXIT', 'ROLL_ENTRY', 'ROLL_DONE']) expect(eventTone(t)).toBe(eventTone('SOME_FUTURE_TYPE'));
  });

  it('renders the warning chip, and an unknown type as plain text', () => {
    const html = renderToStaticMarkup(
      <EventsPanel
        status={status({}, {
          recent_events: [
            { ts: '2026-11-20T14:05:00Z', type: 'ROLL_REFUSED', summary: 'sample: second leg refused' },
            { ts: '2026-11-20T14:00:00Z', type: 'ROLL_REQUEST', summary: 'sample: auto roll requested' },
            { ts: '2026-11-20T13:00:00Z', type: 'SOME_FUTURE_TYPE', summary: 'sample: a new kind of event' },
          ],
        })}
      />,
    );
    expect(html).toContain('data-event-type="ROLL_REFUSED"');
    expect(html).toMatch(/var\(--color-warning\)[^<]*>ROLL_REFUSED</);
    expect(html).toContain('>ROLL_REQUEST<');
    expect(html).toContain('>SOME_FUTURE_TYPE<');
    expect(html).toContain('sample: a new kind of event');
  });
});
