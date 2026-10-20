import { describe, expect, it } from 'vitest';
import {
  cloudKind,
  headline,
  nextRunAt,
  noticeOnly,
  shouldChime,
  stackLevel,
} from '../lib/stack-api';
import { event, health, row } from '../components/Sidebar/stackHealthFixtures';

describe('stackLevel', () => {
  it('is ok for a fresh, clean run and unavailable with no copy', () => {
    expect(stackLevel(health())).toBe('ok');
    expect(stackLevel(null)).toBe('unavailable');
  });

  it('is fail for any FAIL, warn for any WARN', () => {
    expect(stackLevel(health({ counts: { OK: 1, WARN: 1, FAIL: 1, SKIP: 0 }, failing: [row('web', 'a', 'FAIL')] }))).toBe('fail');
    expect(stackLevel(health({ counts: { OK: 1, WARN: 1, FAIL: 0, SKIP: 0 }, warning: [row('local', 'disk', 'WARN')] }))).toBe('warn');
  });

  it('is fail for an open cloud issue with every local check OK', () => {
    const h = health({ cloud_events: [event('issue')] });
    expect(stackLevel(h)).toBe('fail');
    expect(headline(h)).toBe('sample-prod · EC2');
    expect(noticeOnly(h)).toBe(false);
  });

  it('is warn for a cloud notice alone, and that keeps the green line', () => {
    const h = health({ cloud_events: [event('scheduledChange')] });
    expect(stackLevel(h)).toBe('warn');
    expect(noticeOnly(h)).toBe(true);
  });

  it('is stale past 7 h, by the server flag or the live age', () => {
    expect(stackLevel(health({ stale: true, age_seconds: 9 * 3600 }))).toBe('stale');
    expect(stackLevel(health(), 7 * 3600 + 60)).toBe('stale');
    expect(noticeOnly(health({ stale: true, cloud_events: [event('scheduledChange')] }))).toBe(false);
  });
});

describe('headline', () => {
  it('names the first FAIL, else the first WARN, else the cloud event', () => {
    const fail = health({ failing: [row('web', 'site-a', 'FAIL'), row('web', 'site-b', 'FAIL')], warning: [row('local', 'disk', 'WARN')] });
    expect(headline(fail)).toBe('web/site-a');
    expect(headline(health({ warning: [row('local', 'disk', 'WARN')] }))).toBe('local/disk');
    expect(headline(health({ cloud_events: [event('accountNotification', { service: 'S3' })] }))).toBe('sample-prod · S3');
  });
});

describe('shouldChime', () => {
  it('chimes when fail is entered, once per ran_at, never for amber', () => {
    expect(shouldChime('ok', 'fail', 'r1', null)).toBe(true);
    expect(shouldChime(null, 'fail', 'r1', null)).toBe(true);
    expect(shouldChime(null, 'fail', 'r1', 'r1')).toBe(false); // a re-mount
    expect(shouldChime('fail', 'fail', 'r2', 'r1')).toBe(false); // still red
    expect(shouldChime('ok', 'warn', 'r3', null)).toBe(false);
    expect(shouldChime('ok', 'stale', 'r3', null)).toBe(false);
  });
});

describe('nextRunAt', () => {
  it('is the next 00:10 / 06:10 / 12:10 / 18:10 Central slot', () => {
    // 2026-10-19 is CDT (UTC-5): 12:30 Central -> 18:10 Central = 23:10Z.
    expect(new Date(nextRunAt(Date.parse('2026-10-19T17:30:00Z'))).toISOString()).toBe('2026-10-19T23:10:00.000Z');
    // 23:00 Central -> 00:10 Central the next day = 05:10Z.
    expect(new Date(nextRunAt(Date.parse('2026-10-20T04:00:00Z'))).toISOString()).toBe('2026-10-20T05:10:00.000Z');
    // Exactly at a slot -> the following one.
    expect(new Date(nextRunAt(Date.parse('2026-10-19T11:10:00Z'))).toISOString()).toBe('2026-10-19T17:10:00.000Z');
  });
});

describe('cloudKind', () => {
  it('reads google from the GOOGLE_ types, aws otherwise', () => {
    expect(cloudKind({ type: 'GOOGLE_NOTICE' })).toBe('google');
    expect(cloudKind({ type: 'GOOGLE_SERVICE_HEALTH_INCIDENT' })).toBe('google');
    expect(cloudKind({ type: 'AWS_EC2_OPERATIONAL_ISSUE' })).toBe('aws');
  });
});
