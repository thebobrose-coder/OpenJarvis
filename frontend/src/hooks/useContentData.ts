import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CONTENT_FEEDS,
  approveProposal,
  fetchContentFeed,
  markPrompt,
  rejectProposal,
  researchMore,
  type ApprovalEdits,
  type ContentFeedName,
  type ContentFeeds,
  type ContentProposals,
  type PromptAction,
  type Proposal,
  type ThesisPrompt,
} from '../lib/content-api';

const PROPOSALS_POLL_MS = 2 * 60 * 1000;
// Hermes's content-requests job runs every 2 minutes; check back after one pass.
const RECHECK_MS = 150 * 1000;
// A decision the feed still doesn't show after this is treated as lost.
const GIVE_UP_MS = 10 * 60 * 1000;
// "Research more": Hermes allows one extra ideation run a day.
export const RESEARCH_LOCK_MS = 24 * 3600 * 1000;
const RESEARCH_KEY = 'content-research-at';

export interface FeedState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

export type ContentFeedStates = { [F in ContentFeedName]: FeedState<ContentFeeds[F]> };

export interface PendingDecision {
  action: 'approve' | 'reject' | PromptAction;
  at: number;
  note?: string;
  edits?: ApprovalEdits;
}

/**
 * The proposals as the operator should see them: local, not-yet-applied
 * decisions move a proposal from `pending` to the top of `recent`, and hide
 * a thesis prompt once it's marked.
 */
export function applyDecisions(
  feed: ContentProposals | null,
  local: Record<string, PendingDecision>,
): { pending: Proposal[]; recent: Proposal[]; prompts: ThesisPrompt[] } {
  if (!feed) return { pending: [], recent: [], prompts: [] };
  const pending: Proposal[] = [];
  const moved: Proposal[] = [];
  for (const p of feed.pending ?? []) {
    const d = local[p.id];
    if (!d) {
      pending.push(p);
      continue;
    }
    const approved = d.action === 'approve';
    moved.push({
      ...p,
      ...(approved ? d.edits ?? {} : {}),
      status: approved ? 'approved' : 'rejected',
      decided_at: new Date(d.at).toISOString(),
      note: approved ? d.edits?.note ?? null : d.note ?? null,
    });
  }
  const prompts = (feed.thesis_prompts ?? []).filter((t) => !local[t.id]);
  return { pending, recent: [...moved, ...(feed.recent_decided ?? [])], prompts };
}

/** Drop local decisions the feed now shows; give up on very old ones. */
export function reconcileDecisions(
  feed: ContentProposals,
  local: Record<string, PendingDecision>,
  now: number,
): { pending: Record<string, PendingDecision>; lost: string[] } {
  const open = new Set([...(feed.pending ?? []).map((p) => p.id), ...(feed.thesis_prompts ?? []).map((t) => t.id)]);
  const next: Record<string, PendingDecision> = {};
  const lost: string[] = [];
  for (const [id, d] of Object.entries(local)) {
    if (!open.has(id)) continue; // applied: no longer pending / open
    if (now - d.at > GIVE_UP_MS) {
      lost.push(id);
      continue;
    }
    next[id] = d;
  }
  return { pending: next, lost };
}

function readResearchAt(): number | null {
  try {
    const at = Number(localStorage.getItem(RESEARCH_KEY));
    return at && Date.now() - at < RESEARCH_LOCK_MS ? at : null;
  } catch {
    return null;
  }
}

const EMPTY: FeedState<never> = { data: null, loading: true, error: null };

export function useContentData() {
  const [feeds, setFeeds] = useState<ContentFeedStates>(
    () => Object.fromEntries(CONTENT_FEEDS.map((f) => [f, EMPTY])) as unknown as ContentFeedStates,
  );
  const [pending, setPending] = useState<Record<string, PendingDecision>>({});
  const [researchAt, setResearchAt] = useState<number | null>(readResearchAt);
  const [researchStatus, setResearchStatus] = useState<'idle' | 'queued' | 'error'>('idle');
  const [notice, setNotice] = useState<string | null>(null);

  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const timers = useRef<number[]>([]);

  const loadFeed = useCallback(async (feed: ContentFeedName) => {
    try {
      const data = await fetchContentFeed(feed);
      setFeeds((prev) => ({ ...prev, [feed]: { data, loading: false, error: null } }));
      if (feed === 'content_proposals' && data) {
        const { pending: next, lost } = reconcileDecisions(data as ContentProposals, pendingRef.current, Date.now());
        setPending(next);
        if (lost.length) {
          setNotice(`${lost.length} decision${lost.length > 1 ? 's were' : ' was'} not applied by Hermes; try again.`);
        }
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Failed to load.';
      setFeeds((prev) => ({ ...prev, [feed]: { ...prev[feed], loading: false, error: message } }));
    }
  }, []);

  const later = useCallback((ms: number, fn: () => void) => {
    timers.current.push(window.setTimeout(fn, ms));
  }, []);

  // After an action, Hermes rewrites the proposals and the seedbank.
  const reloadAfterAction = useCallback(() => {
    later(RECHECK_MS, () => {
      void loadFeed('content_proposals');
      void loadFeed('content_seedbank');
    });
  }, [later, loadFeed]);

  // One fetch per feed on load; then only the proposals poll.
  useEffect(() => {
    CONTENT_FEEDS.forEach((f) => void loadFeed(f));
    const poll = window.setInterval(() => void loadFeed('content_proposals'), PROPOSALS_POLL_MS);
    const pendingTimers = timers.current;
    return () => {
      window.clearInterval(poll);
      pendingTimers.forEach((t) => window.clearTimeout(t));
    };
  }, [loadFeed]);

  const decide = useCallback(
    async (id: string, decision: PendingDecision, send: () => Promise<void>, what: string) => {
      setPending((p) => ({ ...p, [id]: decision }));
      try {
        await send();
        reloadAfterAction();
      } catch (e: unknown) {
        setPending((p) => {
          const next = { ...p };
          delete next[id];
          return next;
        });
        setNotice(e instanceof Error ? e.message : `${what} failed.`);
      }
    },
    [reloadAfterAction],
  );

  const approve = useCallback(
    (id: string, edits: ApprovalEdits = {}) =>
      decide(id, { action: 'approve', at: Date.now(), edits }, () => approveProposal(id, edits), 'Approve'),
    [decide],
  );

  const reject = useCallback(
    (id: string, note = '') =>
      decide(id, { action: 'reject', at: Date.now(), note: note.trim() || undefined }, () => rejectProposal(id, note), 'Reject'),
    [decide],
  );

  const prompt = useCallback(
    (id: string, action: PromptAction) => decide(id, { action, at: Date.now() }, () => markPrompt(id, action), 'Prompt update'),
    [decide],
  );

  const research = useCallback(async () => {
    setResearchStatus('queued');
    const at = Date.now();
    try {
      await researchMore();
      try {
        localStorage.setItem(RESEARCH_KEY, String(at));
      } catch {
        /* per-browser convenience only */
      }
      setResearchAt(at);
      reloadAfterAction();
    } catch (e: unknown) {
      setResearchStatus('error');
      setNotice(e instanceof Error ? e.message : 'Research request failed.');
    }
  }, [reloadAfterAction]);

  return {
    feeds,
    pending,
    approve,
    reject,
    prompt,
    research,
    researchStatus,
    researchAvailableAt: researchAt ? researchAt + RESEARCH_LOCK_MS : null,
    notice,
    clearNotice: () => setNotice(null),
  };
}
