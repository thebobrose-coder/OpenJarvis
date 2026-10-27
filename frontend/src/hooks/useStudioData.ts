import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchEpisode,
  fetchEpisodes,
  fetchStudioStatus,
  mediaUrl,
  runStudio,
  saveScript,
  savePublish,
  sendAction,
  sendG0,
  setPaused,
  type Claim,
  type EpisodeAction,
  type EpisodeDetail,
  type EpisodeSummary,
  type G0Body,
  type PublishFile,
  type StudioStatus,
} from '../lib/studio-api';
import type { EpisodeActions } from '../components/Content/EpisodeDrawer';
import type { RunStatus } from '../components/Content/EpisodesPanel';

// The studio runs every 10 minutes; a minute's poll shows a stage move soon after.
const POLL_MS = 60 * 1000;

/** The Episodes surface's data: status.json, the episode list, and one open episode. */
export function useStudioData() {
  const [status, setStatus] = useState<StudioStatus | null>(null);
  const [episodes, setEpisodes] = useState<EpisodeSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  // v0.4.5: the drawer opens on this action's confirm (a row button, a held-seed Requeue link).
  const [openAction, setOpenAction] = useState<EpisodeAction | null>(null);
  const [detail, setDetail] = useState<EpisodeDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [runStatus, setRunStatus] = useState<RunStatus>('idle');
  const [runAvailableAt, setRunAvailableAt] = useState<number | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [pausing, setPausing] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const openRef = useRef(openId);
  openRef.current = openId;
  const timers = useRef<number[]>([]);

  const load = useCallback(async () => {
    try {
      const [s, e] = await Promise.all([fetchStudioStatus(), fetchEpisodes()]);
      setStatus(s);
      setEpisodes(e);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load the studio.');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    try {
      const d = await fetchEpisode(id);
      if (openRef.current === id) {
        setDetail(d);
        setDetailError(null);
      }
    } catch (e: unknown) {
      if (openRef.current === id) setDetailError(e instanceof Error ? e.message : 'Failed to load the episode.');
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const poll = window.setInterval(() => void load(), POLL_MS);
    const pending = timers.current;
    return () => {
      window.clearInterval(poll);
      pending.forEach((t) => window.clearTimeout(t));
    };
  }, [load]);

  const open = useCallback(
    (id: string, action: EpisodeAction | null = null) => {
      setOpenId(id);
      setOpenAction(action);
      openRef.current = id;
      setDetail(null);
      setDetailError(null);
      void loadDetail(id);
    },
    [loadDetail],
  );

  const close = useCallback(() => {
    setOpenId(null);
    setOpenAction(null);
    setDetail(null);
  }, []);

  const refreshAll = useCallback(
    (id: string) => {
      void loadDetail(id);
      void load();
    },
    [load, loadDetail],
  );

  // Stable per episode: the thumbnail picker loads its blobs once.
  const loadMedia = useCallback(
    (name: string) => (openId ? mediaUrl(openId, name) : Promise.reject(new Error('No episode open.'))),
    [openId],
  );

  // Errors are thrown back to the drawer, which shows them where the operator acted.
  const actions: EpisodeActions | null = openId
    ? {
        onSaveScript: async (edit: { script?: string; claims?: Claim[] }) => {
          if (!detail) throw new Error('The episode is still loading.');
          try {
            await saveScript(openId, detail.version, edit);
          } finally {
            refreshAll(openId);
          }
        },
        onG0: async (body: G0Body) => {
          const g0 = await sendG0(openId, body);
          refreshAll(openId);
          return g0;
        },
        onSavePublish: async (body: PublishFile) => {
          await savePublish(openId, body);
          refreshAll(openId);
        },
        onAction: async (body: { action: EpisodeAction; note?: string }) => {
          const written = await sendAction(openId, body);
          refreshAll(openId);
          return written;
        },
        loadMedia,
      }
    : null;

  const run = useCallback(async () => {
    setRunStatus('running');
    setRunError(null);
    try {
      const { started, availableAt } = await runStudio();
      setRunStatus(started ? 'started' : 'ran_recently');
      setRunAvailableAt(availableAt);
      timers.current.push(window.setTimeout(() => setRunAvailableAt(null), Math.max(0, availableAt - Date.now()) + 500));
      // A run takes a while (a script pass holds the GPU for minutes): look again soon.
      timers.current.push(window.setTimeout(() => void load(), 30 * 1000));
    } catch (e: unknown) {
      // Shown beside the button: until the studio's task is registered, this is schtasks's own error.
      setRunStatus('error');
      setRunError(e instanceof Error ? e.message : 'Studio run failed.');
    }
  }, [load]);

  const pause = useCallback(
    async (propertyId: string, paused: boolean) => {
      setPausing((s) => ({ ...s, [propertyId]: true }));
      try {
        await setPaused(propertyId, paused);
        await load();
      } catch (e: unknown) {
        setNotice(e instanceof Error ? e.message : 'Pause failed.');
      } finally {
        setPausing((s) => ({ ...s, [propertyId]: false }));
      }
    },
    [load],
  );

  return {
    status,
    episodes,
    loading,
    error,
    openId,
    openAction,
    open,
    close,
    detail,
    detailLoading,
    detailError,
    actions,
    run,
    runStatus,
    runAvailableAt,
    runError,
    pause,
    pausing,
    notice,
    clearNotice: () => setNotice(null),
  };
}
