import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { SpendLedger, SpendLine } from '../../lib/commerce-api';
import { linkFor } from '../../lib/waiting-api';
import { amount } from '../Commerce/SpendLedgerPanel';
import { ROUTES_READY } from '../Sidebar/Sidebar';
import { health, row } from '../Sidebar/stackHealthFixtures';
import { ENGINE_SLOTS, EngineCostView, OTHER, engineRows, engineSeries, type CostSource } from './EngineCost';
import { OpsView, type OpsViewProps } from './OpsView';
import { SpendBurnView, burnPoints, niceTicks } from './SpendBurn';
import { RunTimeline, StackBandView } from './StackBand';

vi.hoisted(() => {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> }).localStorage ??= {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  };
});

// Invented fixtures only: this repo is public.
const NOW = new Date(2026, 0, 10, 12, 0).getTime(); // Jan 10, local noon
const META = { generated_at: '2026-01-10T12:00:00Z', age_seconds: 60, stale: false };

const line = (over: Partial<SpendLine>): SpendLine => ({ id: 'line-a', cap: 100, unit: 'usd', period: 'month', actual: 10, pct: 10, status: 'ok', ...over });

const LEDGER: SpendLedger = {
  ...META,
  run_at: '2026-01-10T12:00:00Z',
  status: 'ok',
  lines: [
    line({ id: 'aws-total', cap: 150, actual: 30.2, pct: 20.1 }),
    line({ id: 'bedrock-all', cap: 100, actual: 85, pct: 85, status: 'warn' }),
    line({ id: 'studio-a-month', cap: 30, actual: null, pct: null, status: 'not_read', not_read: 'no mount for this line' }),
    line({ id: 'api-quota', cap: 10000, unit: 'units', period: 'day', actual: 16, pct: 0.2 }),
    line({ id: 'over-line', actual: 120, pct: 120, status: 'at_cap' }),
  ],
  parse_errors: [],
  alerts: [{ kind: 'spend_cap', line: 'bedrock-all', level: 80, pct: 85, lane: 'act', period: '2026-01', message: 'Bedrock at 85 % of its cap', raised_at: '2026-01-10T11:00:00Z' }],
  cost_reader: { configured: true, read_at: '2026-01-10T12:00:00Z', month: '2026-01', total: 30.2, bedrock: 4.12, forecast_total: 93.62, forecast_bedrock: 12.77, calls_month: 6, error: null },
};

const SOURCES: CostSource[] = [
  { label: 'Content', cost: { week_usd: 1.5, month_usd: 4.25, by_engine: { 'model-a': 3, 'model-b': 1.25, local: 0 } } },
  { label: 'BizDev · line-a', cost: { week_usd: 0.4, month_usd: 1.0, by_engine: { 'model-a': 0.75, 'model-c': 0.25 } } },
];

describe('Ops: spend burn (plan 5.3)', () => {
  it('builds the burn from the reader: 0 on the 1st, the month to date today, the forecast at month end', () => {
    const b = burnPoints(LEDGER.cost_reader, NOW)!;
    expect(b.today).toBe(10);
    expect(b.days).toBe(31);
    expect(b.points).toEqual([
      { day: 0, aws: 0, bedrock: 0 },
      { day: 10, aws: 30.2, bedrock: 4.12, awsForecast: 30.2, bedrockForecast: 4.12 },
      { day: 31, awsForecast: 93.62, bedrockForecast: 12.77 },
    ]);
    expect(burnPoints({ configured: false }, NOW)).toBeNull();
    expect(burnPoints({ configured: true, total: null }, NOW)).toBeNull();
  });

  it('one gauge per line with the tiles’ own figures; the Table view shows the same numbers', () => {
    const gauges = renderToStaticMarkup(<SpendBurnView ledger={LEDGER} now={NOW} />);
    expect(gauges).toContain('data-spend-view="gauges"');
    expect(gauges.match(/data-spend-gauge="/g)).toHaveLength(LEDGER.lines.length);
    const table = renderToStaticMarkup(<SpendBurnView ledger={LEDGER} now={NOW} initialView="table" />);
    expect(table.match(/data-spend-line="/g)).toHaveLength(LEDGER.lines.length);
    for (const l of LEDGER.lines) {
      const fig = amount(l.actual, l.unit);
      expect(gauges).toContain(fig);
      expect(table).toContain(fig);
    }
    // The fill stops at the cap; an over-cap line says at cap.
    expect(gauges).toMatch(/data-spend-gauge="over-line" data-status="at_cap"/);
    expect(gauges).toContain('aria-valuenow="120"');
    expect(gauges).toContain('width:100%');
    // AWS and Bedrock month to date with their forecasts; the act alert shows.
    expect(gauges).toContain('$30.20 to date · forecast $93.62');
    expect(gauges).toContain('$4.12 to date · forecast $12.77');
    expect(gauges).toContain('Bedrock at 85 % of its cap');
    expect(gauges).toContain('id="spend-aws-total"');
  });

  it('the burn axis takes round steps that clear the highest cap or forecast', () => {
    expect(niceTicks(150)).toEqual([0, 50, 100, 150, 200]);
    expect(niceTicks(93.62)).toEqual([0, 25, 50, 75, 100]);
    expect(niceTicks(0)).toEqual([0, 0.5, 1, 1.5, 2]);
  });

  it('says so without a reader or a ledger', () => {
    expect(renderToStaticMarkup(<SpendBurnView ledger={{ ...LEDGER, cost_reader: { configured: false } }} now={NOW} />)).toContain('cost reader isn’t configured');
    expect(renderToStaticMarkup(<SpendBurnView ledger={null} now={NOW} />)).toContain('No spend ledger read yet.');
  });

  it('a spend row from Waiting lands on /ops', () => {
    expect(linkFor({ link: { page: '/commerce', focus: 'spend-aws-total' } })).toBe('/ops?focus=spend-aws-total');
    expect(ROUTES_READY.ops).toBe(true);
  });
});

describe('Ops: cost by engine', () => {
  it('ranks paid engines in fixed slots, lists free ones apart, folds a sixth into Other', () => {
    const { paid, free } = engineSeries(SOURCES);
    expect(paid.map((p) => [p.engine, p.usd, p.color])).toEqual([
      ['model-a', 3.75, ENGINE_SLOTS[0]],
      ['model-b', 1.25, ENGINE_SLOTS[1]],
      ['model-c', 0.25, ENGINE_SLOTS[2]],
    ]);
    expect(free).toEqual(['local']);
    const many: CostSource[] = [{ label: 'X', cost: { week_usd: 0, month_usd: 6, by_engine: { a: 6, b: 5, c: 4, d: 3, e: 2, f: 1 } } }];
    const folded = engineSeries(many).paid;
    expect(folded.map((p) => p.engine)).toEqual(['a', 'b', 'c', 'd', OTHER]);
    expect(folded[4].usd).toBe(3);
    expect(engineRows(many, folded.map((p) => p.engine))[0][OTHER]).toBe(3);
  });

  it('renders the legend totals and the per-source table', () => {
    const html = renderToStaticMarkup(<EngineCostView sources={SOURCES} />);
    expect(html).toContain('$5.25 this month');
    expect(html).toContain('Free / local: local');
    expect(html).toContain('>$3.75<');
    expect(html).toContain('>BizDev · line-a<');
    expect(renderToStaticMarkup(<EngineCostView sources={[]} />)).toContain('No cost blocks yet');
  });
});

describe('Ops: stack band', () => {
  const props = { level: 'fail' as const, age: 600, now: NOW, missing: false, error: null, run: { state: 'idle' as const, detail: null }, onRun: () => {} };

  it('counts, the check mix, the four scheduled runs and Run now', () => {
    const h = health({ failing: [row('web', 'site-a', 'FAIL')], counts: { FAIL: 1, WARN: 2, OK: 20, SKIP: 1 } });
    const html = renderToStaticMarkup(<StackBandView health={h} {...props} />);
    expect(html).toContain('data-stack-band="fail"');
    expect(html).toMatch(/data-count="FAIL"[\s\S]*?>1</);
    expect(html).toContain('data-check-mix');
    expect(html).toContain('aria-label="1 FAIL, 2 WARN, 20 OK, 1 SKIP"');
    expect(html.match(/data-slot="/g)).toHaveLength(4);
    expect(html).toContain('Run now');
    expect(html).toContain('web/site-a');
  });

  it('Run now is disabled while a run is polled', () => {
    const html = renderToStaticMarkup(<StackBandView health={health()} {...props} run={{ state: 'running', detail: null }} />);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Running…/);
  });

  it('marks exactly one next slot', () => {
    const html = renderToStaticMarkup(<RunTimeline ranAt={null} now={NOW} />);
    expect(html.match(/data-next="true"/g)).toHaveLength(1);
    expect(html).not.toContain('data-last-run');
  });
});

describe('Ops: the page rows', () => {
  const view = (over: Partial<OpsViewProps> = {}) =>
    renderToStaticMarkup(
      <OpsView
        stack={{ health: health(), level: 'ok', age: 60, now: NOW, missing: false, error: null, run: { state: 'idle', detail: null }, onRun: () => {} }}
        spend={{ data: LEDGER, loading: false, error: null }}
        costs={{ sources: SOURCES, loading: false, error: null }}
        voice={{ data: { queue: { run_at: null, generated_at: null, worker: true, items: [] }, tts: { available: true, backend: 'tts-a' }, stt: { available: false, reason: 'no model' } }, loading: false, error: null }}
        connectors={{ connectors: [{ connector_id: 'c1', display_name: 'Source A', connected: true, chunks: 0, auth_type: 'oauth' }, { connector_id: 'c2', display_name: 'Source B', connected: false, chunks: 0, auth_type: 'oauth' }], error: null }}
        freshness={[]}
        now={NOW}
        machine={<div data-machine-stub />}
        {...over}
      />,
    );

  it('row 2 wide + third tall, row 3 half + machine, row 4 three short with cost comparison dim', () => {
    const html = view();
    expect(html).toContain('lg:col-span-8 lg:h-[860px]'); // Spend burn
    expect(html.match(/lg:col-span-4 lg:h-\[860px\]/g)).toHaveLength(1); // Cost by engine
    expect(html).toContain('lg:col-span-6 lg:h-[860px]'); // Stack detail
    expect(html).toContain('data-machine-stub');
    expect(html.match(/col-span-12 lg:col-span-4 lg:h-\[420px\]/g)).toHaveLength(3);
    expect(html).toContain('opacity:0.82');
    expect(html).toContain('1 of 2 connected');
    expect(html).toContain('worker up');
    expect(html).toContain('data-stack-detail');
  });
});
