import { useCallback, useEffect, useRef, useState } from 'react';
import { playChime } from '../lib/chime';
import {
  StackHealthError,
  ageNow,
  fetchStackHealth,
  headline,
  noticeOnly,
  runAndWait,
  shouldChime,
  stackLevel,
  type StackHealth,
  type StackLevel,
} from '../lib/stack-api';

const POLL_MS = 10 * 60 * 1000;
const TICK_MS = 60 * 1000;
const PULSE_MS = 10 * 1000;
const CHIMED_KEY = 'openjarvis-stack-health-chimed';

function loadChimed(): string | null {
  try {
    return localStorage.getItem(CHIMED_KEY);
  } catch {
    return null;
  }
}

function saveChimed(ranAt: string) {
  try {
    localStorage.setItem(CHIMED_KEY, ranAt);
  } catch {
    /* per-browser convenience only */
  }
}

export type RunState = 'idle' | 'running' | 'timeout' | 'error';

/**
 * The stack-health file, polled every 10 min (the `useBreakingNews` shape):
 * keeps the last good copy, derives the dock's level and headline, and
 * chimes once when a run turns red. A 404 means the check has never run
 * (`missing`); any other failure with no copy yet is `error`, which the dock
 * shows as a muted line -- it never blocks the sidebar.
 */
export function useStackHealth() {
  const [health, setHealth] = useState<StackHealth | null>(null);
  const [receivedAt, setReceivedAt] = useState(() => Date.now());
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [pulse, setPulse] = useState(false);
  const [run, setRun] = useState<{ state: RunState; detail: string | null }>({ state: 'idle', detail: null });
  const previous = useRef<StackLevel | null>(null);

  const accept = useCallback((h: StackHealth) => {
    setHealth(h);
    setReceivedAt(Date.now());
    setMissing(false);
    setError(null);
  }, []);

  const load = useCallback(async () => {
    setNow(Date.now());
    try {
      accept(await fetchStackHealth());
    } catch (e) {
      if (e instanceof StackHealthError && e.status === 404) {
        setHealth(null);
        setMissing(true);
        setError(null);
      } else {
        setError(e instanceof Error ? e.message : 'Stack health unavailable');
      }
    }
  }, [accept]);

  useEffect(() => {
    load();
    const poll = setInterval(load, POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [load]);

  const age = health ? ageNow(health, receivedAt, now) : null;
  const level: StackLevel = health ? stackLevel(health, age) : 'unavailable';
  const ranAt = health?.ran_at ?? null;

  useEffect(() => {
    if (shouldChime(previous.current, level, ranAt, loadChimed())) {
      saveChimed(ranAt!);
      playChime();
      setPulse(true);
      const id = setTimeout(() => setPulse(false), PULSE_MS);
      previous.current = level;
      return () => clearTimeout(id);
    }
    previous.current = level;
  }, [level, ranAt]);

  const runNow = useCallback(async () => {
    setRun({ state: 'running', detail: null });
    try {
      const fresh = await runAndWait(ranAt);
      if (fresh) {
        accept(fresh);
        setNow(Date.now());
        setRun({ state: 'idle', detail: null });
      } else {
        setRun({ state: 'timeout', detail: 'No new run after 2 minutes' });
      }
    } catch (e) {
      setRun({ state: 'error', detail: e instanceof Error ? e.message : 'Run failed' });
    }
  }, [ranAt, accept]);

  return {
    health,
    age,
    level,
    headline: health ? headline(health) : '',
    noticeOnly: noticeOnly(health, age),
    missing,
    error,
    pulse,
    now,
    run,
    runNow,
  };
}
