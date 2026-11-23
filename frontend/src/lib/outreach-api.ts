/**
 * The Outreach page (hq 0031 Part C, contract v1.31 §6.7 to §6.9): the target
 * accounts for the operator's hand outreach on Instagram. /api/outreach/state
 * is OpenJarvis's own store (the lists, today's round, the checklist, the
 * log); `ig_reach` and `ig_target_candidates` are Hermes feeds that may not
 * exist yet (404 reads "not yet").
 *
 * Nothing here posts, likes, follows or messages: Open hands the profile link
 * to the operator's browser and Copy puts an angle on the clipboard. Pure
 * helpers live here so they test without a DOM.
 */
import { apiFetch } from './api';
import { ApiError, failure, fetchFeed } from './http';

export const TIERS = ['peer', 'large', 'creator'] as const;
export const STATUSES = ['active', 'paused', 'dropped'] as const;
export const COLLAB_STATES = ['none', 'asked', 'agreed', 'posted'] as const;
export type Tier = (typeof TIERS)[number];
export type AccountStatus = (typeof STATUSES)[number];
export type CollabState = (typeof COLLAB_STATES)[number];
export const LIMITS = { niche: 80, why: 280, notes: 1000, about: 500, angle: 200 } as const;

export interface Account {
  handle: string;
  profile_url: string;
  niche: string;
  tier: Tier;
  why: string;
  source: 'operator' | 'hermes';
  status: AccountStatus;
  last_engaged_at: string | null;
  collab_state: CollabState;
  notes: string;
  added_at: string;
  updated_at: string;
  /** A candidate Hermes found: the page it was found on. */
  found_on?: string | null;
}

export type RoundState = 'open' | 'done' | 'skip';

export interface RoundRow extends Account {
  state: RoundState;
  at: string | null;
  /** The angle kept on Done, if one was used. */
  angle: string | null;
}

export interface Round {
  day: string;
  size: number;
  rows: RoundRow[];
  open: number;
  done: number;
  skipped: number;
  complete: boolean;
}

export const CHECK_ITEMS = ['comments_answered', 'reel_to_stories'] as const;
export type CheckItem = (typeof CHECK_ITEMS)[number];
export const CHECK_LABEL: Record<CheckItem, string> = {
  comments_answered: 'Comments answered',
  reel_to_stories: 'Newest Reel shared to Stories, with a link sticker',
};

export interface Checklist {
  day: string;
  comments_answered: boolean;
  reel_to_stories: boolean;
  round_done: boolean;
  days_kept: number;
  streak: number;
}

export interface LogLine {
  at: string;
  day: string;
  brand: string;
  kind: 'done' | 'skip' | 'undo' | 'check' | 'round';
  handle?: string;
  angle?: string;
  item?: CheckItem;
  checked?: boolean;
  complete?: boolean;
  done?: number;
  skipped?: number;
}

export interface BrandState {
  id: string;
  accounts: Account[];
  dismissed: string[];
  round: Round;
  checklist: Checklist;
  log: LogLine[];
}

export interface OutreachState {
  /** False until the workspace folder and the brand list are in local config. */
  configured: boolean;
  day: string;
  round_size: number;
  brands: BrandState[];
}

/** §6.7. Any figure may be null: "not read", never zero. */
export interface ReachProperty {
  id: string;
  week?: {
    from?: string;
    to?: string;
    reels?: number | null;
    stills?: number | null;
    median_reach?: number | null;
    shares_per_reel?: number | null;
    saves?: number | null;
    comments?: number | null;
    followers?: number | null;
    followers_change?: number | null;
    bio_sessions?: number | null;
  } | null;
  baseline?: { as_of?: string; median_reach?: number | null; shares_per_reel?: number | null } | null;
  test?: {
    started?: string;
    day?: number | null;
    ends?: string;
    read_on?: string;
    reels?: number | null;
    reels_at_day7?: number | null;
    median_reach?: number | null;
    median_reach_day7?: number | null;
    shares_per_reel?: number | null;
  } | null;
  pass_line?: { median_reach_min?: number | null; shares_per_reel_min?: number | null; followers_up?: boolean } | null;
  meets?: { median_reach?: boolean | null; shares_per_reel?: boolean | null; followers?: boolean | null; all?: boolean | null } | null;
}

export interface IgReach {
  run_at?: string;
  week?: string;
  properties?: ReachProperty[];
  errors?: unknown[];
  generated_at?: string;
  age_seconds?: number;
  stale?: boolean;
}

export interface Candidate {
  handle: string;
  why?: string;
  found_on?: string;
}

export interface IgCandidates {
  run_at?: string;
  week?: string;
  properties?: { id: string; candidates?: Candidate[]; skipped_known?: number }[];
  errors?: unknown[];
  generated_at?: string;
  age_seconds?: number;
  stale?: boolean;
}

export interface AnglesResult {
  angles: string[];
  screened_out: number;
  model: string;
  rule_source: string;
  kernel_source: string;
}

export interface AddResult {
  added: string[];
  duplicates: string[];
  invalid: string[];
}

export type AccountEdits = Partial<Pick<Account, 'niche' | 'tier' | 'why' | 'status' | 'collab_state' | 'notes'>>;

const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function send<T>(path: string, method: string, body: unknown, what: string): Promise<T> {
  const res = await apiFetch(path, {
    method,
    headers: JSON_HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw await failure(res, what);
  return res.json();
}

export async function fetchOutreach(): Promise<OutreachState> {
  const res = await apiFetch('/api/outreach/state');
  if (!res.ok) throw await failure(res, 'Outreach');
  return res.json();
}

export const fetchReach = () => fetchFeed<IgReach>('outreach', 'ig_reach');
export const fetchCandidates = () => fetchFeed<IgCandidates>('outreach', 'ig_target_candidates');

export const addAccounts = (brand: string, text: string) =>
  send<AddResult>('/api/outreach/accounts', 'POST', { brand, text }, 'Add');

const at = (brand: string, handle: string) => `${encodeURIComponent(brand)}/${encodeURIComponent(handle)}`;

export const editAccount = (brand: string, handle: string, edits: AccountEdits) =>
  send<Account>(`/api/outreach/accounts/${at(brand, handle)}`, 'PATCH', edits, 'Save');

export const markRound = (brand: string, handle: string, action: 'done' | 'skip' | 'undo', angle?: string | null) =>
  send<Round>(`/api/outreach/round/${at(brand, handle)}`, 'POST', { action, angle: angle ?? null }, 'Mark');

export const setCheck = (brand: string, item: CheckItem, checked: boolean) =>
  send<unknown>(`/api/outreach/checklist/${encodeURIComponent(brand)}`, 'POST', { item, checked }, 'Checklist');

export const draftAngles = (brand: string, handle: string, about: string) =>
  send<AnglesResult>('/api/outreach/angles', 'POST', { brand, handle, about }, 'Angles');

export const decideCandidate = (brand: string, handle: string, action: 'accept' | 'dismiss') =>
  send<unknown>(`/api/outreach/candidates/${at(brand, handle)}/${action}`, 'POST', undefined, action === 'accept' ? 'Accept' : 'Dismiss');

export { ApiError };

// ---------- pure helpers ----------

/** `brand:handle`, the key the page keeps a row's angles and busy state under. */
export const rowKey = (brand: string, handle: string) => `${brand}:${handle}`;

/** Hermes's candidates for a brand that are not already on the list or dismissed. */
export function openCandidates(feed: IgCandidates | null, brand: BrandState): Candidate[] {
  const known = new Set([...brand.accounts.map((a) => a.handle), ...brand.dismissed]);
  const prop = feed?.properties?.find((p) => p.id === brand.id);
  const seen = new Set<string>();
  return (prop?.candidates ?? []).filter((c) => {
    const handle = String(c.handle ?? '').toLowerCase().replace(/^@/, '');
    if (!handle || known.has(handle) || seen.has(handle)) return false;
    seen.add(handle);
    return true;
  });
}

/** The list in reading order: active first, then paused, then dropped; inside
 * each, the one waiting longest first (never engaged before anyone), then the
 * list's own order, as the round picks them. */
export function sortAccounts(accounts: Account[]): Account[] {
  const rank = (a: Account) => STATUSES.indexOf(a.status);
  const place = new Map(accounts.map((a, i) => [a.handle, i]));
  return [...accounts].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.last_engaged_at ?? '').localeCompare(b.last_engaged_at ?? '') ||
      (place.get(a.handle) ?? 0) - (place.get(b.handle) ?? 0),
  );
}

/** "today", "yesterday", "5 d ago", or "never". Days are the operator's local days. */
export function engagedWords(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 'never';
  const day = (ms: number) => {
    const d = new Date(ms);
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  };
  const days = Math.round((day(now) - day(t)) / 86_400_000);
  if (days <= 0) return 'today';
  return days === 1 ? 'yesterday' : `${days} d ago`;
}

/** "3 of 5 left", "Round done: 4 done, 1 skipped", or why there is none. */
export function roundLine(round: Round, active: number): string {
  if (!round.rows.length) return active ? 'Every active account was engaged today' : 'No active account yet: add some below';
  if (round.complete) {
    return `Round done: ${round.done} done${round.skipped ? `, ${round.skipped} skipped` : ''}`;
  }
  return `${round.open} of ${round.rows.length} left`;
}

/** A figure, or "not read" when Hermes could not read it (never a zero). */
export const figure = (n: number | null | undefined, digits = 0): string =>
  n == null || Number.isNaN(n) ? 'not read' : n.toLocaleString('en-US', { maximumFractionDigits: digits });

export type Verdict = 'meets' | 'short' | 'unread';

export const verdict = (b: boolean | null | undefined): Verdict => (b == null ? 'unread' : b ? 'meets' : 'short');

/** One log line as the page reads it. */
export function logWords(line: LogLine): string {
  switch (line.kind) {
    case 'done':
      return `Done @${line.handle}${line.angle ? `: “${line.angle}”` : ''}`;
    case 'skip':
      return `Skipped @${line.handle}`;
    case 'undo':
      return `Undid @${line.handle}`;
    case 'check':
      return `${line.checked ? 'Ticked' : 'Unticked'}: ${line.item ? CHECK_LABEL[line.item] : 'checklist'}`;
    case 'round':
      return line.complete ? `Round done (${line.done ?? 0} done, ${line.skipped ?? 0} skipped)` : 'Round reopened';
    default:
      return String((line as { kind: string }).kind);
  }
}
