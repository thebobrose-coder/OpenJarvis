import { describe, expect, it } from 'vitest';
import type { BreakingNewsAlert } from './api';
import { alertAge, alertKind, levelTone, selectBreaking } from './breaking-list';

// Invented alerts only: this repo is public.
const NOW = Date.parse('2026-10-09T20:00:00Z');
const MIN = 60_000;

function alert(minutesAgo: number, over: Partial<BreakingNewsAlert> = {}): BreakingNewsAlert {
  return {
    headline: `Alert from ${minutesAgo} min ago`,
    summary: '',
    url: 'https://example.com/a',
    alerted_at: new Date(NOW - minutesAgo * MIN).toISOString(),
    audio_available: false,
    audio_path: null,
    ...over,
  };
}

describe('selectBreaking', () => {
  it('orders three rows newest first', () => {
    const rows = selectBreaking(null, [alert(300), alert(5), alert(60)], NOW);
    expect(rows.map((r) => r.headline)).toEqual([
      'Alert from 5 min ago',
      'Alert from 60 min ago',
      'Alert from 300 min ago',
    ]);
  });

  it('keeps the newest row per event_id', () => {
    const rows = selectBreaking(
      null,
      [
        alert(90, { event_id: 'usgs:x', level: 'yellow' }),
        alert(10, { event_id: 'usgs:x', level: 'red' }),
        alert(30, { event_id: 'nhc:y' }),
      ],
      NOW,
    );
    expect(rows.map((r) => [r.event_id, r.level ?? null])).toEqual([
      ['usgs:x', 'red'],
      ['nhc:y', null],
    ]);
  });

  it('excludes rows older than 24 h', () => {
    const rows = selectBreaking(null, [alert(60), alert(24 * 60 + 1)], NOW);
    expect(rows).toHaveLength(1);
  });

  it('is empty when the last 24 h is empty, even with an old latest alert', () => {
    expect(selectBreaking(null, [], NOW)).toEqual([]);
    expect(selectBreaking(alert(30 * 60), [], NOW)).toEqual([]);
  });

  it('caps the list at three rows', () => {
    const rows = selectBreaking(null, [alert(1), alert(2), alert(3), alert(4)], NOW);
    expect(rows).toHaveLength(3);
  });

  it('merges the spoken alert with its /recent row instead of listing it twice', () => {
    const latest = alert(5, { audio_available: true, audio_path: '/x.mp3', stale: false });
    const recent = [alert(5, { kind: 'hazard', source: 'USGS', level: 'red' }), alert(40)];
    const rows = selectBreaking(latest, recent, NOW);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ kind: 'hazard', source: 'USGS', level: 'red', audio_available: true });
  });

  it('still shows the spoken alert when /recent has not answered', () => {
    expect(selectBreaking(alert(5), [], NOW)).toHaveLength(1);
  });
});

describe('alertKind', () => {
  it('defaults a missing kind to news, or trading by source', () => {
    expect(alertKind({ kind: 'hazard', source: 'USGS' })).toBe('hazard');
    expect(alertKind({ source: 'Example Wire' })).toBe('news');
    expect(alertKind({ source: 'trading' })).toBe('trading');
    expect(alertKind({})).toBe('news');
  });
});

describe('display', () => {
  it('maps levels to tones', () => {
    expect(levelTone('red')).toBe('error');
    expect(levelTone('Extreme')).toBe('error');
    expect(levelTone('orange')).toBe('warning');
    expect(levelTone('yellow')).toBe('neutral');
    expect(levelTone('warning')).toBe('neutral');
    expect(levelTone(null)).toBe('neutral');
  });

  it('labels ages', () => {
    const at = (m: number) => new Date(NOW - m * MIN).toISOString();
    expect(alertAge(at(0), NOW)).toBe('now');
    expect(alertAge(at(38), NOW)).toBe('38 min');
    expect(alertAge(at(59), NOW)).toBe('59 min');
    expect(alertAge(at(60), NOW)).toBe('1 h');
    expect(alertAge(at(23 * 60 + 50), NOW)).toBe('23 h');
  });
});
