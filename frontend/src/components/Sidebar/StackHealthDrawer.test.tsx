import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { event, health, row } from './stackHealthFixtures';
import { runAndWait, type StackHealth } from '../../lib/stack-api';
import { StackHealthDrawer, type StackHealthDrawerProps } from './StackHealthDrawer';

// Invented fixtures only: this repo is public.
const NOW = Date.parse('2026-10-19T17:30:00Z');

function view(h: StackHealth, over: Partial<StackHealthDrawerProps> = {}) {
  return renderToStaticMarkup(
    <StackHealthDrawer health={h} now={NOW} run={{ state: 'idle', detail: null }} onRun={() => {}} onClose={() => {}} {...over} />,
  );
}

describe('StackHealthDrawer', () => {
  it('renders every FAIL then WARN row with the full evidence, untruncated', () => {
    const long = 'Long evidence line '.repeat(40).trim();
    const html = view(
      health({
        counts: { OK: 28, WARN: 1, FAIL: 1, SKIP: 2 },
        failing: [row('web', 'site-a', 'FAIL', long)],
        warning: [row('local', 'disk', 'WARN', 'disk at 91 %')],
      }),
    );
    expect(html).toContain(long);
    expect(html).not.toContain('truncate');
    expect(html.indexOf('web/site-a')).toBeLessThan(html.indexOf('local/disk'));
    expect(html).toContain('1 FAIL');
    expect(html).toContain('2 checks skipped');
    expect(html).toContain('aria-label="Copy"');
  });

  it('shows cloud events with full descriptions, capped at 10 with +N more', () => {
    const events = Array.from({ length: 13 }, (_, i) => event(i === 0 ? 'issue' : 'scheduledChange', { service: `svc-${i}` }));
    const html = view(health({ cloud_events: events }));
    expect(html.match(/data-cloud-event/g)).toHaveLength(10);
    expect(html).toContain('+3 more');
    expect(html).toContain('More detail.');
    expect(html).toContain('sample-prod · svc-0 · AWS_EC2_OPERATIONAL_ISSUE · open · 60 min ago');
    expect(html).not.toContain('svc-10');
  });

  it('titles with the run time and footers with duration and next run', () => {
    const html = view(health());
    expect(html).toMatch(/Stack health · \d\d:\d\d/);
    expect(html).toMatch(/Last run \d\d:\d\d · 42 s · next \d\d:\d\d/);
    expect(html).toContain('Run now');
  });

  it('disables Run now while a run is being polled and shows a timeout note', () => {
    const running = view(health(), { run: { state: 'running', detail: null } });
    expect(running).toContain('Running…');
    expect(running).toMatch(/<button[^>]*disabled=""[^>]*>.*Running…/s);
    expect(view(health(), { run: { state: 'timeout', detail: 'No new run after 2 minutes' } })).toContain(
      'No new run after 2 minutes',
    );
  });

  it('offers Speak when the summary carries a speech block', () => {
    const block = {
      id: '0123456789abcdef',
      title: 'Stack health',
      text: 'Stack health at 12:10: 30 OK, 0 warnings, 0 failures.',
      mood: 'neutral',
      priority: 'info',
      lane: 'fast',
      created_at: '2026-10-19T17:10:00Z',
    };
    expect(view(health({ speech: [block] }))).toContain('Listen: Stack health');
    expect(view(health({ speech: [] }))).not.toContain('Listen:');
  });
});

describe('runAndWait (Run now)', () => {
  it('starts the task, then polls every 5 s until ran_at changes', async () => {
    const calls: string[] = [];
    const answers = [health({ ran_at: 'old' }), health({ ran_at: 'old' }), health({ ran_at: 'new' })];
    const slept: number[] = [];
    const fresh = await runAndWait('old', {
      run: async () => void calls.push('run'),
      fetch: async () => answers.shift()!,
      sleep: async (ms) => void slept.push(ms),
    });
    expect(calls).toEqual(['run']);
    expect(fresh?.ran_at).toBe('new');
    expect(slept).toEqual([5000, 5000, 5000]);
  });

  it('gives up after 2 minutes and survives a failed poll', async () => {
    let polls = 0;
    const fresh = await runAndWait('old', {
      run: async () => {},
      fetch: async () => {
        polls += 1;
        if (polls === 1) throw new Error('mid-write');
        return health({ ran_at: 'old' });
      },
      sleep: async () => {},
    });
    expect(fresh).toBeNull();
    expect(polls).toBe(24);
  });

  it('passes a failed start through', async () => {
    await expect(
      runAndWait('old', { run: async () => Promise.reject(new Error('Stack-health task not configured')), sleep: async () => {} }),
    ).rejects.toThrow('not configured');
  });
});
