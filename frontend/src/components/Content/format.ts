import type { Tone } from '../shared/ui';

/** The property switcher's "every property" value. */
export const ALL_PROPERTIES = '__all__';

export const matchesProperty = (selected: string, id?: string | null) => selected === ALL_PROPERTIES || id === selected;

/** "short" -> "Short", "feed:<id>" -> "Feed · <id>". */
export function laneLabel(lane: string): string {
  if (lane.startsWith('feed:')) return `Feed · ${lane.slice(5)}`;
  return lane.charAt(0).toUpperCase() + lane.slice(1);
}

export const humanize = (s?: string | null) => (s ? s.replace(/[_-]+/g, ' ') : '');

/** A refused edit leaves the proposal pending with a note saying why (v1.10). */
export const isRefusal = (note?: string | null) => !!note && note.trim().toLowerCase().startsWith('edit refused');

/** A seed Hermes refused is `rejected` with a note saying why (v1.16). */
export const isSeedRefusal = (note?: string | null) => !!note && note.trim().toLowerCase().startsWith('seed refused');

export const pct =(n?: number | null) => (n == null ? '—' : `${Math.round(n * 100)}%`);

export const PROPOSAL_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: 'pending', tone: 'neutral' },
  approved: { label: 'approved', tone: 'accent' },
  submitted: { label: 'submitted', tone: 'accent' },
  queued: { label: 'queued in Foundry', tone: 'success' },
  intake_rejected: { label: 'intake rejected', tone: 'error' },
  rejected: { label: 'rejected', tone: 'muted' },
  expired: { label: 'expired', tone: 'muted' },
};
