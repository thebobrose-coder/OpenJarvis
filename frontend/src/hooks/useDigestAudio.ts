import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchDigest, regenerateDigest, resolveDigestAudioSrc } from '../lib/api';
import type { Digest } from '../lib/api';

export interface UseDigestAudioOptions {
  /** Skip the automatic fetch-on-mount -- for panels (e.g. Weather) that
   * orchestrate their own load sequence alongside other data. */
  autoLoad?: boolean;
}

/**
 * Shared narration-audio state for any digest-backed panel: fetch, play/pause,
 * and regenerate against a given `/api/digest/*` prefix. Consolidates the
 * fetch/audio-resolve/toggle logic previously duplicated across
 * NewsDigestPanel, WeatherPanel, and (now) CultureNewsPanel/DailyBriefPanel/
 * the sidebar's pinned player.
 */
export function useDigestAudio(prefix: string, options: UseDigestAudioOptions = {}) {
  const { autoLoad = true } = options;
  const [digest, setDigest] = useState<Digest | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(autoLoad);
  const [error, setError] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await fetchDigest(prefix);
      setDigest(d);
      setAudioUrl(d ? await resolveDigestAudioSrc(d, prefix).catch(() => null) : null);
      setError(null);
      return d;
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load.');
      return null;
    } finally {
      setLoading(false);
    }
  }, [prefix]);

  useEffect(() => {
    if (autoLoad) load();
  }, [autoLoad, load]);

  const regenerate = useCallback(async () => {
    setRegenerating(true);
    try {
      await regenerateDigest(prefix);
      await load();
    } catch (e: any) {
      setError(e?.message ?? 'Failed to regenerate.');
    } finally {
      setRegenerating(false);
    }
  }, [prefix, load]);

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

  return {
    digest,
    audioUrl,
    audioRef,
    loading,
    error,
    regenerating,
    playing,
    load,
    regenerate,
    toggleAudio,
    setPlaying,
  };
}
