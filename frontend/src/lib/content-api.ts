/**
 * Content page data: Hermes's content-strategist feeds, proxied by
 * /api/content (hq/contracts/openjarvis-hermes.md v1.0 §2, "Content loop";
 * v1.9 measurement by page and `content_winners`, v1.10 target queries,
 * v1.14 the video flag).
 *
 * Hermes proposes seed topics per Foundry property and measures what was
 * posted; the operator decides here. Only approved proposals reach
 * Foundry's intake, and every item still passes Foundry's own compliance
 * scan and Telegram approval (G1).
 */
import type { SpeechBlock } from './voice-api';
import { apiFetch } from './api';

export interface FeedMeta {
  generated_at: string;
  age_seconds: number;
  /** True when the bridge is down and this is the last good copy. */
  stale: boolean;
}

export type LaneStatus = 'ok' | 'low' | 'empty' | 'unknown' | 'feed' | 'operator-only' | 'not-seedable';

export interface Lane {
  /** "short", "long" or "feed:<id>". */
  lane: string;
  content_type: string;
  cadence_per_week: number | null;
  seedable: boolean;
  operator_only: boolean;
  feed_lane: boolean;
  /** Null until Foundry's snapshot says. */
  queued: number | null;
  in_flight: number | null;
  pending: number | null;
  runway_days: number | null;
  target?: number | null;
  needed?: number | null;
  status: LaneStatus | string;
  last_run_at?: string | null;
  last_run_result?: string | null;
}

/** A queued thesis, in lane order (v1.8). */
export interface ThesisQueueItem {
  signal_id: string | null;
  lane_position: number | null;
  /** Falls back to `summary` in the feed when Foundry has no title. */
  title: string | null;
  summary: string | null;
  template_id: string | null;
  pillar_hint: string | null;
  product_handle: string | null;
  source: string | null;
  created_at: string | null;
  /** ceil(lane_position / cadence): an estimate, never a date. */
  est_weeks_out: number | null;
}

/** A thesis post in the snapshot's 90-day window, newest first. */
export interface ThesisPost {
  post_id: string | null;
  /** Null for posts before titles were recorded: show `excerpt`. */
  title: string | null;
  excerpt: string | null;
  pillar: string | null;
  product_handle: string | null;
  distributed_at: string | null;
  source: string | null;
}

export interface ThesisFlag {
  /** "runway_low" (warn) or "possible_repeat" (info); others may follow. */
  kind: string;
  severity: 'info' | 'warn' | string;
  message: string | null;
  signal_id?: string | null;
  post_id?: string | null;
}

/**
 * The operator-only thesis lane, read-only (contract v1.8). Present and null
 * on every property but the one with an operator-only thesis lane.
 */
export interface ThesisLane {
  lane: string | null;
  cadence_per_week: number | null;
  queued: number | null;
  in_flight: number | null;
  runway_days: number | null;
  /** The property's G1 approvals waiting, across all lanes. */
  approvals_pending: number | null;
  next_up: ThesisQueueItem | null;
  queue: ThesisQueueItem[] | null;
  posts: ThesisPost[] | null;
  flags: ThesisFlag[] | null;
}

/** v1.14: where a clip may render, echoed from the bundle; "g1" clips stop at G1. */
export interface PropertyMotion {
  lanes: string[];
  release: 'preview' | 'g1' | 'instagram' | string;
}

/** v1.14: "always" or "never"; null is the lane default. */
export type Motion = 'always' | 'never' | null;

export interface SeedbankProperty {
  id: string;
  channels?: string[];
  signal_mode?: string;
  lanes: Lane[];
  /** v1.8; absent in an older seedbank. */
  thesis_lane?: ThesisLane | null;
  /** v1.16: the bundle's pillars; the composer offers these and nothing else. */
  pillars?: { id: string; name: string }[];
  /** v1.16.1: the property's store; null when it has none (verify then answers 502). */
  storefront?: { store: string; host: string } | null;
  /** v1.14: null (or absent) means no Video control on this property. */
  motion?: PropertyMotion | null;
  /** Absent means active. */
  active?: boolean;
  /** v1.17: the studio channel's episode classes; absent where there's no episode lane. */
  episode_classes?: EpisodeClass[];
}

export interface EpisodeClass {
  id: string;
  name: string;
  /** Only the operator seeds it; Hermes never proposes it. */
  operator_only: boolean;
}

export interface ContentSeedbank extends FeedMeta {
  run_at: string;
  target_runway_days: number;
  bundle?: { commit?: string; age_days?: number | null; stale?: boolean };
  snapshot?: { present: boolean; generated_at?: string | null; age_hours?: number | null };
  properties: SeedbankProperty[];
}

export type ProposalStatus =
  | 'pending'
  | 'approved'
  | 'submitted'
  | 'queued'
  | 'intake_rejected'
  | 'rejected'
  | 'expired';

export interface EvidenceCandidate {
  kind?: string;
  text?: string;
  link?: string | null;
  fit?: number | null;
}

export interface Proposal {
  id: string;
  property_id: string;
  lane: string;
  content_type?: string;
  status: ProposalStatus | string;
  topic: string;
  rationale?: string | null;
  signal_type?: string | null;
  pillar_hint?: string | null;
  product_handle?: string | null;
  source_links?: string[];
  evidence?: { candidates?: EvidenceCandidate[] };
  created_at: string;
  decided_at?: string | null;
  note?: string | null;
  approval?: { by?: string; at?: string; via?: string; edited?: boolean } | null;
  result?: { reasons?: string[]; [k: string]: unknown } | null;
  /** v1.10, set by code: 1-3 Search Console queries (long-form only), or null. */
  target_queries?: string[] | null;
  /** v1.10: 1-3; null means the default 2. */
  priority?: number | null;
  /** v1.16: "operator" for the operator's own seeds. */
  proposed_by?: 'content-strategist' | 'operator' | string;
  /** v1.16: the thesis prompt a seed came from. */
  source_prompt_id?: string | null;
  // v1.14, the video flag.
  motion?: Motion;
  /** The beat: what happens in the frame, at most 240. */
  motion_brief?: string | null;
  /** Only ever the operator's own asset key. */
  video_key?: string | null;
  /** v1.17, the episode lane; null off it. */
  episode_class?: string | null;
  sources?: string[] | null;
  target_minutes?: number | null;
  /** The episode tag (foundry-seed-proposal.md v2.8): a long-form proposal's companion episode; null or absent without one. */
  episode?: EpisodeTag | null;
}

/** A companion episode on a thesis or Expedition Debrief proposal (v2.8). */
export interface EpisodeTag {
  class: string;
  /** 4-6; absent or null for the default. */
  target_minutes?: number | null;
}

export interface ThesisPrompt {
  id: string;
  property_id: string;
  status: string;
  signal: string;
  why_it_matters?: string | null;
  links?: string[];
  created_at: string;
  /** v1.16; in practice null, since a seeded prompt leaves the list. */
  seeded_proposal_id?: string | null;
}

export interface ContentProposals extends FeedMeta {
  /** Spoken script(s) for the voice worker (contract v1.1). */
  speech?: SpeechBlock[];

  run_at: string;
  pending: Proposal[];
  recent_decided: Proposal[];
  thesis_prompts: ThesisPrompt[];
  counts_30d?: Partial<Record<string, number>>;
  cost?: { week_usd: number; month_usd: number; by_engine: Record<string, number> };
}

export type Origin = 'hermes' | 'operator' | 'feed';

/** Search Console numbers for a page (v1.9 adds `position`). */
export interface SiteStats {
  clicks?: number | null;
  impressions?: number | null;
  position?: number | null;
}

/** GA4 landing-page numbers on the content host (v1.9). */
export interface LandingStats {
  sessions?: number | null;
  engagedSessions?: number | null;
  ecommercePurchases?: number | null;
  purchaseRevenue?: number | null;
  /** False until the operator's one-time cross-domain test: show purchases as unverified. */
  purchases_verified?: boolean | null;
}

export interface TargetQueryReading {
  query: string;
  impressions?: number | null;
  position?: number | null;
}

/** "Did it rank?" (v1.10): readings at the day-7 and day-28 checkpoints, keyed by day. */
export type TargetsHit = Record<string, { queries?: TargetQueryReading[]; age_days?: number | null }>;

export interface Post {
  post_id: string;
  proposal_id?: string | null;
  origin: Origin | string;
  content_type?: string;
  pillar?: string | null;
  product_handle?: string | null;
  distributed_at?: string | null;
  excerpt?: string | null;
  g1?: string | null;
  social?: Partial<Record<'likes' | 'comments' | 'shares' | 'saves' | 'reach' | 'impressions' | 'views', number>> | null;
  engagement?: number | null;
  site?: SiteStats | null;
  /** Always null since v1.9 (posts are measured by page). */
  utm?: { sessions?: number | null; ecommercePurchases?: number | null; [k: string]: unknown } | null;
  // v1.9: measured by page.
  site_path?: string | null;
  site_path_kind?: 'permalink' | 'feed' | string | null;
  url?: string | null;
  landing?: LandingStats | null;
  /** Only for a property whose list sign-ups are joined; null otherwise. */
  signup_sessions?: number | null;
  /** The winner score; null when there is no search, landing or sign-up data. */
  score?: number | null;
  // v1.10.
  target_queries?: string[] | null;
  priority?: number | null;
  targets_hit?: TargetsHit | null;
  /** v1.14: set only for a published Reel. */
  video_key?: string | null;
  /** v1.14: why a clip didn't post, verbatim (old texts run to ~300 characters). */
  motion_skipped_reason?: string | null;
}

/** A short-form lane's feed page, reported once for the lane (v1.9). */
export interface LanePage {
  site_path: string;
  content_type?: string | null;
  posts?: number | null;
  engagement?: number | null;
  site?: SiteStats | null;
  landing?: LandingStats | null;
  signup_sessions?: number | null;
  score?: number | null;
}

export interface Measurement {
  /** "early" or "traffic": how scores are weighted. */
  regime?: string | null;
  gsc_clicks_28d?: number | null;
  /** {organic, paid} since v1.21; a plain number in older rows. */
  purchases_28d?: number | { organic?: number | null; paid?: number | null } | null;
  purchases_verified?: boolean | null;
  sources?: { gsc?: boolean; ga4?: boolean } | null;
  /** Null for a property without a sign-up join. */
  signup_sessions_28d?: number | null;
  posts_with_path?: number | null;
  with_gsc?: number | null;
  with_landing?: number | null;
  lane_pages_with_gsc?: number | null;
  lane_pages_with_landing?: number | null;
  days_since_first_path?: number | null;
}

export interface RollupRow {
  posts: number;
  avg_engagement: number | null;
  sessions: number | null;
  purchases: number | null;
  site_clicks: number | null;
  [key: string]: string | number | null;
}

export type RollupKey = 'pillar' | 'origin' | 'content_type' | 'product_handle';

export interface PerformanceProperty {
  id: string;
  posts: Post[];
  g1?: { counts?: Record<string, number>; approval_rate?: number | null };
  rollups?: Partial<Record<RollupKey, RollupRow[]>>;
  /** v1.9; absent in an older feed. */
  lane_pages?: LanePage[] | null;
  measurement?: Measurement | null;
}

export interface ContentPerformance extends FeedMeta {
  run_at: string;
  snapshot_generated_at?: string | null;
  properties: PerformanceProperty[];
  errors?: unknown;
}

export interface HealthAlert {
  property?: string | null;
  kind: string;
  severity: 'info' | 'warn' | string;
  message: string;
  lane?: string | null;
  proposal_id?: string | null;
  /** measurement_tag_mismatch (v1.9): each checked page's status. */
  pages?: Record<string, string> | null;
}

export interface ContentHealth extends FeedMeta {
  run_at: string;
  alerts: HealthAlert[];
}

/** A winners/laggards entry: a long-form post, briefly. */
export interface WinnerPost {
  post_id: string;
  site_path?: string | null;
  url?: string | null;
  content_type?: string | null;
  pillar?: string | null;
  product_handle?: string | null;
  distributed_at?: string | null;
  excerpt?: string | null;
  score?: number | null;
  site?: SiteStats | null;
  landing?: LandingStats | null;
  engagement?: number | null;
  target_queries?: string[] | null;
  targets_hit?: TargetsHit | null;
  video_key?: string | null;
}

export interface PageQuery {
  query: string;
  clicks?: number | null;
  impressions?: number | null;
  position?: number | null;
}

/** Target-query hit rate at each post's latest checkpoint (v1.10). */
export interface TargetsRollup {
  posts: number;
  queries: number;
  /** Queries with any impression. */
  hit: number;
  /** Queries at position 20 or better. */
  top20: number;
  hit_rate: number | null;
  [key: string]: string | number | null;
}

export interface WinnersProperty {
  id: string;
  top: WinnerPost[];
  bottom: WinnerPost[];
  long_form?: number | null;
  unmeasured?: number | null;
  regime?: string | null;
  lane_pages?: LanePage[] | null;
  /** Top Search Console queries per content page (28 days). */
  page_queries?: Record<string, PageQuery[]> | null;
  targets?: { all?: TargetsRollup | null; by_pillar?: TargetsRollup[] | null } | null;
  /** v1.14: Reels ranked among themselves; null before the first Reel. */
  video?: VideoWinners | null;
}

/** Reels have no page score yet, so `top` and `bottom` stay empty for now. */
export interface VideoWinners {
  posts: number;
  unmeasured?: number | null;
  top: WinnerPost[];
  bottom: WinnerPost[];
  by_pillar: RollupRow[];
}

/** Weekly, Sundays (v1.9). */
export interface ContentWinners extends FeedMeta {
  run_at: string;
  performance_run_at?: string | null;
  window_days?: number | null;
  properties: WinnersProperty[];
  errors?: unknown;
}

export interface ContentFeeds {
  content_seedbank: ContentSeedbank;
  content_proposals: ContentProposals;
  content_performance: ContentPerformance;
  content_health: ContentHealth;
  content_winners: ContentWinners;
}

export type ContentFeedName = keyof ContentFeeds;
export const CONTENT_FEEDS: ContentFeedName[] = [
  'content_seedbank',
  'content_proposals',
  'content_performance',
  'content_health',
  'content_winners',
];

/** The operator's edits on approval; only changed fields are sent. */
export interface ApprovalEdits {
  topic?: string;
  pillar_hint?: string;
  product_handle?: string;
  note?: string;
  /** v1.10: up to 3; `[]` removes them. Hermes validates them with Foundry's intake rules. */
  target_queries?: string[];
  /** v1.10: 1-3, or null for the default. */
  priority?: number | null;
  /** v1.14: null clears to the lane default. */
  motion?: Motion;
  /** v1.14: "" removes it (null is a 400). */
  motion_brief?: string;
  /** v1.14, operator-only: "" removes it (null is a 400). */
  video_asset_key?: string;
  /** v1.17.3, the episode lane only: never the operator-only class on a Hermes proposal. */
  episode_class?: string;
  /** v1.17.3, the episode lane only: 1-10 https links. */
  sources?: string[];
  /** v1.17.3 (range v2.7.1): 4-6, or null for the intake's default. */
  target_minutes?: number | null;
  /** v2.8, long-form only: the companion episode tag; null removes it. */
  episode?: EpisodeTag | null;
}

export const LIMITS = {
  topic: 600,
  note: 500,
  pillar_hint: 120,
  product_handle: 120,
  target_queries: 3,
  target_query: 80,
  motion_brief: 240,
  video_asset_key: 512,
} as const;

async function failure(res: Response, what: string): Promise<Error> {
  const detail = await res.json().then((b) => b?.detail ?? b?.error).catch(() => null);
  return new Error(detail ? String(detail) : `${what} failed: ${res.status}`);
}

function jsonInit(body: object | undefined): RequestInit {
  return body && Object.keys(body).length
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : { method: 'POST' };
}

/** A feed's document, or null when Hermes hasn't produced it yet (404). */
export async function fetchContentFeed<F extends ContentFeedName>(feed: F): Promise<ContentFeeds[F] | null> {
  const res = await apiFetch(`/api/content/${feed}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(res.status === 503 ? 'Hermes is unreachable' : `Failed: ${res.status}`);
  return res.json();
}

export async function approveProposal(id: string, edits: ApprovalEdits = {}): Promise<void> {
  const res = await apiFetch(`/api/content/proposals/${id}/approve`, jsonInit(edits));
  if (!res.ok) throw await failure(res, 'Approve');
}

export async function rejectProposal(id: string, note = ''): Promise<void> {
  const trimmed = note.trim().slice(0, LIMITS.note);
  const res = await apiFetch(`/api/content/proposals/${id}/reject`, jsonInit(trimmed ? { note: trimmed } : undefined));
  if (!res.ok) throw await failure(res, 'Reject');
}

export type PromptAction = 'used' | 'dismissed';

export async function markPrompt(id: string, action: PromptAction): Promise<void> {
  const res = await apiFetch(`/api/content/prompts/${id}/${action}`, { method: 'POST' });
  if (!res.ok) throw await failure(res, 'Prompt update');
}

export async function researchMore(): Promise<void> {
  const res = await apiFetch('/api/content/ideation/refresh', { method: 'POST' });
  if (!res.ok) throw await failure(res, 'Research');
}

/**
 * The operator's own seed (v1.16): exactly the bridge's twelve keys, nothing
 * else (it answers 400 to any other).
 */
export interface SeedBody {
  property_id: string;
  /** The lane's bundle value: `short`, `thesis`, `expeditionDebrief`, ... */
  content_type: string;
  /** 1-6000 characters; for long-form the title is line 1. */
  text: string;
  pillar_hint?: string;
  product_handle?: string;
  url?: string;
  target_queries?: string[];
  priority?: number | null;
  source_prompt_id?: string;
  /** v1.14; left out for the lane default. */
  motion?: 'always' | 'never';
  motion_brief?: string;
  video_asset_key?: string;
  /** v1.17: required on the `episode` lane, refused on any other. */
  episode_class?: string;
  sources?: string[];
  target_minutes?: number;
}

/** v2.7.1: an episode runs 4-6 minutes (default 5); the v2.5 range 4-12 is closed. */
export const EPISODE_LIMITS = { sources: 10, minMinutes: 4, maxMinutes: 6, defaultMinutes: 5 } as const;

export const SEED_LIMITS = { text: 6000, url: 500, title: 120 } as const;
/** Store handles: lowercase letters, digits and hyphens, at most 120. */
export const HANDLE_RE = /^[a-z0-9][a-z0-9-]{0,119}$/;

/** Hermes mints the proposal id; its verdict arrives in `content_proposals`. */
export async function sendSeed(body: SeedBody): Promise<string> {
  const res = await apiFetch('/api/content/seeds', jsonInit(body));
  if (!res.ok) throw await failure(res, 'Queue');
  const out = await res.json();
  return String(out.proposal_id ?? '');
}

export type VerifyResult =
  | { state: 'found'; title?: string | null; source?: string }
  | { state: 'not_found'; source?: string }
  /** The storefront didn't answer, or none is known: the intake checks again. */
  | { state: 'unchecked'; reason: string };

export async function verifyProduct(property: string, handle: string): Promise<VerifyResult> {
  const q = new URLSearchParams({ property, handle });
  let res: Response;
  try {
    res = await apiFetch(`/api/content/verify-product?${q}`);
  } catch {
    return { state: 'unchecked', reason: 'Hermes is unreachable' };
  }
  const body = await res.json().catch(() => null);
  if (res.ok && body && typeof body.found === 'boolean') {
    return body.found ? { state: 'found', title: body.title, source: body.source } : { state: 'not_found', source: body.source };
  }
  return { state: 'unchecked', reason: String(body?.error ?? body?.detail ?? `status ${res.status}`) };
}

/** Start Foundry's intake now. `availableAt` is the epoch ms it may run
 * again; `started` is false when it ran under 2 minutes ago (429). */
export async function runIntake(): Promise<{ started: boolean; availableAt: number }> {
  const res = await apiFetch('/api/content/intake/run', { method: 'POST' });
  if (res.status === 429) {
    const body = await res.json().catch(() => null);
    const wait = Number(body?.retry_after) || INTAKE_COOLDOWN_MS / 1000;
    return { started: false, availableAt: Date.now() + wait * 1000 };
  }
  if (!res.ok) throw await failure(res, 'Intake run');
  return { started: true, availableAt: Date.now() + INTAKE_COOLDOWN_MS };
}

export const INTAKE_COOLDOWN_MS = 2 * 60 * 1000;
