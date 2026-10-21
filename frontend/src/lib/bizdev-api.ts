/**
 * Business Development page data: Hermes's bd-researcher feeds, proxied by
 * /api/bizdev (hq/contracts/openjarvis-hermes.md v0.9 §2).
 *
 * Prospects carry official-directory work contacts (personal data). The page
 * displays them and builds mailto: links from them; it never stores them or
 * sends them anywhere else.
 */
import type { SpeechBlock } from './voice-api';
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
  /** The contact Hermes wrote it for; Send's To starts there. */
  to_email?: string | null;
  subject: string;
  body: string;
  /** v0.10.2: `hermes` or `template:<id>`; absent on older drafts (= hermes). */
  draft_source?: string | null;
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
  history?: HistoryEntry[];
  touches?: Touch[];
  /** v0.10: what came back after the sends ({} until the first). */
  engagement?: Engagement;
}

export interface HistoryEntry {
  stage: string;
  at: string;
  note?: string | null;
  /** v0.10: a send's entry carries the text actually sent. */
  subject?: string | null;
  body?: string | null;
  draft_source?: string | null;
}

/** Contract v0.10 / v0.10.2 `engagement`, from Hermes's engagement pull. */
export interface Engagement {
  sent_at?: string | null;
  fe_status?: FeStatus | null;
  /** All opens, proxy prefetches included. */
  opens?: number;
  proxy_opens?: number;
  first_open_at?: string | null;
  last_open_at?: string | null;
  replied_at?: string | null;
  reply_kind?: 'reply' | 'auto_reply' | 'reply_other_sender' | null;
  replies?: number;
  replied_touch?: number | null;
  time_to_reply_h?: number | null;
  auto_reply_at?: string | null;
  followup_hold_until?: string | null;
  bounced_at?: string | null;
  bounce_kind?: 'hard' | 'soft' | null;
  unsubscribed_at?: string | null;
}

/** Contract v0.10: delivery status, relayed from Forward Email by OpenJarvis. */
export type FeStatus = 'pending' | 'queued' | 'deferred' | 'rejected' | 'sent';

/** One sent touch. The v0.10 keys are absent on touches marked sent by hand. */
export interface Touch {
  n: number;
  sent_at: string;
  message_id?: string | null;
  fe_id?: string | null;
  fe_status?: FeStatus | null;
  /** v0.10.1: why a mail was deferred or rejected (Forward Email's first line). */
  fe_error?: string | null;
  to_email?: string | null;
  draft_source?: string | null;
  subject?: string | null;
  body?: string | null;
  /** v0.10.2 per-touch counts. */
  opens?: number;
  soft_bounces?: number;
  bounce?: string | null;
}

export interface FollowUp {
  prospect_id: number;
  touch: 2 | 3;
  due: string;
  draft: { subject: string; body: string; to_email?: string | null };
  /** v0.10.2: `template:<id>` when Hermes merged the line's default template. */
  draft_source?: string | null;
}

/** Contract v0.10 `screen`: what a line never says, and its footer. */
export interface Screen {
  patterns: { regex: string; reason: string }[];
  /** Holds `[Your name]` and `[postal address]` for the sender to fill. */
  footer: string;
}

export type TemplateTouch = 1 | 2 | 3 | 'any';

export interface Template {
  id: number;
  name: string;
  touch: TemplateTouch;
  subject: string;
  body: string;
  merge_fields_used?: string[];
  default_for_touch?: 1 | 2 | 3 | null;
  uses?: number;
  replies?: number;
  archived_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface PipelineLine {
  line: string;
  display_name: string;
  stages: Record<BoardStage, PipelineProspect[]>;
  suppressed_count: number;
  follow_ups_due: FollowUp[];
  screen?: Screen;
  /** Current templates by name, then archived ones (newest archived first). */
  templates?: Template[];
}

export interface BdPipeline extends FeedMeta {
  /** Spoken script(s) for the voice worker (contract v1.1). */
  speech?: SpeechBlock[];

  run_at: string;
  lines: PipelineLine[];
}

/** Contract v0.10.2 `bd_stats.lines[].engagement`; rates are 0-1 or null. */
export interface EngagementStats {
  pulled_at?: string | null;
  sends?: number;
  delivery_rate?: number | null;
  open_rate_nonproxy?: number | null;
  reply_rate_by_touch?: Partial<Record<'1' | '2' | '3', number | null>>;
  reply_rate_by_draft_source?: Record<string, number | null>;
  median_time_to_reply_h?: number | null;
  bounce_rate_week?: number | null;
  /** Only past 30 sends. */
  reply_rate_by_send_slot?: { dow: string; hour_bucket: string; sent: number; replied: number }[];
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
  engagement?: EngagementStats;
}

export interface BdStats extends FeedMeta {
  run_at: string;
  lines: StatsLine[];
}

export interface BdProspects extends FeedMeta {
  /** Spoken script(s) for the voice worker (contract v1.1). */
  speech?: SpeechBlock[];

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

// ---------------------------------------------------------------------------
// Send (hq 0018, contract v0.10 BD): the operator's click sends through Forward
// Email from this machine; Hermes records the touch from the `sent` flag.
// ---------------------------------------------------------------------------

export interface SendConfig {
  enabled: boolean;
  sender_name: string | null;
  sender_address: string | null;
  reply_to: string | null;
  /** Fills `{{sender_title}}`; absent on older servers. */
  sender_title?: string | null;
  /** Part B: mails carry the open pixel. */
  tracking?: boolean;
  /** Config keys a half-done setup still lacks (names only). */
  missing: string[];
}

export interface SendRequest {
  to_email: string;
  subject: string;
  body: string;
  touch: number;
  from_name?: string;
  draft_source: string;
  in_reply_to_message_id?: string;
  /** Characters changed against the Hermes draft or the merged template. */
  draft_edited?: number;
}

export interface SendResult {
  fe_id: string;
  message_id: string;
  fe_status: FeStatus;
  /** False when the bridge didn't take the record yet; the server retries it. */
  recorded: boolean;
}

/** Whether Send is set up; null when the server can't say (Send stays off). */
export async function fetchSendConfig(): Promise<SendConfig | null> {
  try {
    const res = await apiFetch('/api/bizdev/send-config');
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

export async function sendProspect(id: number, req: SendRequest): Promise<SendResult> {
  const res = await apiFetch(`/api/bizdev/prospects/${id}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!res.ok) throw await failure(res, 'Send');
  return res.json();
}

/** The touch a Send records: 1 for a card never sent, the same touch again
 * after a rejected send, else the one after the last (as the server checks). */
export function nextTouch(p: Pick<PipelineProspect, 'touches'>): number {
  const touches = p.touches ?? [];
  if (!touches.length) return 1;
  const last = touches.reduce((a, b) => (b.n > a.n ? b : a));
  return last.fe_status === 'rejected' ? last.n : last.n + 1;
}

export function touchOf(p: Pick<PipelineProspect, 'touches'>, n: number): Touch | undefined {
  const matches = (p.touches ?? []).filter((t) => t.n === n);
  return matches[matches.length - 1];
}

/** Touch 1's message id, which a follow-up threads on. */
export function firstMessageId(p: Pick<PipelineProspect, 'touches'>): string | null {
  return touchOf(p, 1)?.message_id ?? null;
}

/** `{{field}}` names left in the text; any one blocks Send. */
export function unresolvedFields(...texts: string[]): string[] {
  const out = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)) out.add(m[1] || '?');
  return [...out].sort();
}

/** The send route's body for one touch of one prospect. */
export function sendRequest(
  p: Pick<PipelineProspect, 'touches'>,
  {
    touch,
    to,
    fromName,
    subject,
    body,
    draftSource = 'hermes',
    draftEdited,
  }: {
    touch: number;
    to: string;
    fromName?: string;
    subject: string;
    body: string;
    draftSource?: string;
    draftEdited?: number;
  },
): SendRequest {
  const req: SendRequest = { to_email: to, subject, body, touch, draft_source: draftSource };
  const name = fromName?.trim();
  if (name) req.from_name = name;
  const first = touch > 1 ? firstMessageId(p) : null;
  if (first) req.in_reply_to_message_id = first;
  if (draftEdited != null) req.draft_edited = draftEdited;
  return req;
}

// ---------------------------------------------------------------------------
// Templates (contract v0.10 `templates[]`): saved through the bridge; Hermes
// applies them within a pass of bd-requests (2 minutes).
// ---------------------------------------------------------------------------

export interface TemplateSave {
  id?: number;
  line: string;
  name: string;
  touch: TemplateTouch;
  subject: string;
  body: string;
  default_for_touch?: 1 | 2 | 3;
}

export async function saveTemplate(t: TemplateSave): Promise<void> {
  const res = await apiFetch('/api/bizdev/templates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(t),
  });
  if (!res.ok) throw await failure(res, 'Saving the template');
}

export async function archiveTemplate(id: number): Promise<void> {
  const res = await apiFetch(`/api/bizdev/templates/${id}/archive`, { method: 'POST' });
  if (!res.ok) throw await failure(res, 'Archiving the template');
}
