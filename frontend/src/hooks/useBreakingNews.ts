import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchBreakingNews, resolveBreakingNewsAudioSrc } from '../lib/api';
import type { BreakingNewsAlert } from '../lib/api';

const POLL_MS = 60 * 1000;

/**
 * Latest breaking_news_monitor alert, if any. Distinct from the digest
 * hooks -- there's no "today's alert" to fall back to, so `alert` is
 * genuinely null (not loading, not error) whenever the operator hasn't
 * fired since it was last checked. Polls rather than fetching once since
 * a new alert can land at any point during the session.
 */
export function useBreakingNews() {
  const [alert, setAlert] = useState<BreakingNewsAlert | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const load = useCallback(async () => {
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

  return { alert, audioUrl, audioRef, loading, playing, toggleAudio, setPlaying };
}
