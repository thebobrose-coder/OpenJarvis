import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DAILY_LATE_AFTER_S, FeedFreshness, FeedFreshnessView, formatAge, liveAgeSeconds } from './FeedFreshness';

const T0 = Date.parse('2026-10-09T07:30:00Z');
const MIN = 60_000;

describe('FeedFreshness', () => {
  it('counts on from the age it was handed', () => {
    const age = liveAgeSeconds(60, T0, T0 + 10 * MIN);
    expect(age).toBe(660);
    expect(formatAge(age)).toBe('11 min ago');
  });

  it('never counts backwards when the clock reads before the prop arrived', () => {
    expect(liveAgeSeconds(60, T0, T0 - MIN)).toBe(60);
  });

  it('shows the handed age on first render', () => {
    const html = renderToStaticMarkup(<FeedFreshness ageSeconds={300} />);
    expect(html).toContain('Updated 5 min ago');
  });

  it('turns amber once the age crosses staleAfterSeconds', () => {
    const before = liveAgeSeconds(DAILY_LATE_AFTER_S - 120, T0, T0 + MIN);
    const after = liveAgeSeconds(DAILY_LATE_AFTER_S - 120, T0, T0 + 3 * MIN);
    const view = (age: number) =>
      renderToStaticMarkup(<FeedFreshnessView ageSeconds={age} staleAfterSeconds={DAILY_LATE_AFTER_S} />);
    expect(view(before)).toContain('var(--color-text-tertiary)');
    expect(view(before)).not.toContain('a run may have been missed');
    expect(view(after)).toContain('var(--color-warning)');
    expect(view(after)).toContain('a run may have been missed');
  });

  it('renders nothing without an age', () => {
    expect(renderToStaticMarkup(<FeedFreshness ageSeconds={null} />)).toBe('');
  });
});
