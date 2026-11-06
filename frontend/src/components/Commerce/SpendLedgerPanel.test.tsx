import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SpendLedger, SpendLine } from '../../lib/commerce-api';
import { amount, groupLines, SpendLedgerPanel } from './SpendLedgerPanel';

// Invented fixtures only: this repo is public.
const META = { generated_at: '2026-01-05T12:45:00Z', age_seconds: 60, stale: false };

const line = (over: Partial<SpendLine>): SpendLine => ({
  id: 'line-a',
  cap: 100,
  unit: 'usd',
  period: 'month',
  actual: 10,
  pct: 10,
  status: 'ok',
  ...over,
});

const LEDGER: SpendLedger = {
  ...META,
  run_at: '2026-01-05T12:45:00Z',
  status: 'ok',
  lines: [
    line({ id: 'ads-flight-a', period: 'flight', cap: 70, actual: 0, pct: 0, alerts: 'campaign_cap' }),
    line({ id: 'aws-total', cap: 150, actual: 30.2, pct: 20.1 }),
    line({ id: 'bedrock-all', cap: 100, actual: 85, pct: 85, status: 'warn' }),
    line({ id: 'bedrock-brand-a', cap: null, actual: null, pct: null, status: 'untracked' }),
    line({ id: 'studio-a-month', cap: 30, actual: null, pct: null, status: 'not_read', not_read: 'no mount for this line' }),
    line({ id: 'api-quota', cap: 10000, unit: 'units', period: 'day', actual: 16, pct: 0.2 }),
    line({ id: 'over-line', actual: 120, pct: 120, status: 'at_cap' }),
  ],
  parse_errors: [],
  alerts: [],
  cost_reader: {
    configured: true,
    read_at: '2026-01-05T12:45:00Z',
    month: '2026-01',
    total: 30.2,
    bedrock: 4.12,
    forecast_total: 143.37,
    forecast_bedrock: 22.74,
    calls_today: 3,
    calls_month: 6,
    error: null,
  },
};

const render = (ledger: SpendLedger | null, extra: Partial<Parameters<typeof SpendLedgerPanel>[0]> = {}) =>
  renderToStaticMarkup(<SpendLedgerPanel ledger={ledger} {...extra} />);

describe('SpendLedgerPanel', () => {
  it('groups the lines by period, day first, and formats amounts by unit', () => {
    expect(groupLines(LEDGER.lines).map(([p]) => p)).toEqual(['day', 'month', 'flight']);
    expect(amount(30.2, 'usd')).toBe('$30.20');
    expect(amount(16, 'units')).toBe('16 units');
    expect(amount(null, 'usd')).toBe('—');
  });

  it('renders one tile per line with actual / cap, pct and the status tone', () => {
    const html = render(LEDGER);
    expect(html.match(/data-spend-line=/g)).toHaveLength(7);
    expect(html).toContain('id="spend-aws-total"');
    expect(html).toContain('$30.20');
    expect(html).toContain(' / $150.00');
    expect(html).toContain('20.1 %');
    expect(html).toMatch(/data-spend-line="bedrock-all" data-status="warn"/);
    expect(html).toMatch(/border:1px solid var\(--color-warning\)" data-spend-line="bedrock-all"/);
    expect(html).toMatch(/border:1px solid var\(--color-error\)" data-spend-line="over-line"/);
    expect(html).toContain('>at cap</span>');
  });

  it('shows untracked and not_read with their word and reason, never hidden', () => {
    const html = render(LEDGER);
    expect(html).toContain('>untracked</span>');
    expect(html).toContain('>not read</span>');
    expect(html).toContain('not read: no mount for this line');
    expect(html).toContain('no cap');
    expect(html).toContain('alerts: campaign cap');
  });

  it('puts the cost reader under the AWS lines, its error in amber, or says it is not configured', () => {
    const html = render(LEDGER);
    expect(html).toContain('AWS month to date $30.20 (Bedrock $4.12) · forecast $143.37');
    expect(html).toContain('6 calls this month');
    const err = render({ ...LEDGER, cost_reader: { ...LEDGER.cost_reader!, error: 'AccessDenied' } });
    expect(err).toMatch(/color:var\(--color-warning\)"> · error AccessDenied/);
    expect(render({ ...LEDGER, cost_reader: { configured: false } })).toContain('cost reader not configured');
  });

  it('puts parse errors on one line at the top', () => {
    const html = render({ ...LEDGER, parse_errors: ['line 9: bad cap "7o"'] });
    expect(html).toContain('data-parse-errors');
    expect(html.indexOf('data-parse-errors')).toBeLessThan(html.indexOf('data-spend-line'));
    expect(html).toContain('line 9: bad cap');
  });

  it('shows a studio pause alert in red with the paused properties and the flag folder', () => {
    const html = render({
      ...LEDGER,
      alerts: [
        { kind: 'spend_cap', line: 'aws-total', level: 80, pct: 81, lane: 'act', period: '2026-01', action: 'studio_paused', paused: ['prop-a', 'prop-b'], message: 'aws-total at 81 %', raised_at: '2026-01-05T12:45:00Z' },
        { kind: 'spend_cap', line: 'bedrock-all', level: 80, pct: 85, lane: 'fyi', period: '2026-01', message: 'bedrock-all past 80 %', raised_at: '2026-01-05T12:45:00Z' },
      ],
    });
    expect(html).toMatch(/style="color:var\(--color-error\)" data-spend-alert="aws-total" data-action="studio_paused"/);
    expect(html).toContain('Paused: prop-a, prop-b, until you delete the flags in <code>_data\\studio\\pause\\</code>.');
    expect(html).toContain('bedrock-all past 80 %');
  });

  it('says the ledger is the operator file and renders empty and no_ledger states', () => {
    expect(render(LEDGER)).toContain('The ledger is your file in hq');
    expect(render(LEDGER)).not.toContain('<a ');
    expect(render(null)).toContain('No spend ledger read yet.');
    expect(render({ ...LEDGER, status: 'no_ledger', lines: [], cost_reader: null })).toContain('No ledger: Hermes found no spend file to read.');
    expect(render({ ...LEDGER, lines: [] })).toContain('The ledger has no lines.');
  });
});
