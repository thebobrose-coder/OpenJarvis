import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { POLL_MS, fetchWaiting, type Waiting } from './waiting-api';

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
}

const WaitingContext = createContext<WaitingState | null>(null);

/**
 * One poll of /api/waiting every 60 s, shared by the bell and the Dashboard's
 * "Waiting on you" panel so their counts always match (hq 0020 P1). Keeps the
 * last good copy on a failed poll. Also holds the Decisions drawer's and the
 * G1 drawer's open state, which either surface can open.
 */
export function WaitingProvider({ children }: { children: ReactNode }) {
  const [waiting, setWaiting] = useState<Waiting | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [receivedAt, setReceivedAt] = useState(() => Date.now());
  const [decisionsOpen, setDecisionsOpen] = useState(false);
  const [g1Open, setG1Open] = useState<string | null>(null);

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

  const value = useMemo(
    () => ({ waiting, error, loading, receivedAt, refresh, decisionsOpen, setDecisionsOpen, g1Open, setG1Open }),
    [waiting, error, loading, receivedAt, refresh, decisionsOpen, g1Open],
  );
  return <WaitingContext.Provider value={value}>{children}</WaitingContext.Provider>;
}

export function useWaiting(): WaitingState {
  const ctx = useContext(WaitingContext);
  if (!ctx) throw new Error('useWaiting needs a WaitingProvider (Layout mounts one)');
  return ctx;
}
