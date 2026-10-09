import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchBreakingNews, fetchRecentBreakingNews, resolveBreakingNewsAudioSrc } from '../lib/api';
import type { BreakingNewsAlert } from '../lib/api';
import { LIST_HOURS, LIST_ROWS } from '../lib/breaking-list';

const POLL_MS = 60 * 1000;

/**
 * Latest breaking-news alert (Hermes's alert feed), if any. Distinct from the digest
 * hooks -- there's no "today's alert" to fall back to, so `alert` is
 * genuinely null (not loading, not error) whenever the operator hasn't
 * fired since it was last checked. Polls rather than fetching once since
 * a new alert can land at any point during the session.
 *
 * `recent` is the last 24 h of alerts (newest first, contract v1.7) for the
 * sidebar's list, on the same poll; it carries no audio. `now` is the poll
 * time, so the list's ages and 24 h window move once a minute.
 */
export function useBreakingNews() {
  const [alert, setAlert] = useState<BreakingNewsAlert | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [recent, setRecent] = useState<BreakingNewsAlert[]>([]);
  const [recentStale, setRecentStale] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [loading, setLoading] = useState(true);
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const load = useCallback(async () => {
    setNow(Date.now());
    fetchRecentBreakingNews(LIST_HOURS, LIST_ROWS)
      .then((r) => {
        setRecent(r.alerts);
        setRecentStale(r.stale);
      })
      .catch(() => {
        // Same silence as the latest alert: keep the last list.
      });
    try {
      const a = await fetchBreakingNews();
      setAlert(a);
      setAudioUrl(a ? await resolveBreakingNewsAudioSrc(a).catch(() => null) : null);
    } catch {
      // Polling failure is silent -- this is a nice-to-have sidebar item,
      // not worth an error state that competes with the digest panels'.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, POLL_MS);
    return () => clearInterval(interval);
  }, [load]);

  const toggleAudio = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) {
      el.pause();
      setPlaying(false);
    } else {
      el.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    }
  }, [playing]);

  return { alert, recent, recentStale, now, audioUrl, audioRef, loading, playing, toggleAudio, setPlaying };
}
