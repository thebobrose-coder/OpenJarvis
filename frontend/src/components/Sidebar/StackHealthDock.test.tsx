import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { event, health, row } from './stackHealthFixtures';
import { ALL_CLEAR, NO_RUN, shouldChime, stackLevel, noticeOnly, type StackHealth, type StackLevel } from '../../lib/stack-api';
import { StackHealthDockView, type StackHealthDockViewProps } from './StackHealthDock';

// Invented fixtures only: this repo is public.
function view(h: StackHealth | null, over: Partial<StackHealthDockViewProps> = {}) {
  const age = h?.age_seconds ?? null;
  return renderToStaticMarkup(
    <StackHealthDockView
      health={h}
      level={stackLevel(h, age)}
      age={age}
      noticeOnly={noticeOnly(h, age)}
      missing={false}
      error={null}
      pulse={false}
      onOpen={() => {}}
      {...over}
    />,
  );
}

const WARN = health({ counts: { OK: 29, WARN: 1, FAIL: 0, SKIP: 2 }, warning: [row('local', 'disk', 'WARN', 'disk at 91 %')] });
const FAIL = health({
  counts: { OK: 28, WARN: 1, FAIL: 1, SKIP: 2 },
  failing: [row('web', 'site-a', 'FAIL', 'HTTP 503 from the sample site')],
  warning: [row('local', 'disk', 'WARN')],
});

describe('StackHealthDockView', () => {
  it('green: exactly the all-clear line with the run time and age, no strip', () => {
    const html = view(health());
    expect(html).toContain(`>${ALL_CLEAR}<`);
    expect(html).toContain('30 min ago');
    expect(html).toContain('var(--color-success)');
    expect(html).toContain('data-stack-level="ok"');
    expect(html).not.toContain('aria-live');
  });

  it('warn: an amber strip with the counts and headline', () => {
    const html = view(WARN);
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('data-stack-level="warn"');
    expect(html).toContain('0 FAIL · 1 WARN — local/disk');
    expect(html).toContain('Stack health is 30 min old');
    expect(html).toContain('var(--color-warning)');
    expect(html).not.toContain(ALL_CLEAR);
  });

  it('fail: a red strip headed by the first failure', () => {
    const html = view(FAIL);
    expect(html).toContain('data-stack-level="fail"');
    expect(html).toContain('1 FAIL · 1 WARN — web/site-a');
    expect(html).toContain('var(--color-error)');
    expect(view(FAIL, { pulse: true })).toContain('animate-pulse');
  });

  it('a cloud issue alone turns the strip red; a notice keeps the green line', () => {
    const issue = view(health({ cloud_events: [event('issue')] }));
    expect(issue).toContain('data-stack-level="fail"');
    expect(issue).toContain('1 cloud issue — sample-prod · EC2');
    const notice = view(health({ cloud_events: [event('scheduledChange')] }));
    expect(notice).toContain(ALL_CLEAR);
    expect(notice).toContain('1 cloud notice');
  });

  it('stale: an amber strip saying how old the run is', () => {
    const html = view(health({ stale: true, age_seconds: 9 * 3600 + 120 }));
    expect(html).toContain('data-stack-level="stale"');
    expect(html).toContain('Stack health is 9 h old');
  });

  it('no run yet, and unavailable with the detail in the title', () => {
    expect(view(null, { missing: true })).toContain(`>${NO_RUN}<`);
    const html = view(null, { error: 'Failed: 500' });
    expect(html).toContain('Stack health unavailable');
    expect(html).toContain('title="Failed: 500"');
  });

  it('chimes once per ran_at as the polls go by', () => {
    // A sequence of polls, as the hook sees them: the chime fires on entering
    // fail, not again while red, not after a re-mount, and again for a new red run.
    const polls: [StackHealth, string][] = [
      [health({ ran_at: 'r1' }), 'ok'],
      [{ ...FAIL, ran_at: 'r2' }, 'fail'],
      [{ ...FAIL, ran_at: 'r2' }, 'fail'],
      [{ ...FAIL, ran_at: 'r3' }, 'fail'],
      [health({ ran_at: 'r4' }), 'ok'],
      [{ ...FAIL, ran_at: 'r5' }, 'fail'],
    ];
    let previous: StackLevel | null = null;
    let chimed: string | null = null;
    const fired: string[] = [];
    for (const [h, expected] of polls) {
      const level = stackLevel(h);
      expect(level).toBe(expected);
      if (shouldChime(previous, level, h.ran_at, chimed)) {
        chimed = h.ran_at;
        fired.push(h.ran_at!);
      }
      previous = level;
    }
    expect(fired).toEqual(['r2', 'r5']);
    // Re-mount on r5: previous is null again, but r5 already chimed.
    expect(shouldChime(null, 'fail', 'r5', chimed)).toBe(false);
  });
});
