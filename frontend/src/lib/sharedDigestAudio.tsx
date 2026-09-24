import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { fetchDigest, regenerateDigest, resolveDigestAudioSrc } from './api';
import type { Digest } from './api';

export interface SharedDigestAudioValue {
  digest: Digest | null;
  audioUrl: string | null;
  loading: boolean;
  error: string | null;
  regenerating: boolean;
  playing: boolean;
  regenerate: () => Promise<void>;
  toggleAudio: () => void;
}

/**
 * Factory for a shared-audio-element context bound to one digest prefix.
 * Every surface that plays a given digest's audio (e.g. a sidebar item and
 * a dashboard panel, both mounted at once) must share ONE instance of this
 * rather than each calling its own fetch+<audio> hook -- two independent
 * <audio> tags pointed at the same physical file caused a WebView2 media
 * pipeline decode error (first hit with the general digest, see
 * DailyBriefAudioContext; the culture digest has the same exposure now
 * that a sidebar "breaking news" item and the dashboard's Culture & Sports
 * panel both want its audio at the same time).
 */
export function createSharedDigestAudio(prefix: string) {
  const Ctx = createContext<SharedDigestAudioValue | null>(null);

  function Provider({ children }: { children: ReactNode }) {
    const [digest, setDigest] = useState<Digest | null>(null);
    const [audioUrl, setAudioUrl] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
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
      } catch (e: any) {
        setError(e?.message ?? 'Failed to load.');
      } finally {
        setLoading(false);
      }
    }, []);

    useEffect(() => {
      load();
    }, [load]);

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
    }, [load]);

    const toggleAudio = useCallback(() => {
      const el = audioRef.current;
      if (!el) return;
      if (playing) {
        el.pause();
        setPlaying(false);
      } else {
        el.play()
          .then(() => setPlaying(true))
          .catch((e) => {
            console.error(`[digest audio ${prefix}] playback failed:`, e, el.error);
            setPlaying(false);
            setError(`Audio playback failed: ${el.error?.message || e?.message || 'unknown error'}`);
          });
      }
    }, [playing]);

    return (
      <Ctx.Provider
        value={{ digest, audioUrl, loading, error, regenerating, playing, regenerate, toggleAudio }}
      >
        {children}
        {audioUrl && (
          <audio
            ref={audioRef}
            src={audioUrl}
            onEnded={() => setPlaying(false)}
            onPause={() => setPlaying(false)}
            style={{ display: 'none' }}
          />
        )}
      </Ctx.Provider>
    );
  }

  function useSharedDigestAudio(): SharedDigestAudioValue {
    const ctx = useContext(Ctx);
    if (!ctx) {
      throw new Error(`useSharedDigestAudio(${prefix}) must be used within its Provider`);
    }
    return ctx;
  }

  return { Provider, useSharedDigestAudio };
}
