import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BD_FEEDS,
  BOARD_STAGES,
  SUPPRESSION_STAGES,
  fetchBizDevFeed,
  archiveTemplate,
  fetchSendConfig,
  addContact,
  hasContact,
  moveProspect,
  saveTemplate,
  sendProspect,
  recheckProspect,
  researchMore,
  type BdFeedName,
  type BdPipeline,
  type BizDevFeeds,
  type ContactAdd,
  type BoardStage,
  type PipelineLine,
  type PipelineProspect,
  type SendConfig,
  type SendRequest,
  type SendResult,
  type StageAction,
  type TemplateSave,
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

export const MEETING_NOTE = 'meeting confirmed from the calendar match';

export const CONTACT_NOT_ACCEPTED =
  'Hermes did not accept this address (free-mail, duplicate, suppressed card or the 3-contact cap).';

/** An "Add recipient" waiting for Hermes to publish the contact. */
export interface ContactWatch {
  email: string;
  at: number;
  /** Pipeline reads since the save that came late enough to show it. */
  refreshes: number;
  state: 'saved' | 'not_accepted';
}

// Hermes applies bridge flags every 2 minutes; a read sooner than this after
// the save says nothing yet.
const CONTACT_MIN_MS = 60 * 1000;
const CONTACT_REFRESHES = 2;

/** Drop the adds the pipeline now shows; mark one "not accepted" once two
 * reads came and went without it (Hermes logs a refusal only on its side). */
export function watchContacts(
  pipeline: BdPipeline,
  watch: Record<number, ContactWatch>,
  now: number,
): { watch: Record<number, ContactWatch>; changed: boolean; failed: boolean } {
  const ids = Object.keys(watch);
  if (!ids.length) return { watch, changed: false, failed: false };
  const cards = new Map<number, PipelineProspect>();
  for (const line of pipeline.lines) for (const stage of BOARD_STAGES) for (const p of line.stages?.[stage] ?? []) cards.set(p.id, p);
  const next: Record<number, ContactWatch> = {};
  let failed = false;
  for (const key of ids) {
    const id = Number(key);
    const w = watch[id];
    if (hasContact(cards.get(id), w.email)) continue;
    if (w.state === 'not_accepted' || now - w.at < CONTACT_MIN_MS) {
      next[id] = w;
      continue;
    }
    const refreshes = w.refreshes + 1;
    const state = refreshes >= CONTACT_REFRESHES ? 'not_accepted' : 'saved';
    if (state === 'not_accepted') failed = true;
    next[id] = { ...w, refreshes, state };
  }
  return { watch: next, changed: true, failed };
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
  const [sendConfig, setSendConfig] = useState<SendConfig | null>(null);
  const [contactWatch, setContactWatch] = useState<Record<number, ContactWatch>>({});
  const contactWatchRef = useRef(contactWatch);
  contactWatchRef.current = contactWatch;

  useEffect(() => {
    void fetchSendConfig().then(setSendConfig);
  }, []);

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
        const watched = watchContacts(data as BdPipeline, contactWatchRef.current, Date.now());
        if (watched.changed) {
          setContactWatch(watched.watch);
          if (watched.failed) setNotice(CONTACT_NOT_ACCEPTED);
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

  // Send (hq 0018): the server sends and posts the `sent` flag. Touch 1 moves
  // the card to Sent locally, a follow-up leaves the strip, until Hermes
  // applies the flag; a failure undoes that and says why.
  const send = useCallback(
    async (id: number, req: SendRequest): Promise<SendResult> => {
      setPending((p) => ({ ...p, [id]: { stage: 'sent', at: Date.now(), ...(req.touch > 1 ? { touch: req.touch } : {}) } }));
      try {
        const result = await sendProspect(id, req);
        later(RECHECK_MS, () => void loadFeed('bd_pipeline'));
        return result;
      } catch (e: unknown) {
        setPending((p) => {
          const next = { ...p };
          delete next[id];
          return next;
        });
        setNotice(e instanceof Error ? e.message : 'Send failed.');
        throw e;
      }
    },
    [later, loadFeed],
  );

  // Add recipient (A3): the bridge queues it; Hermes publishes the contact
  // within a pass of bd-requests, or drops it with a reason in its own log.
  const addRecipient = useCallback(
    async (id: number, c: ContactAdd) => {
      await addContact(id, c);
      setContactWatch((w) => ({ ...w, [id]: { email: c.email.trim(), at: Date.now(), refreshes: 0, state: 'saved' } }));
      later(RECHECK_MS, () => void loadFeed('bd_pipeline'));
    },
    [later, loadFeed],
  );

  // Part D: Confirm posts the existing stage move with the calendar note and
  // leaves the board alone; the chip goes when the feed shows the move.
  const confirmMeeting = useCallback(
    async (id: number) => {
      await moveProspect(id, 'meeting', MEETING_NOTE);
      later(RECHECK_MS, () => void loadFeed('bd_pipeline'));
    },
    [later, loadFeed],
  );

  // Templates (Part C) go through the bridge; Hermes applies them within a
  // pass of bd-requests, so the pipeline is read again after one.
  const saveTpl = useCallback(
    async (t: TemplateSave) => {
      await saveTemplate(t);
      setNotice('Template saved; it shows up within about 2 minutes.');
      later(RECHECK_MS, () => void loadFeed('bd_pipeline'));
    },
    [later, loadFeed],
  );

  const archiveTpl = useCallback(
    async (id: number) => {
      await archiveTemplate(id);
      setNotice('Template archived; the list updates within about 2 minutes.');
      later(RECHECK_MS, () => void loadFeed('bd_pipeline'));
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
    send,
    sendConfig,
    addRecipient,
    contactNotes: Object.fromEntries(Object.entries(contactWatch).map(([id, w]) => [id, w.state])) as Record<number, ContactWatch['state']>,
    confirmMeeting,
    saveTemplate: saveTpl,
    archiveTemplate: archiveTpl,
    recheck,
    recheckDisabled: recheckBlocked || rechecksToday >= RECHECK_DAILY_CAP,
    rechecksToday,
    research,
    researchStatus,
    notice,
    clearNotice: () => setNotice(null),
  };
}
