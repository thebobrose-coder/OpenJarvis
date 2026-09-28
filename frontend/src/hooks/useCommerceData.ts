import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FEED_NAMES,
  decideRecommendation,
  fetchCommerceFeed,
  requestCommerceRefresh,
  type BriefingFocus,
  type CommerceFeeds,
  type Decision,
  type EcomRecommendations,
  type FeedName,
  type LedgerItem,
  type RefreshTarget,
} from '../lib/commerce-api';

const LEDGER_POLL_MS = 5 * 60 * 1000;
// Hermes's ecom_requests job runs every 2 minutes; check back after one pass.
const LEDGER_RECHECK_MS = 150 * 1000;
// A refresh regenerates in a few minutes; an SEO audit takes longer.
const REFRESH_RECHECK_MS: Record<RefreshTarget, number> = {
  ecom_daily: 150 * 1000,
  ecom_briefing: 240 * 1000,
  ecom_briefing_products: 240 * 1000,
  ecom_briefing_growth: 240 * 1000,
  ecom_briefing_technical: 240 * 1000,
  ecom_seo_health: 8 * 60 * 1000,
};
// A decision the ledger still doesn't show after this is treated as lost.
const DECISION_GIVE_UP_MS = 10 * 60 * 1000;

export interface FeedState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

export type FeedStates = { [F in FeedName]: FeedState<CommerceFeeds[F]> };

export type RefreshStatus = 'idle' | 'queued' | 'updated' | 'unchanged' | 'error';

export interface PendingDecision {
  decision: Decision;
  note: string;
  at: number;
}

const FEED_OF: Record<RefreshTarget, FeedName> = {
  ecom_daily: 'ecom_daily',
  ecom_seo_health: 'ecom_seo_health',
  ecom_briefing: 'ecom_briefing',
  ecom_briefing_products: 'ecom_briefing',
  ecom_briefing_growth: 'ecom_briefing',
  ecom_briefing_technical: 'ecom_briefing',
};

/** What identifies "a new run" for a refresh target. */
function refreshMarker(target: RefreshTarget, feeds: FeedStates): string | undefined {
  if (target.startsWith('ecom_briefing_')) {
    const focus = target.replace('ecom_briefing_', '') as BriefingFocus;
    return feeds.ecom_briefing.data?.sections?.[focus]?.run_at;
  }
  return feeds[FEED_OF[target]].data?.generated_at;
}

/**
 * The ledger as the operator should see it: server state with local,
 * not-yet-recorded decisions applied on top. A decided item leaves `open`
 * and shows first in `recent`, carrying the local status and note.
 */
export function applyDecisions(
  ledger: EcomRecommendations | null,
  pending: Record<string, PendingDecision>,
): { open: LedgerItem[]; recent: LedgerItem[] } {
  if (!ledger) return { open: [], recent: [] };
  const byId = new Map<string, LedgerItem>();
  for (const item of [...ledger.open, ...ledger.recent_decided]) byId.set(item.id, item);

  const local: LedgerItem[] = Object.entries(pending)
    .filter(([id]) => byId.has(id))
    .sort(([, a], [, b]) => b.at - a.at)
    .map(([id, p]) => ({
      ...byId.get(id)!,
      status: p.decision,
      note: p.note || null,
      decided_at: new Date(p.at).toISOString(),
    }));
  const localIds = new Set(local.map((i) => i.id));

  const open = ledger.open
    .filter((i) => !localIds.has(i.id))
    .sort((a, b) => a.priority - b.priority || b.created_at.localeCompare(a.created_at));
  const recent = [...local, ...ledger.recent_decided.filter((i) => !localIds.has(i.id))];
  return { open, recent };
}

/** Drop local decisions the server now shows; give up on very old ones. */
export function reconcileDecisions(
  ledger: EcomRecommendations,
  pending: Record<string, PendingDecision>,
  now: number,
): { pending: Record<string, PendingDecision>; lost: string[] } {
  const server = new Map<string, LedgerItem>();
  for (const item of [...ledger.open, ...ledger.recent_decided]) server.set(item.id, item);
  const next: Record<string, PendingDecision> = {};
  const lost: string[] = [];
  for (const [id, p] of Object.entries(pending)) {
    const item = server.get(id);
    if (item && item.status === p.decision) continue; // recorded
    if (!item) continue; // no longer in the feed's lists: recorded and aged out
    if (now - p.at > DECISION_GIVE_UP_MS) {
      lost.push(id);
      continue;
    }
    next[id] = p;
  }
  return { pending: next, lost };
}

const EMPTY: FeedState<never> = { data: null, loading: true, error: null };

export function useCommerceData() {
  const [feeds, setFeeds] = useState<FeedStates>(
    () => Object.fromEntries(FEED_NAMES.map((f) => [f, EMPTY])) as unknown as FeedStates,
  );
  const [pending, setPending] = useState<Record<string, PendingDecision>>({});
  const [refreshStatus, setRefreshStatus] = useState<Partial<Record<RefreshTarget, RefreshStatus>>>({});
  const [notice, setNotice] = useState<string | null>(null);

  const feedsRef = useRef(feeds);
  feedsRef.current = feeds;
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const timers = useRef<number[]>([]);

  const loadFeed = useCallback(async (feed: FeedName) => {
    try {
      const data = await fetchCommerceFeed(feed);
      setFeeds((prev) => ({ ...prev, [feed]: { data, loading: false, error: null } }));
      if (feed === 'ecom_recommendations' && data) {
        const { pending: next, lost } = reconcileDecisions(
          data as EcomRecommendations,
          pendingRef.current,
          Date.now(),
        );
        setPending(next);
        if (lost.length) {
          setNotice(`${lost.length} decision${lost.length > 1 ? 's were' : ' was'} not recorded by Hermes; try again.`);
        }
      }
      return data;
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Failed to load.';
      setFeeds((prev) => ({ ...prev, [feed]: { ...prev[feed], loading: false, error: message } }));
      return undefined;
    }
  }, []);

  const later = useCallback((ms: number, fn: () => void) => {
    timers.current.push(window.setTimeout(fn, ms));
  }, []);

  // One fetch per feed on load; then only the ledger polls.
  useEffect(() => {
    FEED_NAMES.forEach((f) => void loadFeed(f));
    const poll = window.setInterval(() => void loadFeed('ecom_recommendations'), LEDGER_POLL_MS);
    const pendingTimers = timers.current;
    return () => {
      window.clearInterval(poll);
      pendingTimers.forEach((t) => window.clearTimeout(t));
    };
  }, [loadFeed]);

  const refresh = useCallback(
    async (target: RefreshTarget) => {
      const before = refreshMarker(target, feedsRef.current);
      setRefreshStatus((s) => ({ ...s, [target]: 'queued' }));
      try {
        await requestCommerceRefresh(target);
      } catch {
        setRefreshStatus((s) => ({ ...s, [target]: 'error' }));
        return;
      }
      later(REFRESH_RECHECK_MS[target], async () => {
        await loadFeed(FEED_OF[target]);
        const after = refreshMarker(target, feedsRef.current);
        setRefreshStatus((s) => ({ ...s, [target]: after && after !== before ? 'updated' : 'unchanged' }));
      });
    },
    [later, loadFeed],
  );

  const decide = useCallback(
    async (id: string, decision: Decision, note: string) => {
      setPending((p) => ({ ...p, [id]: { decision, note: note.trim(), at: Date.now() } }));
      try {
        await decideRecommendation(id, decision, note);
        later(LEDGER_RECHECK_MS, () => void loadFeed('ecom_recommendations'));
      } catch (e: unknown) {
        setPending((p) => {
          const next = { ...p };
          delete next[id];
          return next;
        });
        setNotice(e instanceof Error ? e.message : 'Decision failed.');
      }
    },
    [later, loadFeed],
  );

  return { feeds, pending, refreshStatus, refresh, decide, notice, clearNotice: () => setNotice(null) };
}

export type CommerceData = ReturnType<typeof useCommerceData>;
