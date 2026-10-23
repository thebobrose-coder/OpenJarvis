import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CONTENT_FEEDS,
  approveProposal,
  fetchContentFeed,
  markPrompt,
  rejectProposal,
  researchMore,
  runIntake,
  sendSeed,
  verifyProduct,
  type ApprovalEdits,
  type ContentFeedName,
  type ContentFeeds,
  type ContentProposals,
  type PromptAction,
  type Proposal,
  type SeedBody,
  type ThesisPrompt,
} from '../lib/content-api';
import { isRefusal } from '../components/Content/format';

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
  /** The proposal's note when approved, so a new "edit refused" note stands out. */
  priorNote?: string | null;
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
    // The approve body's names, as the feed will show them (v1.14).
    const { video_asset_key, motion_brief, ...edits } = approved ? d.edits ?? {} : {};
    moved.push({
      ...p,
      ...edits,
      ...(motion_brief !== undefined ? { motion_brief: motion_brief || null } : {}),
      ...(video_asset_key !== undefined ? { video_key: video_asset_key || null } : {}),
      status: approved ? 'approved' : 'rejected',
      decided_at: new Date(d.at).toISOString(),
      note: approved ? d.edits?.note ?? null : d.note ?? null,
    });
  }
  const prompts = (feed.thesis_prompts ?? []).filter((t) => !local[t.id]);
  return { pending, recent: [...moved, ...(feed.recent_decided ?? [])], prompts };
}

/** Drop local decisions the feed now shows; give up on very old ones. An
 * approval whose edit Hermes refused stays pending with a new "edit refused"
 * note (v1.10): drop it at once and report the note. */
export function reconcileDecisions(
  feed: ContentProposals,
  local: Record<string, PendingDecision>,
  now: number,
): { pending: Record<string, PendingDecision>; lost: string[]; refused: string[] } {
  const notes = new Map((feed.pending ?? []).map((p) => [p.id, p.note ?? null]));
  const open = new Set([...notes.keys(), ...(feed.thesis_prompts ?? []).map((t) => t.id)]);
  const next: Record<string, PendingDecision> = {};
  const lost: string[] = [];
  const refused: string[] = [];
  for (const [id, d] of Object.entries(local)) {
    if (!open.has(id)) continue; // applied: no longer pending / open
    const note = notes.get(id);
    if (d.action === 'approve' && isRefusal(note) && note !== (d.priorNote ?? null)) {
      refused.push(note as string);
      continue;
    }
    if (now - d.at > GIVE_UP_MS) {
      lost.push(id);
      continue;
    }
    next[id] = d;
  }
  return { pending: next, lost, refused };
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
  const [seededPrompts, setSeededPrompts] = useState<string[]>([]);
  const [intakeStatus, setIntakeStatus] = useState<'idle' | 'running' | 'started' | 'ran_recently' | 'error'>('idle');
  const [intakeAvailableAt, setIntakeAvailableAt] = useState<number | null>(null);

  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const proposalsRef = useRef(feeds.content_proposals.data);
  proposalsRef.current = feeds.content_proposals.data;
  const timers = useRef<number[]>([]);

  const loadFeed = useCallback(async (feed: ContentFeedName) => {
    try {
      const data = await fetchContentFeed(feed);
      setFeeds((prev) => ({ ...prev, [feed]: { data, loading: false, error: null } }));
      if (feed === 'content_proposals' && data) {
        const { pending: next, lost, refused } = reconcileDecisions(data as ContentProposals, pendingRef.current, Date.now());
        setPending(next);
        if (refused.length) {
          setNotice(`Hermes refused the edit, so the proposal is still pending: ${refused[0].replace(/^edit refused:\s*/i, '')}`);
        } else if (lost.length) {
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
      decide(
        id,
        {
          action: 'approve',
          at: Date.now(),
          edits,
          priorNote: proposalsRef.current?.pending?.find((p) => p.id === id)?.note ?? null,
        },
        () => approveProposal(id, edits),
        'Approve',
      ),
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

  // v1.16: the operator's own seed. Errors go back to the composer, which shows them.
  const queueSeed = useCallback(
    async (body: SeedBody) => {
      const proposalId = await sendSeed(body);
      const promptId = body.source_prompt_id;
      if (promptId) setSeededPrompts((s) => (s.includes(promptId) ? s : [...s, promptId]));
      reloadAfterAction();
      return proposalId;
    },
    [reloadAfterAction],
  );

  const intake = useCallback(async () => {
    setIntakeStatus('running');
    try {
      const { started, availableAt } = await runIntake();
      setIntakeStatus(started ? 'started' : 'ran_recently');
      setIntakeAvailableAt(availableAt);
      // Re-enable the button when the cooldown ends; the result arrives with Hermes's next sync.
      later(Math.max(0, availableAt - Date.now()) + 500, () => setIntakeAvailableAt(null));
      reloadAfterAction();
    } catch (e: unknown) {
      setIntakeStatus('error');
      setNotice(e instanceof Error ? e.message : 'Intake run failed.');
    }
  }, [later, reloadAfterAction]);

  return {
    feeds,
    pending,
    queueSeed,
    verifyProduct,
    runIntake: intake,
    intakeStatus,
    intakeAvailableAt,
    seededPrompts,
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
