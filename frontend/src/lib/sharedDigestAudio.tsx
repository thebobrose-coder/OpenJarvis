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
import { createDigestRefresher } from './digestRefresh';

export interface SharedDigestAudioValue {
  digest: Digest | null;
  audioUrl: string | null;
  loading: boolean;
  error: string | null;
  regenerating: boolean;
  playing: boolean;
  regenerate: () => Promise<void>;
  toggleAudio: () => void;
  /** Reload the digest (it may be newer than the copy loaded at startup),
   * then play its cached audio if it has any. Used by the chat's morning
   * briefing turn. */
  playLatest: () => Promise<void>;
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
    const [playRequested, setPlayRequested] = useState(false);
    const audioRef = useRef<HTMLAudioElement | null>(null);

    const playingRef = useRef(false);
    const markPlaying = useCallback((value: boolean) => {
      playingRef.current = value;
      setPlaying(value);
    }, []);

    // See digestRefresh.ts: re-fetch while the app is open, apply only real
    // changes, and never swap the src under a playing element.
    const [refresher] = useState(() =>
      createDigestRefresher({
        fetchSnapshot: async () => {
          const d = await fetchDigest(prefix);
          return {
            digest: d,
            audioUrl: d ? await resolveDigestAudioSrc(d, prefix).catch(() => null) : null,
          };
        },
        apply: ({ digest: d, audioUrl: url }) => {
          setDigest(d);
          setAudioUrl(url);
        },
        onOk: () => setError(null),
        onError: (message) => setError(message),
        isPlaying: () => {
          const el = audioRef.current;
          return playingRef.current || (!!el && !el.paused);
        },
      }),
    );

    useEffect(() => {
      refresher.start({ win: window, doc: document }).finally(() => setLoading(false));
      return () => refresher.stop();
    }, [refresher]);

    const load = useCallback(() => refresher.load('user'), [refresher]);

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

    const startPlayback = useCallback((el: HTMLAudioElement) => {
      el.play()
        .then(() => markPlaying(true))
        .catch((e) => {
          console.error(`[digest audio ${prefix}] playback failed:`, e, el.error);
          markPlaying(false);
          setError(`Audio playback failed: ${el.error?.message || e?.message || 'unknown error'}`);
        });
    }, [markPlaying]);

    const playLatest = useCallback(async () => {
      await load();
      setPlayRequested(true);
    }, [load]);

    // Runs after load() has re-rendered <audio> with the latest src.
    useEffect(() => {
      if (!playRequested) return;
      setPlayRequested(false);
      const el = audioRef.current;
      if (el && audioUrl && el.paused) startPlayback(el);
    }, [playRequested, audioUrl, startPlayback]);

    const toggleAudio = useCallback(() => {
      const el = audioRef.current;
      if (!el) return;
      if (playing) {
        el.pause();
        markPlaying(false);
      } else {
        startPlayback(el);
      }
    }, [playing, markPlaying, startPlayback]);

    // Playback stopped: apply a digest that arrived while it was playing.
    const onStopped = useCallback(() => {
      markPlaying(false);
      refresher.flush();
    }, [markPlaying, refresher]);

    return (
      <Ctx.Provider
        value={{
          digest,
          audioUrl,
          loading,
          error,
          regenerating,
          playing,
          regenerate,
          toggleAudio,
          playLatest,
        }}
      >
        {children}
        {audioUrl && (
          <audio
            ref={audioRef}
            src={audioUrl}
            onEnded={onStopped}
            onPause={onStopped}
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
