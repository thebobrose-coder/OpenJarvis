/**
 * Business Development page data: Hermes's bd-researcher feeds, proxied by
 * /api/bizdev (hq/contracts/openjarvis-hermes.md v0.9 §2).
 *
 * Prospects carry official-directory work contacts (personal data). The page
 * displays them and builds mailto: links from them; it never stores them or
 * sends them anywhere else.
 */
import { apiFetch } from './api';

export interface FeedMeta {
  generated_at: string;
  age_seconds: number;
  /** True when the bridge is down and this is the last good copy. */
  stale: boolean;
}

export const BOARD_STAGES = ['new', 'drafted', 'sent', 'replied', 'meeting', 'won', 'lost'] as const;
export type BoardStage = (typeof BOARD_STAGES)[number];

/** Final: the prospect leaves the board and is never contacted again. */
export const SUPPRESSION_STAGES = ['not_interested', 'do_not_contact', 'bounced'] as const;
export type SuppressionStage = (typeof SUPPRESSION_STAGES)[number];

/** Every stage the stage route accepts (not "new"). */
export type StageAction = Exclude<BoardStage, 'new'> | SuppressionStage;

export interface Contact {
  name: string;
  title?: string;
  email?: string | null;
  phone?: string | null;
}

export interface Draft {
  to_role?: string;
  subject: string;
  body: string;
}

export interface Prospect {
  id: number;
  line?: string;
  name: string;
  association?: string;
  division?: string;
  conference?: string;
  state?: string;
  website?: string;
  athletics_url?: string;
  directory_url?: string | null;
  signals?: {
    platform?: string | null;
    latest_date_on_home?: string | null;
    sports_information_titles_in_directory?: number | string[] | null;
    directory_found?: boolean;
  };
  signal_notes?: string[];
  fit_score?: number;
  fit_rationale?: string;
  triage?: { engine?: string; score?: number; reason?: string };
  contacts?: Contact[];
  draft?: Draft | null;
  draft_problems?: string[];
  sources?: string[];
  /** v0.9.1: "NCAA D1", "NAIA", "NJCAA"...; null when unknown. */
  affiliation?: string | null;
  /** v0.9.1: how good a target this is. Hermes sorts each stage by it; absent on older cards. */
  rank?: Rank | null;
  /** The latest re-check (v0.9 addendum); absent until the first one. When
   * `kept_previous`, the new result was worse and the card still shows the
   * earlier research; these fields describe the discarded new result. */
  recheck?: RecheckResult;
}

export interface Rank {
  /** base × division_factor × platform_factor. */
  score: number;
  /** The Sonnet fit, else the triage score. */
  base: number;
  division_factor: number;
  platform_factor: number;
  affiliation?: string | null;
  platform?: string | null;
  excluded?: boolean;
}

/** 4 -> "4.0", 0.25 -> "0.25": factors and scores read as decimals. */
export function rankNumber(n: number): string {
  return Number.isInteger(n) ? n.toFixed(1) : String(n);
}

/** "base 4 (fit) × division 1.0 × platform 0.25 (SIDEARM Sports)". */
export function rankBreakdown(p: Pick<Prospect, 'rank' | 'fit_score'>): string | null {
  const r = p.rank;
  if (!r) return null;
  const source = p.fit_score != null && p.fit_score === r.base ? 'fit' : 'triage';
  const division = `division ${rankNumber(r.division_factor)}${r.affiliation ? ` (${r.affiliation})` : ''}`;
  const platform = `platform ${rankNumber(r.platform_factor)}${r.platform ? ` (${r.platform})` : ''}`;
  return `base ${r.base} (${source}) × ${division} × ${platform}`;
}

export interface RecheckResult {
  at: string;
  kept_previous: boolean;
  fit_score?: number | null;
  /** A count, not the contacts themselves. */
  contacts?: number;
  has_draft?: boolean;
  triage?: { engine?: string; score?: number | null; reason?: string | null; disqualify?: string | null } | null;
  disqualify_reason?: string | null;
  draft_problems?: string[];
}

/** The most useful one-line reason from a re-check: the first non-empty of
 * disqualify_reason, triage.disqualify, triage.reason. */
export function recheckReason(r: RecheckResult): string | null {
  return [r.disqualify_reason, r.triage?.disqualify, r.triage?.reason].find((s) => s && s.trim())?.trim() ?? null;
}

export interface PipelineProspect extends Prospect {
  stage: BoardStage;
  stage_changed_at?: string;
  days_in_stage?: number;
  history?: { stage: string; at: string; note?: string | null }[];
  touches?: { n: number; sent_at: string }[];
}

export interface FollowUp {
  prospect_id: number;
  touch: 2 | 3;
  due: string;
  draft: { subject: string; body: string };
}

export interface PipelineLine {
  line: string;
  display_name: string;
  stages: Record<BoardStage, PipelineProspect[]>;
  suppressed_count: number;
  follow_ups_due: FollowUp[];
}

export interface BdPipeline extends FeedMeta {
  run_at: string;
  lines: PipelineLine[];
}

export interface StatsLine {
  line: string;
  universe: number;
  researched: number;
  coverage_pct: number;
  by_stage: Partial<Record<string, number>>;
  conversion: { sent_to_replied?: number | null; replied_to_meeting?: number | null; meeting_to_won?: number | null };
  cost: { week_usd: number; month_usd: number; by_engine: Record<string, number> };
  signal_insights: { signal: string; prospects: number; replied: number; reply_rate: number }[];
}

export interface BdStats extends FeedMeta {
  run_at: string;
  lines: StatsLine[];
}

export interface BdProspects extends FeedMeta {
  run_at: string;
  week?: string;
  line?: string;
  counts?: { surfaced?: number; skipped?: number; errors?: number; with_contacts?: number; with_draft?: number };
  prospects: Prospect[];
  skipped: { name: string; reason: string }[];
  errors: { name: string; error: string }[];
}

export interface BizDevFeeds {
  bd_pipeline: BdPipeline;
  bd_stats: BdStats;
  bd_prospects: BdProspects;
}

export type BdFeedName = keyof BizDevFeeds;
export const BD_FEEDS: BdFeedName[] = ['bd_pipeline', 'bd_stats', 'bd_prospects'];

async function failure(res: Response, what: string): Promise<Error> {
  const detail = await res.json().then((b) => b?.detail).catch(() => null);
  return new Error(detail ? String(detail) : `${what} failed: ${res.status}`);
}

/** A feed's document, or null when Hermes hasn't produced it yet (404). */
export async function fetchBizDevFeed<F extends BdFeedName>(feed: F): Promise<BizDevFeeds[F] | null> {
  const res = await apiFetch(`/api/bizdev/${feed}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(res.status === 503 ? 'Hermes is unreachable' : `Failed: ${res.status}`);
  return res.json();
}

export async function moveProspect(id: number, stage: StageAction, note?: string): Promise<void> {
  const trimmed = note?.trim();
  const res = await apiFetch(`/api/bizdev/prospects/${id}/${stage}`, {
    method: 'POST',
    ...(trimmed
      ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note: trimmed.slice(0, 500) }) }
      : {}),
  });
  if (!res.ok) throw await failure(res, 'Stage change');
}

export async function recheckProspect(id: number): Promise<void> {
  const res = await apiFetch(`/api/bizdev/prospects/${id}/recheck`, { method: 'POST' });
  if (!res.ok) throw await failure(res, 'Re-check');
}

export async function researchMore(): Promise<void> {
  const res = await apiFetch('/api/bizdev/research/refresh', { method: 'POST' });
  if (!res.ok) throw await failure(res, 'Research');
}
