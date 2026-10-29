import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { contextBlock } from './desks-api';
import { useAppStore } from './store';
import type { RowActions } from '../components/Waiting/WaitingListView';
import {
  POLL_MS,
  dismissOrder,
  dispatchRow,
  fetchWaiting,
  fixRec,
  rowKey,
  snoozeRec,
  type RowStatus,
  type Waiting,
  type WaitingItem,
} from './waiting-api';

interface WaitingState {
  waiting: Waiting | null;
  error: string | null;
  loading: boolean;
  /** When the copy arrived, so ages count on between polls. */
  receivedAt: number;
  refresh: () => Promise<void>;
  decisionsOpen: boolean;
  setDecisionsOpen: (open: boolean) => void;
  /** The G1 row whose drawer is open, by approval id. */
  g1Open: string | null;
  setG1Open: (id: string | null) => void;
  /** The bell's dropdown, the full list; the Dashboard's "N more" opens it. */
  bellOpen: boolean;
  setBellOpen: (open: boolean) => void;
  /** The work-order report drawer: one order's id, or '*' for every report. */
  reportOpen: string | null;
  setReportOpen: (id: string | null) => void;
  /** Each acted-on row's state, by `kind:id`, shared by the bell and the panel. */
  rowStatus: Record<string, RowStatus>;
  dispatch: (item: WaitingItem) => void;
  snooze: (item: WaitingItem, days: number) => void;
  /** Fix it (0024 J1) and Dismiss (J4). */
  fix: (item: WaitingItem) => void;
  dismiss: (item: Pick<WaitingItem, 'kind' | 'id'>, note: string) => Promise<boolean>;
  /** Every row action at once, for the bell and the panel. */
  rowActions: RowActions;
}

const WaitingContext = createContext<WaitingState | null>(null);

/** A row as a Commerce desk thread's context: the row as listed (0023 D2). */
export function rowContext(item: WaitingItem): { block: string; label: string } {
  const block = contextBlock({
    page: item.link?.page ?? '/commerce',
    kind: item.kind === 'rec' ? 'recommendation' : item.kind,
    id: item.id,
    store: item.scope,
    title: item.title,
    detail: item.detail,
    created_at: item.created_at,
    link: item.link,
  });
  const title = item.title.length > 40 ? `${item.title.slice(0, 40)}…` : item.title;
  return { block, label: `${item.kind === 'rec' ? 'recommendation' : item.kind} “${title}”` };
}

/**
 * One poll of /api/waiting every 60 s, shared by the bell and the Dashboard's
 * "Waiting on you" panel so their counts always match (hq 0020 P1). Keeps the
 * last good copy on a failed poll. Also holds the drawers' open state, which
 * either surface can open, and the row actions: Dispatch and Snooze (hq 0023),
 * Fix it and Dismiss (hq 0024). None is ever retried; a row shows what came
 * back.
 */
export function WaitingProvider({ children }: { children: ReactNode }) {
  const [waiting, setWaiting] = useState<Waiting | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [receivedAt, setReceivedAt] = useState(() => Date.now());
  const [decisionsOpen, setDecisionsOpen] = useState(false);
  const [g1Open, setG1Open] = useState<string | null>(null);
  const [bellOpen, setBellOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState<string | null>(null);
  const [rowStatus, setRowStatus] = useState<Record<string, RowStatus>>({});
  const navigate = useNavigate();
  const openDeskThread = useAppStore((s) => s.openDeskThread);

  const refresh = useCallback(async () => {
    try {
      const w = await fetchWaiting();
      setWaiting(w);
      setReceivedAt(Date.now());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  const mark = useCallback((item: WaitingItem, s: RowStatus) => setRowStatus((m) => ({ ...m, [rowKey(item)]: s })), []);
  const fail = (e: unknown) => ({ kind: 'error' as const, message: e instanceof Error ? e.message : String(e) });

  const dispatch = useCallback(
    (item: WaitingItem) => {
      // A desk target writes nothing: the row goes to the Commerce desk as context.
      if (item.delegate?.target === 'desk') {
        setBellOpen(false);
        openDeskThread('commerce', rowContext(item));
        navigate('/');
        return;
      }
      mark(item, { kind: 'busy' });
      dispatchRow(item).then(
        (r) => {
          mark(item, { kind: 'dispatched', orderId: r.order_id, waits: r.waits_for_tomorrow, decided: r.decided, decideError: r.decide_error });
          void refresh();
        },
        (e) => mark(item, fail(e)),
      );
    },
    [mark, navigate, openDeskThread, refresh],
  );

  const snooze = useCallback(
    (item: WaitingItem, days: number) => {
      mark(item, { kind: 'busy' });
      snoozeRec(item.id, days).then(
        () => {
          mark(item, { kind: 'snoozed', days });
          void refresh();
        },
        (e) => mark(item, fail(e)),
      );
    },
    [mark, refresh],
  );

  const fix = useCallback(
    (item: WaitingItem) => {
      mark(item, { kind: 'busy' });
      fixRec(item.id).then(
        () => {
          mark(item, { kind: 'fixed' });
          void refresh();
        },
        (e) => mark(item, fail(e)),
      );
    },
    [mark, refresh],
  );

  /** Resolves true once written, so the report drawer can reload. */
  const dismiss = useCallback(
    (item: Pick<WaitingItem, 'kind' | 'id'>, note: string) => {
      const key = { kind: item.kind, id: item.id } as WaitingItem;
      mark(key, { kind: 'busy' });
      return dismissOrder(String(item.id), note).then(
        () => {
          mark(key, { kind: 'dismissed' });
          void refresh();
          return true;
        },
        (e) => {
          mark(key, fail(e));
          return false;
        },
      );
    },
    [mark, refresh],
  );

  const rowActions = useMemo<RowActions>(
    () => ({
      status: rowStatus,
      onDispatch: dispatch,
      onSnooze: snooze,
      onFix: fix,
      onDismiss: (item, note) => void dismiss(item, note),
      onNavigate: (href) => {
        setBellOpen(false);
        navigate(href);
      },
    }),
    [rowStatus, dispatch, snooze, fix, dismiss, navigate],
  );

  const value = useMemo(
    () => ({
      waiting,
      error,
      loading,
      receivedAt,
      refresh,
      decisionsOpen,
      setDecisionsOpen,
      g1Open,
      setG1Open,
      bellOpen,
      setBellOpen,
      reportOpen,
      setReportOpen,
      rowStatus,
      dispatch,
      snooze,
      fix,
      dismiss,
      rowActions,
    }),
    [waiting, error, loading, receivedAt, refresh, decisionsOpen, g1Open, bellOpen, reportOpen, rowStatus, dispatch, snooze, fix, dismiss, rowActions],
  );
  return <WaitingContext.Provider value={value}>{children}</WaitingContext.Provider>;
}

export function useWaiting(): WaitingState {
  const ctx = useContext(WaitingContext);
  if (!ctx) throw new Error('useWaiting needs a WaitingProvider (Layout mounts one)');
  return ctx;
}
