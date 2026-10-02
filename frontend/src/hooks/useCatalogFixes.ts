import { useCallback, useEffect, useRef, useState } from 'react';
import {
  approveClassRequest,
  fetchCatalogFixes,
  fixRequest,
  postFix,
  type CatalogFixes,
  type FixAction,
  type FixClass,
  type FixRequest,
  type FixResponse,
  type FixStatus,
  type Patch,
} from '../lib/fixes-api';

const POLL_MS = 2 * 60 * 1000;
// Hermes's fix-requests job runs every 2 minutes; check back after one pass.
const RECHECK_MS = 150 * 1000;
// A decision the feed still doesn't show after this is treated as lost.
const GIVE_UP_MS = 10 * 60 * 1000;

/** A decision sent but not yet shown by the feed. */
export interface PendingFix {
  action: FixAction;
  at: number;
  /** The patch as it was when decided; any change means Hermes recorded it. */
  fromStatus: FixStatus;
  fromSha: string;
}

export type Outcome =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; message: string; reloaded: boolean };

export const CHANGED_MESSAGE = 'This fix changed since you opened it.';

/** What a bridge answer means for the operator. A 409 means the card is out
 * of date, so the feed is reloaded before saying so. */
export async function runDecision(
  req: FixRequest,
  post: (r: FixRequest) => Promise<FixResponse>,
  reload: () => Promise<unknown>,
): Promise<Outcome> {
  let res: FixResponse;
  try {
    res = await post(req);
  } catch {
    return { ok: false, message: 'Couldn’t reach OpenJarvis’s server.', reloaded: false };
  }
  if (res.status === 202) return { ok: true, body: res.body };
  if (res.status === 409) {
    await reload();
    const reason = res.body.reason;
    const message =
      reason === 'changed'
        ? CHANGED_MESSAGE
        : reason === 'not_applied'
          ? 'Nothing to revert: this fix was never applied.'
          : 'This fix was already decided, or a decision on it is still being recorded.';
    return { ok: false, message, reloaded: true };
  }
  if (res.status === 401) return { ok: false, message: 'The bridge refused the operator token.', reloaded: false };
  const detail = typeof res.body.detail === 'string' ? res.body.detail : `Failed: ${res.status}`;
  return { ok: false, message: detail, reloaded: false };
}

/** Drop pending decisions the feed now shows; give up on very old ones. */
export function reconcileFixes(
  feed: CatalogFixes,
  pending: Record<string, PendingFix>,
  now: number,
): { pending: Record<string, PendingFix>; lost: number } {
  const byId = new Map(feed.patches.map((p) => [p.id, p]));
  const next: Record<string, PendingFix> = {};
  let lost = 0;
  for (const [id, p] of Object.entries(pending)) {
    const patch = byId.get(id);
    if (!patch || patch.status !== p.fromStatus || patch.patch_sha256 !== p.fromSha) continue;
    if (now - p.at > GIVE_UP_MS) {
      lost++;
      continue;
    }
    next[id] = p;
  }
  return { pending: next, lost };
}

export interface ClassResult {
  approved: string[];
  refused: { id: string; reason: string }[];
}

export function useCatalogFixes() {
  const [data, setData] = useState<CatalogFixes | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, PendingFix>>({});
  const [cardNotes, setCardNotes] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [pausedLocal, setPausedLocal] = useState<boolean | null>(null);

  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const timers = useRef<number[]>([]);

  const load = useCallback(async () => {
    try {
      const feed = await fetchCatalogFixes();
      setData(feed);
      setError(null);
      if (feed) {
        const { pending: next, lost } = reconcileFixes(feed, pendingRef.current, Date.now());
        setPending(next);
        if (lost) setNotice(`${lost} decision${lost > 1 ? 's were' : ' was'} not recorded by Hermes; try again.`);
        setPausedLocal((p) => (p === feed.paused ? null : p));
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const poll = window.setInterval(() => void load(), POLL_MS);
    const pendingTimers = timers.current;
    return () => {
      window.clearInterval(poll);
      pendingTimers.forEach((t) => window.clearTimeout(t));
    };
  }, [load]);

  const recheck = useCallback(() => {
    timers.current.push(window.setTimeout(() => void load(), RECHECK_MS));
  }, [load]);

  const markPending = useCallback((patches: Patch[], action: FixAction) => {
    const at = Date.now();
    setPending((p) => ({
      ...p,
      ...Object.fromEntries(
        patches.map((x) => [x.id, { action, at, fromStatus: x.status, fromSha: x.patch_sha256 }]),
      ),
    }));
  }, []);

  /** One decision on one patch. Resolves true when Hermes queued it. */
  const decide = useCallback(
    async (patch: Patch, action: FixAction, opts: Parameters<typeof fixRequest>[2] = {}) => {
      setCardNotes((n) => {
        const next = { ...n };
        delete next[patch.id];
        return next;
      });
      const outcome = await runDecision(fixRequest(action, patch, opts), postFix, load);
      if (outcome.ok) {
        markPending([patch], action);
        recheck();
        return true;
      }
      setCardNotes((n) => ({ ...n, [patch.id]: outcome.message }));
      return false;
    },
    [load, markPending, recheck],
  );

  const approveClass = useCallback(
    async (cls: FixClass, patches: Patch[]): Promise<ClassResult | null> => {
      const outcome = await runDecision(approveClassRequest(cls, patches), postFix, load);
      if (!outcome.ok) {
        setNotice(outcome.message);
        return null;
      }
      const result: ClassResult = {
        approved: Array.isArray(outcome.body.approved) ? (outcome.body.approved as string[]) : [],
        refused: Array.isArray(outcome.body.refused) ? (outcome.body.refused as ClassResult['refused']) : [],
      };
      const approved = new Set(result.approved);
      markPending(
        patches.filter((p) => approved.has(p.id)),
        'approve',
      );
      recheck();
      if (result.refused.length) void load();
      return result;
    },
    [load, markPending, recheck],
  );

  const setPaused = useCallback(
    async (paused: boolean) => {
      const outcome = await runDecision(
        { path: `/api/commerce/fixes/${paused ? 'pause' : 'resume'}` },
        postFix,
        load,
      );
      if (outcome.ok) {
        setPausedLocal(typeof outcome.body.paused === 'boolean' ? outcome.body.paused : paused);
        recheck();
      } else setNotice(outcome.message);
    },
    [load, recheck],
  );

  return {
    data,
    loading,
    error,
    pending,
    cardNotes,
    notice,
    clearNotice: () => setNotice(null),
    paused: pausedLocal ?? data?.paused ?? false,
    pausePending: pausedLocal !== null,
    reload: load,
    decide,
    approveClass,
    setPaused,
  };
}

export type CatalogFixesState = ReturnType<typeof useCatalogFixes>;
