/**
 * Catalog fixes: Hermes's proposed product-copy fixes and the operator's
 * decisions on them (hq/contracts/openjarvis-hermes.md v1.3 §2, "Catalog
 * fixes", through v1.3.2). The feed is proxied like the other ecom feeds; the decision POSTs
 * go to /api/commerce/fixes, where the backend adds the operator token. The
 * token never reaches this code. In P1 nothing is written to Shopify.
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
  history: { status: string; at: string; note?: string | null }[];
  applied: { at: string; snapshot_id: string } | null;
  verified: { at: string; by: string } | null;
  /** v1.3.2 (0011 A6): the operator approved this over a judge flag. */
  judge_overridden?: boolean;
  /** v1.3.2 (A7): the specs check dropped a figure under a judge flag, so
   * this patch is never auto-applied and stays out of class approvals. */
  review_only?: boolean;
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
  eligible: boolean;
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
  };
  counts: Partial<Record<FixStatus, number>>;
  patches: Patch[];
  classes: ClassStats[];
}

export type FixAction = 'approve' | 'edit' | 'reject' | 'revert';

/** The statuses each action is offered on (0011 §7, contract v1.3). */
export function actionsFor(status: FixStatus): FixAction[] {
  switch (status) {
    case 'proposed':
      return ['approve', 'edit', 'reject'];
    case 'invalid':
      return ['edit'];
    case 'applied':
    case 'verified':
    case 'failed-verify':
      return ['revert'];
    default:
      return [];
  }
}

export const isWaiting = (s: FixStatus) => s === 'proposed' || s === 'invalid';

/** An invalid patch whose only failed check is the judge: the operator may
 * approve it over the judge (v1.3.2, 0011 A6). The deterministic checks stay
 * binding, so any other failed check rules it out. */
export function judgeOnlyInvalid(patch: Pick<Patch, 'status' | 'validator' | 'judge'>): boolean {
  if (patch.status !== 'invalid') return false;
  const failed = patch.validator.checks.filter((c) => !c.passed);
  if (failed.length) return failed.every((c) => c.name === 'judge');
  return patch.judge?.verdict === 'finding';
}

/** The specs check's figures, by why they were dropped (0011 A4, A7):
 * `finding` ones a linked finding quotes, `judge` ones under a judge flag,
 * `unexempt` ones the check failed on. */
export interface SpecDrops {
  finding: string[];
  judge: string[];
  unexempt: string[];
}

const figures = (list: string) =>
  list
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean);

export function specDrops(patch: Pick<Patch, 'validator'>): SpecDrops {
  const out: SpecDrops = { finding: [], judge: [], unexempt: [] };
  const detail = patch.validator.checks.find((c) => c.name === 'specs')?.detail ?? '';
  for (const m of detail.matchAll(/dropped(?: under (judge flag|finding [^:;]*))?:\s*([^;]*)/g)) {
    const kind = !m[1] ? 'unexempt' : m[1] === 'judge flag' ? 'judge' : 'finding';
    out[kind].push(...figures(m[2]));
  }
  return out;
}

/** The bridge's approve-class refusal reasons (v1.3.1, plus v1.3.3's
 * `review_only`), in the operator's words. */
export const REFUSAL_REASON: Record<string, string> = {
  unknown: 'not in the feed',
  class: 'not in this class',
  status: 'already decided or still recording',
  changed: 'changed since shown',
  store_unavailable: 'store unavailable',
  review_only: 'review only: approve it on its own',
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
    case 'edit':
      return {
        path,
        body: { patch_sha256: patch.patch_sha256, changes: opts.changes ?? [], ...cleanNote(opts.note) },
      };
    default:
      return { path, body: cleanNote(opts.note) };
  }
}

export function approveClassRequest(cls: FixClass, patches: Pick<Patch, 'id' | 'patch_sha256'>[], note?: string): FixRequest {
  return {
    path: '/api/commerce/fixes/approve-class',
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
