import { describe, expect, it } from 'vitest';
import type { BreakingNewsAlert } from './api';
import type { AlertKind } from './api';
import { alertAge, alertKind, isCloudNotice, isQuiet, levelTone, selectBreaking } from './breaking-list';

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

describe('severity gate (hq 0017 A3)', () => {
  it('marks rows below 9 quiet; missing or non-numeric severity is not quiet', () => {
    expect(isQuiet({ severity: 6 })).toBe(true);
    expect(isQuiet({ severity: '7' })).toBe(true);
    expect(isQuiet({ severity: 9 })).toBe(false);
    expect(isQuiet({ severity: 10 })).toBe(false);
    expect(isQuiet({ severity: null })).toBe(false);
    expect(isQuiet({})).toBe(false);
    expect(isQuiet({ severity: 'high' })).toBe(false);
  });

  it('accepts the aws and google kinds', () => {
    const kinds: AlertKind[] = ['aws', 'google'];
    expect(kinds.map((kind) => alertKind({ kind }))).toEqual(['aws', 'google']);
  });
});

describe('cloud notices leave the list (hq 0017 A3.1)', () => {
  it('a quiet aws or google row is a cloud notice; a 9+ one or another kind is not', () => {
    expect(isCloudNotice({ kind: 'google', severity: 6 })).toBe(true);
    expect(isCloudNotice({ kind: 'aws', severity: 7 })).toBe(true);
    expect(isCloudNotice({ kind: 'aws', severity: 9 })).toBe(false);
    expect(isCloudNotice({ kind: 'google', severity: null })).toBe(false);
    expect(isCloudNotice({ kind: 'official', severity: 7 })).toBe(false);
  });

  it('drops cloud notices before the three-row cap', () => {
    const rows = selectBreaking(
      null,
      [
        alert(1, { kind: 'google', severity: 6, headline: 'notice 1' }),
        alert(2, { kind: 'aws', severity: 6, headline: 'notice 2' }),
        alert(3, { kind: 'official', severity: 7, headline: 'release' }),
        alert(4, { kind: 'aws', severity: 9, headline: 'outage' }),
        alert(5, { kind: 'hazard', severity: 9, headline: 'quake' }),
      ],
      NOW,
    );
    expect(rows.map((r) => r.headline)).toEqual(['release', 'outage', 'quake']);
  });
});
