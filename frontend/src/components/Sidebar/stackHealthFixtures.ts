/** Invented stack-health fixtures for the dock, drawer and hook tests (this repo is public). */
import type { CheckRow, CloudEvent, StackHealth } from '../../lib/stack-api';

export function health(over: Partial<StackHealth> = {}): StackHealth {
  return {
    ran_at: '2026-10-19T17:10:00Z',
    duration_ms: 42_000,
    age_seconds: 1800,
    stale: false,
    counts: { OK: 30, WARN: 0, FAIL: 0, SKIP: 2 },
    failing: [],
    warning: [],
    skipped: 2,
    cloud_events: [],
    speech: [],
    ...over,
  };
}

export const row = (area: string, check: string, status: CheckRow['status'], evidence = 'detail'): CheckRow => ({
  area,
  check,
  status,
  evidence,
});

export function event(category: string, over: Partial<CloudEvent> = {}): CloudEvent {
  return {
    alias: 'sample-prod',
    service: 'EC2',
    type: 'AWS_EC2_OPERATIONAL_ISSUE',
    category,
    status: 'open',
    last_updated: '2026-10-19T16:00:00Z',
    age_seconds: 3600,
    description_first_line: 'Something is degraded.',
    description: 'Something is degraded.\nMore detail.',
    ...over,
  };
}
