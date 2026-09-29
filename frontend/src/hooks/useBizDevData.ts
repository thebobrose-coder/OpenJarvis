import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BD_FEEDS,
  BOARD_STAGES,
  SUPPRESSION_STAGES,
  fetchBizDevFeed,
  moveProspect,
  recheckProspect,
  researchMore,
  type BdFeedName,
  type BdPipeline,
  type BizDevFeeds,
  type BoardStage,
  type PipelineLine,
  type PipelineProspect,
  type StageAction,
} from '../lib/bizdev-api';

const PIPELINE_POLL_MS = 2 * 60 * 1000;
// Hermes's bd-requests job runs every 2 minutes; check back after one pass.
const RECHECK_MS = 150 * 1000;
// A move the pipeline still doesn't show after this is treated as lost.
const GIVE_UP_MS = 10 * 60 * 1000;
export const RECHECK_DAILY_CAP = 5;

export interface FeedState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

export type BizDevFeedStates = { [F in BdFeedName]: FeedState<BizDevFeeds[F]> };

export interface PendingMove {
  stage: StageAction;
  at: number;
  /** For a follow-up marked sent: the touch number it records. */
  touch?: number;
}

const isSuppression = (s: string) => (SUPPRESSION_STAGES as readonly string[]).includes(s);

/**
 * One line's board as the operator should see it: the pipeline with local,
 * not-yet-applied moves on top. A prospect moved to a suppression stage
 * leaves the board and counts toward `suppressed_count`.
 */
export function applyMoves(
  line: PipelineLine | undefined,
  pending: Record<number, PendingMove>,
): { stages: Record<BoardStage, PipelineProspect[]>; suppressed: number; followUps: PipelineLine['follow_ups_due'] } {
  const stages = Object.fromEntries(BOARD_STAGES.map((s) => [s, [] as PipelineProspect[]])) as Record<
    BoardStage,
    PipelineProspect[]
  >;
  if (!line) return { stages, suppressed: 0, followUps: [] };
  let suppressed = line.suppressed_count ?? 0;
  for (const stage of BOARD_STAGES) {
    for (const p of line.stages?.[stage] ?? []) {
      const move = pending[p.id];
      if (!move || move.touch) {
        stages[stage].push(p);
      } else if (isSuppression(move.stage)) {
        suppressed += 1;
      } else {
        const to = move.stage as BoardStage;
        stages[to].push({ ...p, stage: to, days_in_stage: 0 });
      }
    }
  }
  const followUps = (line.follow_ups_due ?? []).filter((f) => pending[f.prospect_id]?.touch !== f.touch);
  return { stages, suppressed, followUps };
}

/** Drop local moves the pipeline now shows; give up on very old ones. */
export function reconcileMoves(
  pipeline: BdPipeline,
  pending: Record<number, PendingMove>,
  now: number,
): { pending: Record<number, PendingMove>; lost: number[] } {
  const where = new Map<number, BoardStage>();
  const followUps = new Set<string>();
  for (const line of pipeline.lines) {
    for (const stage of BOARD_STAGES) for (const p of line.stages?.[stage] ?? []) where.set(p.id, stage);
    for (const f of line.follow_ups_due ?? []) followUps.add(`${f.prospect_id}:${f.touch}`);
  }
  const next: Record<number, PendingMove> = {};
  const lost: number[] = [];
  for (const [key, move] of Object.entries(pending)) {
    const id = Number(key);
    const stage = where.get(id);
    const applied = move.touch
      ? !followUps.has(`${id}:${move.touch}`)
      : isSuppression(move.stage)
        ? stage === undefined
        : stage === move.stage;
    if (applied) continue;
    if (now - move.at > GIVE_UP_MS) {
      lost.push(id);
      continue;
    }
    next[id] = move;
  }
  return { pending: next, lost };
}

// Re-check cap bookkeeping: Hermes allows 5 a day; the count is kept in this
// browser only, and a refusal from the bridge also disables the button.
function recheckKey(): string {
  return `bizdev-rechecks-${new Date().toISOString().slice(0, 10)}`;
}

function readRechecks(): number {
  try {
    return Number(localStorage.getItem(recheckKey()) ?? 0) || 0;
  } catch {
    return 0;
  }
}

const EMPTY: FeedState<never> = { data: null, loading: true, error: null };

export function useBizDevData() {
  const [feeds, setFeeds] = useState<BizDevFeedStates>(
    () => Object.fromEntries(BD_FEEDS.map((f) => [f, EMPTY])) as unknown as BizDevFeedStates,
  );
  const [pending, setPending] = useState<Record<number, PendingMove>>({});
  const [rechecksToday, setRechecksToday] = useState(readRechecks);
  const [recheckBlocked, setRecheckBlocked] = useState(false);
  const [researchStatus, setResearchStatus] = useState<'idle' | 'queued' | 'error'>('idle');
  const [notice, setNotice] = useState<string | null>(null);

  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const timers = useRef<number[]>([]);

  const loadFeed = useCallback(async (feed: BdFeedName) => {
    try {
      const data = await fetchBizDevFeed(feed);
      setFeeds((prev) => ({ ...prev, [feed]: { data, loading: false, error: null } }));
      if (feed === 'bd_pipeline' && data) {
        const { pending: next, lost } = reconcileMoves(data as BdPipeline, pendingRef.current, Date.now());
        setPending(next);
        if (lost.length) {
          setNotice(`${lost.length} change${lost.length > 1 ? 's were' : ' was'} not applied by Hermes; try again.`);
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

  // One fetch per feed on load; then only the pipeline polls.
  useEffect(() => {
    BD_FEEDS.forEach((f) => void loadFeed(f));
    const poll = window.setInterval(() => void loadFeed('bd_pipeline'), PIPELINE_POLL_MS);
    const pendingTimers = timers.current;
    return () => {
      window.clearInterval(poll);
      pendingTimers.forEach((t) => window.clearTimeout(t));
    };
  }, [loadFeed]);

  const move = useCallback(
    async (id: number, stage: StageAction, note = '', touch?: number) => {
      setPending((p) => ({ ...p, [id]: { stage, at: Date.now(), ...(touch ? { touch } : {}) } }));
      try {
        await moveProspect(id, stage, note);
        later(RECHECK_MS, () => void loadFeed('bd_pipeline'));
      } catch (e: unknown) {
        setPending((p) => {
          const next = { ...p };
          delete next[id];
          return next;
        });
        setNotice(e instanceof Error ? e.message : 'Stage change failed.');
      }
    },
    [later, loadFeed],
  );

  const recheck = useCallback(
    async (id: number) => {
      try {
        await recheckProspect(id);
        const n = readRechecks() + 1;
        try {
          localStorage.setItem(recheckKey(), String(n));
        } catch {
          /* per-browser convenience only */
        }
        setRechecksToday(n);
        setNotice('Re-check queued; Hermes re-researches it within a few minutes.');
        later(RECHECK_MS, () => void loadFeed('bd_pipeline'));
      } catch (e: unknown) {
        setRecheckBlocked(true);
        setNotice(e instanceof Error ? e.message : 'Re-check failed.');
      }
    },
    [later, loadFeed],
  );

  const research = useCallback(async () => {
    setResearchStatus('queued');
    try {
      await researchMore();
    } catch (e: unknown) {
      setResearchStatus('error');
      setNotice(e instanceof Error ? e.message : 'Research request failed.');
    }
  }, []);

  return {
    feeds,
    pending,
    move,
    recheck,
    recheckDisabled: recheckBlocked || rechecksToday >= RECHECK_DAILY_CAP,
    rechecksToday,
    research,
    researchStatus,
    notice,
    clearNotice: () => setNotice(null),
  };
}
