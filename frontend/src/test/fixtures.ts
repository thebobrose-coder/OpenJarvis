/** Shared test fixtures. Invented values only: this repo is public. */
import type { SendConfig } from '../lib/bizdev-api';
import type { Lane } from '../lib/content-api';

/** Send configured, with a neutral sender. */
export const SEND_CONFIG: SendConfig = {
  enabled: true,
  sender_name: 'Sample Sender',
  sender_address: 'sender@example.org',
  reply_to: 'sender@example.org',
  missing: [],
};

/** A seedbank lane: a healthy short lane unless `over` says otherwise. */
export function lane(over: Partial<Lane> = {}): Lane {
  return {
    lane: 'short',
    content_type: 'short',
    cadence_per_week: 7,
    seedable: true,
    operator_only: false,
    feed_lane: false,
    queued: 3,
    in_flight: 0,
    pending: 0,
    runway_days: 3,
    status: 'ok',
    ...over,
  };
}
