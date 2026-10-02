/**
 * Catalog fixes: Hermes's proposed product-copy fixes and the operator's
 * decisions on them (hq/contracts/openjarvis-hermes.md v1.3 §2, "Catalog
 * fixes", through v1.3.3). The feed is proxied like the other ecom feeds; the
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
  addresses: { finding_ids: string[]; rec_ids: string[] };
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
  /** Decisions and, from P2, the writer's outcomes (`refused`,
   * `failed_apply`, `revert_blocked`) with their reasons. */
  history: { status: string; at: string; note?: string | null; reason?: string | null }[];
  applied: { at: string; snapshot_id: string } | null;
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
  tier: number;
  /** v1.3.3 (A11): streak ≥ 20, verified ≥ 20, nothing reverted or failed. */
  eligible: boolean;
  /** v1.3.3 (A11): the writer's outcomes, as patch counts. */
  applied?: number;
  verified?: number;
  failed_verify?: number;
  reverted?: number;
  /** v1.3.3 (A9): while the class has P1 approvals to re-confirm. */
  spot_check?: { confirmed: number; required: number; passed: boolean } | null;
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
  };
  counts: Partial<Record<FixStatus, number>>;
  patches: Patch[];
  classes: ClassStats[];
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
      return ['confirm'];
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
