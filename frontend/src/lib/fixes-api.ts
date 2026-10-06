/**
 * Catalog fixes: Hermes's proposed product-copy fixes and the operator's
 * decisions on them (hq/contracts/openjarvis-hermes.md v1.3 §2, "Catalog
 * fixes", through v1.3.4, the v1.4 tiers and the v1.5 SEO meta patches). The feed is proxied like the other ecom feeds; the
 * decision POSTs go to /api/commerce/fixes, where the backend adds the
 * operator token. The token never reaches this code. From P2 the writer
 * applies approved fixes once it is live.
 */
import type { SpeechBlock } from './voice-api';
import type { FeedMeta } from './commerce-api';
import { apiFetch } from './api';

export type FixStatus =
  | 'proposed'
  | 'invalid'
  | 'approved'
  | 'rejected'
  | 'stale'
  | 'confirm'
  | 'applied'
  | 'verified'
  | 'failed-verify'
  | 'reverted';

export const FIX_STATUSES: FixStatus[] = [
  'proposed',
  'invalid',
  'approved',
  'rejected',
  'stale',
  'confirm',
  'applied',
  'verified',
  'failed-verify',
  'reverted',
];

export interface FixClass {
  store: string;
  rule: string;
  field: string;
}

/** v1.5 (0011 A16): where a patch came from. */
export type FixSource = 'sentinel' | 'rec' | 'seo';
export const FIX_SOURCES: FixSource[] = ['sentinel', 'rec', 'seo'];

/** v1.5: the SEO audit's latest reading of an applied `seo.*` patch (A16 D2). */
export interface SeoVerify {
  at: string;
  by?: string;
  /** `verified`, `failed`, `still` (the page shows the copy but the audit
   * still reports a code) or `cache` (the page hasn't caught up). */
  result: string;
  detail?: string;
  page_cleared?: boolean;
}

export interface FixChange {
  field: string;
  before: string;
  before_sha256: string;
  after: string;
  rationale?: string;
}

export interface ValidatorCheck {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface Patch {
  id: string;
  patch_sha256: string;
  store: string;
  product_id: string;
  product_title: string;
  admin_url?: string;
  fix_class: FixClass;
  /** v1.5: `seo_issues` are the audit codes a `seo` patch addresses. */
  addresses: { finding_ids: string[]; rec_ids: string[]; seo_issues?: string[] };
  changes: FixChange[];
  validator: { passed: boolean; checks: ValidatorCheck[] };
  judge?: {
    model?: string;
    judge_version?: string;
    verdict: 'clear' | 'finding';
    quote?: string;
    reason?: string;
  };
  status: FixStatus;
  edited: boolean;
  created_at: string;
  decided_at: string | null;
  note: string | null;
  /** Decisions and, from P2, the writer's outcomes. v1.3.4: `reason` is a
   * machine code, set only on the writer's entries; `note` keeps the words. */
  history: { status: string; at: string; note?: string | null; reason?: string | null }[];
  /** v1.3.4 `read_back_mismatch`; v1.4 `via`: who applied it. */
  applied: { at: string; snapshot_id: string; read_back_mismatch?: boolean; via?: 'operator' | 'auto' } | null;
  verified: { at: string; by: string } | null;
  /** v1.3.2 (0011 A6): the operator approved this over a judge flag. */
  judge_overridden?: boolean;
  /** v1.3.2 (A7): the specs check dropped a figure under a judge flag, so
   * this patch is never auto-applied and stays out of class approvals. */
  review_only?: boolean;
  /** v1.3.3: the figures the specs check let go, as the check's tokens. */
  drops?: { finding: { id: string; tokens: string[] }[]; judge: string[] };
  /** v1.3.3: either `drops` list is non-empty. */
  drops_figure?: boolean;
  /** v1.3.3 (A9): set when a P1 approval was re-confirmed. */
  confirmed?: { at: string; via: 'single' | 'class' } | null;
  /** v1.4: Hermes has handed it to the writer as a tier-1 candidate. */
  auto_candidate?: boolean;
  /** v1.5 (A16): where the patch came from; older patches lack it, see
   * `patchSource`. */
  source?: FixSource;
  /** v1.5: the check profile that ran. `seo` makes `length` an absolute
   * range and lets `specs` drop figures. */
  checks_profile?: 'standard' | 'seo';
  /** v1.5: set on a Foundry-copy patch (rule `seo:foundry`), which had no
   * model call. */
  copy_source?: { generated_at: string; source_commit: string } | null;
  product_url?: string;
  /** v1.5 (A16 D2): the SEO audit's latest reading, on applied seo patches. */
  seo_verify?: SeoVerify | null;
}

export interface ClassStats extends FixClass {
  /** v1.3.2 (A8): single, unedited, non-override approvals only. */
  streak: number;
  approvals: number;
  /** v1.3.2 (A8): approvals through "Approve these N"; never in the streak. */
  bulk_approvals?: number;
  edits: number;
  rejects: number;
  reverts: number;
  /** v1.4: the effective tier, 1 only when the policy says 1 and the class
   * isn't demoted. */
  tier: number;
  /** v1.4 (A14): streak ≥ 20, verified ≥ 20, and no revert or failed
   * verification since the streak began. */
  eligible: boolean;
  /** v1.4: what the policy file says, the property's rules hash, a demotion
   * since the policy's `since`, and the auto-applied count. */
  policy_tier?: number;
  rules_sha256?: string;
  demoted?: { at: string; reason: string } | null;
  auto_applied?: number;
  /** v1.4 (A14): the first approval of the current streak; null at 0. */
  streak_since?: string | null;
  /** v1.5 (A16 D1): the threshold `eligible` uses for the streak and the
   * verified count: 5 for `seo:foundry`, 20 otherwise. See `suggestAt`. */
  suggest_at?: number;
  /** v1.3.3 (A11): the writer's outcomes, as patch counts. */
  applied?: number;
  verified?: number;
  failed_verify?: number;
  reverted?: number;
  /** v1.3.3 (A9): while the class has P1 approvals to re-confirm. */
  spot_check?: {
    confirmed: number;
    required: number;
    passed: boolean;
    /** v1.3.4: the figure-dropping P1 approvals not yet confirmed singly. */
    blockers?: string[];
  } | null;
}

export interface CatalogFixes extends FeedMeta {
  speech?: SpeechBlock[];
  run_at: string;
  paused: boolean;
  writer: {
    live: boolean;
    writes_today: number;
    writes_cap: number | null;
    auto_today: number;
    auto_cap: number | null;
    /** v1.3.3: when the writer went live; null before. */
    live_since?: string | null;
    /** v1.3.4: the pause as the writer last saw it, when it last wrote its
     * status, and each enabled store's credentials. */
    paused_writer?: boolean;
    status_at?: string | null;
    credentials?: Record<string, { ok: boolean; reason?: string | null }>;
  };
  counts: Partial<Record<FixStatus, number>>;
  patches: Patch[];
  classes: ClassStats[];
  /** The fixer's last run; v1.5 adds its `seo` block. */
  last_fixer_run?: FixerRun | null;
}

/** v1.5: what the fixer's SEO pass did in its last run. */
export interface FixerSeoRun {
  /** Items held back because the product had a compliance finding this run. */
  compliance_first?: number;
  /** Items proposed, per store and class rule. */
  items?: Record<string, Record<string, number>>;
  in_stock?: number;
  out_of_stock?: number;
  /** Foundry's copy export per store. */
  copy_files?: Record<string, { generated_at: string; source_commit: string; items?: number }>;
  /** The theme's suffix on each store's page titles. */
  title_suffix?: Record<string, string>;
}

export interface FixerRun {
  run_at?: string;
  duration_s?: number;
  considered?: number;
  attempted?: number;
  proposed?: number;
  invalid?: number;
  stale_marked?: number;
  model_calls?: number;
  foundry_proposals?: number;
  cost_usd?: number;
  left_for_next_run?: number;
  seo?: FixerSeoRun | null;
}

// -- v1.5: SEO meta patches (0011 A16) ----------------------------------------

/** A patch's source. An older patch without the key is `sentinel` when it
 * addresses a finding, else `rec` (contract v1.5). */
export function patchSource(p: Pick<Patch, 'source' | 'addresses'>): FixSource {
  if (p.source) return p.source;
  return p.addresses.finding_ids.length > 0 ? 'sentinel' : 'rec';
}

export const SOURCE_TITLE: Record<FixSource, string> = {
  sentinel: 'From a compliance finding',
  rec: 'From a recommendation',
  seo: 'From the SEO audit: meta description or SEO title',
};

export const isSeoField = (field: string) => field === 'seo.title' || field === 'seo.description';

/** The `seo` check profile's length ranges, in characters (A16). */
export const SEO_RANGE: Record<string, { min: number; max: number }> = {
  'seo.title': { min: 30, max: 65 },
  'seo.description': { min: 70, max: 160 },
};

/** Characters as Hermes counts them (code points, not UTF-16 units). */
export const charCount = (s: string) => Array.from(s).length;

export const EMPTY_BEFORE = 'empty (Shopify shows the default)';

/** The copy_source chip: "Foundry copy <generated_at date>, <source_commit>". */
export const foundryCopyLabel = (cs: { generated_at: string; source_commit: string }) =>
  `Foundry copy ${cs.generated_at.slice(0, 10)}, ${cs.source_commit}`;

/** The audit codes a seo patch addresses, in words. */
export const SEO_ISSUE_WORDS: Record<string, string> = {
  missing_meta_description: 'missing meta description',
  meta_description_length: 'meta description length',
  title_length: 'title length',
};

const codesIn = (detail: string) =>
  [...detail.matchAll(/still reports ([a-z_]+(?:, [a-z_]+)*)/g)]
    .flatMap((m) => m[1].split(', '))
    .filter((c, i, all) => all.indexOf(c) === i);

/** What the audit's reading of an applied seo patch means, plainly. A
 * `still` reading is the theme-suffix case: the written title is in range,
 * but the theme's suffix pushes the page title over it, so the audit still
 * reports `title_length` and the patch stays applied. */
export function seoVerifyText(v: SeoVerify): string {
  const detail = v.detail ?? '';
  const still = v.result === 'still' || (v.result !== 'verified' && v.result !== 'failed' && /still reports/.test(detail));
  if (still) {
    const codes = codesIn(detail).map((c) => SEO_ISSUE_WORDS[c] ?? c);
    const what = codes.length ? codes.join(', ') : 'the issue';
    const suffix = codes.includes('title length')
      ? ' The theme adds a suffix to the page title, so the page title is still over the range.'
      : '';
    return `Still applied, not verified: the page shows the written copy, but the audit still reports ${what}.${suffix}`;
  }
  switch (v.result) {
    case 'verified':
      return 'Verified by the SEO audit: the page shows the written copy and the audit no longer reports the issue.';
    case 'failed':
      return 'Failed verification: the page shows a different value than was written.';
    case 'cache':
      return 'Still applied: the page still shows the copy from before the write. The audit checks it again next time.';
    default:
      return detail ? `${v.result}: ${detail}` : v.result;
  }
}

/** v1.4: a fix the writer applied without asking, as the general digest
 * lists it (`digest_general.data.auto_fixes`). */
export interface AutoFix {
  patch_id: string;
  store: string;
  product_title: string;
  admin_url?: string;
  fix_class: FixClass;
  applied_at: string;
}

export type FixAction = 'approve' | 'edit' | 'reject' | 'revert' | 'confirm';

/** The statuses each action is offered on (0011 §7, contract v1.3.3). */
export function actionsFor(status: FixStatus): FixAction[] {
  switch (status) {
    case 'proposed':
      return ['approve', 'edit', 'reject'];
    case 'invalid':
      return ['edit'];
    case 'confirm':
      // v1.3.4: Reject withdraws a P1 approval instead of confirming it.
      return ['confirm', 'reject'];
    case 'applied':
    case 'verified':
    case 'failed-verify':
      return ['revert'];
    default:
      return [];
  }
}

export const isWaiting = (s: FixStatus) => s === 'proposed' || s === 'invalid';

/** Waiting on the operator: a proposal, or a P1 approval to re-confirm. */
export const needsOperator = (s: FixStatus) => isWaiting(s) || s === 'confirm';

/** The writer's own history entries (v1.3.3), shown as warnings. */
export const WRITER_EVENTS = new Set(['refused', 'failed_apply', 'revert_blocked']);

type HistoryEntry = Patch['history'][number];

/** A writer entry: one with a `reason` (v1.3.4). Older entries have only a
 * note, so for them: one of the writer's own events, or a status change
 * whose note says the writer refused it. */
export const isWriterEntry = (h: HistoryEntry) =>
  !!h.reason || WRITER_EVENTS.has(h.status) || /^the writer refused/i.test(h.note ?? '');

/** The validator checks' names in words. */
export const CHECK_WORDS: Record<string, string> = {
  fields: 'fields',
  fresh_before: 'current copy',
  specs: 'specs',
  phrases: 'phrases',
  html: 'HTML',
  length: 'length',
  judge: 'judge',
};

/** The writer's reason codes (v1.3.4) in words; an unknown code shows as is. */
const REASON_WORDS: Record<string, string> = {
  stale: 'the live copy changed since the fix was made',
  hash_mismatch: 'the fix changed after it was approved',
  no_property: 'no rules for this store',
  failed_apply: 'Shopify didn’t take the change',
  revert_blocked: 'the revert was blocked',
};

export function reasonText(code: string): string {
  const auto = /^auto_refused:(.*)$/.exec(code);
  if (auto) return `auto-apply refused: ${reasonText(auto[1])}`;
  const checks = /^checks_failed:(.*)$/.exec(code);
  if (checks) {
    const names = checks[1].split(',').map((c) => c.trim()).filter(Boolean);
    const words = names.map((c) => CHECK_WORDS[c] ?? c).join(', ');
    return `${names.length === 1 ? 'check' : 'checks'} failed: ${words}`;
  }
  return REASON_WORDS[code] ?? code;
}

/** What a history entry says: its reason first, then its note. */
export const entryWhy = (h: HistoryEntry): string | null => (h.reason ? reasonText(h.reason) : h.note || null);

/** Why a card is in its status when its checks don't say: the latest
 * history entry's reason (else note) on a writer entry, or on an invalid
 * card with no failed check. Otherwise null. */
export function statusReason(patch: Pick<Patch, 'status' | 'validator' | 'history'>): string | null {
  const last = patch.history[patch.history.length - 1];
  const why = last && entryWhy(last);
  if (!why) return null;
  if (isWriterEntry(last)) return why;
  if (patch.status === 'invalid' && patch.validator.checks.every((c) => c.passed)) return why;
  return null;
}

/** An invalid patch whose only failed check is the judge: the operator may
 * approve it over the judge (v1.3.2, 0011 A6). The deterministic checks stay
 * binding, so any other failed check rules it out. */
export function judgeOnlyInvalid(patch: Pick<Patch, 'status' | 'validator' | 'judge'>): boolean {
  if (patch.status !== 'invalid') return false;
  const failed = patch.validator.checks.filter((c) => !c.passed);
  return failed.length > 0 && failed.every((c) => c.name === 'judge');
}

/** The specs check's figures, by why they were dropped (0011 A4, A7):
 * `finding` ones a linked finding quotes, `judge` ones under a judge flag,
 * `unexempt` ones the check failed on. */
export interface SpecDrops {
  finding: { id: string; tokens: string[] }[];
  judge: string[];
  unexempt: string[];
}

const figures = (list: string) =>
  list
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean);

/** Reads the structured `drops` (v1.3.3) when the patch has it. Older
 * patches fall back to parsing the specs check's `detail`, whose wording
 * Hermes keeps stable; the figures the check failed on come only from there. */
export function specDrops(patch: Pick<Patch, 'validator' | 'drops'>): SpecDrops {
  const out: SpecDrops = { finding: [], judge: [], unexempt: [] };
  const detail = patch.validator.checks.find((c) => c.name === 'specs')?.detail ?? '';
  for (const m of detail.matchAll(/dropped(?: under (judge flag|finding ([^:;]*)))?:\s*([^;]*)/g)) {
    if (!m[1]) out.unexempt.push(...figures(m[3]));
    else if (m[1] === 'judge flag') out.judge.push(...figures(m[3]));
    else out.finding.push({ id: m[2].trim(), tokens: figures(m[3]) });
  }
  if (patch.drops) {
    out.finding = patch.drops.finding.map((f) => ({ id: f.id, tokens: [...f.tokens] }));
    out.judge = [...patch.drops.judge];
  }
  return out;
}

/** The bridge's class refusal reasons (v1.3.1 and v1.3.3), in the
 * operator's words. */
export const REFUSAL_REASON: Record<string, string> = {
  unknown: 'not in the feed',
  class: 'not in this class',
  status: 'already decided or still recording',
  changed: 'changed since shown',
  store_unavailable: 'store unavailable',
  review_only: 'review only: one at a time',
  spot_check: 'spot-check not passed yet',
  not_live: 'the writer isn’t live yet',
};

// -- the tier control (v1.4, 0011 A13) ----------------------------------------

/** One class in the auto-fix policy file. */
export interface PolicyClass extends FixClass {
  tier: 1;
  since: string;
  rules_sha256: string;
  note?: string;
}

/** The policy file as OpenJarvis's backend reads it; missing: none auto-applies. */
export interface AutofixPolicy {
  exists: boolean;
  updated_at: string | null;
  classes: PolicyClass[];
}

/** Why the backend refused a tier change, in the operator's words. */
export const TIER_REFUSAL: Record<string, string> = {
  not_eligible: 'the class isn’t eligible in the latest feed',
  changed: 'the class’s rules changed since shown',
  no_rules_hash: 'the feed has no rules hash for this class yet',
  unknown: 'the class isn’t in the latest feed',
  unreadable: 'the policy file can’t be read; fix it by hand first',
};

/** The policy file, or null when the backend can't say (not configured). */
export async function fetchAutofixPolicy(): Promise<AutofixPolicy | null> {
  const res = await apiFetch('/api/commerce/fixes/policy');
  if (!res.ok) return null;
  return res.json();
}

/** A tier change: a request to OpenJarvis's own backend, which writes the
 * policy file; nothing goes to Hermes. Raising sends the rules hash shown. */
export function tierRequest(cls: FixClass & { rules_sha256?: string }, tier: 0 | 1, note?: string): FixRequest {
  return {
    path: '/api/commerce/fixes/policy',
    body: {
      store: cls.store,
      rule: cls.rule,
      field: cls.field,
      tier,
      ...(tier === 1 ? { rules_sha256: cls.rules_sha256 ?? null } : {}),
      ...cleanNote(note),
    },
  };
}

export interface FixRequest {
  path: string;
  body?: unknown;
}

const cleanNote = (note?: string) => {
  const n = note?.trim().slice(0, 500);
  return n ? { note: n } : {};
};

/**
 * The request for one decision. Approve and edit carry the hash of the patch
 * as it was displayed, so the operator approves exactly what they saw.
 */
export function fixRequest(
  action: FixAction,
  patch: Pick<Patch, 'id' | 'patch_sha256'>,
  opts: { note?: string; changes?: { field: string; after: string }[]; overJudge?: boolean } = {},
): FixRequest {
  const path = `/api/commerce/fixes/${patch.id}/${action}`;
  switch (action) {
    case 'approve':
      return {
        path,
        body: {
          patch_sha256: patch.patch_sha256,
          ...(opts.overJudge ? { over_judge: true } : {}),
          ...cleanNote(opts.note),
        },
      };
    case 'confirm':
      return { path, body: { patch_sha256: patch.patch_sha256, ...cleanNote(opts.note) } };
    case 'edit':
      return {
        path,
        body: { patch_sha256: patch.patch_sha256, changes: opts.changes ?? [], ...cleanNote(opts.note) },
      };
    default:
      return { path, body: cleanNote(opts.note) };
  }
}

export type ClassAction = 'approve' | 'confirm';

export function approveClassRequest(
  cls: FixClass,
  patches: Pick<Patch, 'id' | 'patch_sha256'>[],
  note?: string,
  action: ClassAction = 'approve',
): FixRequest {
  return {
    path: `/api/commerce/fixes/${action}-class`,
    body: {
      store: cls.store,
      rule: cls.rule,
      field: cls.field,
      patches: patches.map((p) => ({ id: p.id, patch_sha256: p.patch_sha256 })),
      ...cleanNote(note),
    },
  };
}

export interface FixResponse {
  status: number;
  body: Record<string, unknown>;
}

/** POST a decision; any status comes back (202, 401, 409 are all meaningful). */
export async function postFix(req: FixRequest): Promise<FixResponse> {
  const res = await apiFetch(req.path, {
    method: 'POST',
    ...(req.body !== undefined
      ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body) }
      : {}),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body: body && typeof body === 'object' ? body : {} };
}

/** The catalog_fixes document, or null before the fixer's first run. */
export async function fetchCatalogFixes(): Promise<CatalogFixes | null> {
  const res = await apiFetch('/api/commerce/catalog_fixes');
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(res.status === 503 ? 'Hermes is unreachable' : `Failed: ${res.status}`);
  return res.json();
}
