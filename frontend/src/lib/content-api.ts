/**
 * Content page data: Hermes's content-strategist feeds, proxied by
 * /api/content (hq/contracts/openjarvis-hermes.md v1.0 §2, "Content loop").
 *
 * Hermes proposes seed topics per Foundry property and measures what was
 * posted; the operator decides here. Only approved proposals reach
 * Foundry's intake, and every item still passes Foundry's own compliance
 * scan and Telegram approval (G1).
 */
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

export interface SeedbankProperty {
  id: string;
  channels?: string[];
  signal_mode?: string;
  lanes: Lane[];
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
}

export interface ThesisPrompt {
  id: string;
  property_id: string;
  status: string;
  signal: string;
  why_it_matters?: string | null;
  links?: string[];
  created_at: string;
}

export interface ContentProposals extends FeedMeta {
  run_at: string;
  pending: Proposal[];
  recent_decided: Proposal[];
  thesis_prompts: ThesisPrompt[];
  counts_30d?: Partial<Record<string, number>>;
  cost?: { week_usd: number; month_usd: number; by_engine: Record<string, number> };
}

export type Origin = 'hermes' | 'operator' | 'feed';

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
  site?: { clicks?: number | null; impressions?: number | null } | null;
  utm?: { sessions?: number | null; ecommercePurchases?: number | null; [k: string]: unknown } | null;
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
}

export interface ContentHealth extends FeedMeta {
  run_at: string;
  alerts: HealthAlert[];
}

export interface ContentFeeds {
  content_seedbank: ContentSeedbank;
  content_proposals: ContentProposals;
  content_performance: ContentPerformance;
  content_health: ContentHealth;
}

export type ContentFeedName = keyof ContentFeeds;
export const CONTENT_FEEDS: ContentFeedName[] = [
  'content_seedbank',
  'content_proposals',
  'content_performance',
  'content_health',
];

/** The operator's edits on approval; only changed fields are sent. */
export interface ApprovalEdits {
  topic?: string;
  pillar_hint?: string;
  product_handle?: string;
  note?: string;
}

export const LIMITS = { topic: 600, note: 500, pillar_hint: 120, product_handle: 120 } as const;

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
