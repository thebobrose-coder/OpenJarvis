/**
 * One shared player for the assistant's voice: the Listen panel's queue and the
 * panels' speaker buttons all go through it, so only one thing speaks at a
 * time and "Play all" can walk a playlist. Nothing plays until the operator
 * presses play (hq 0009 default). Played state is kept per browser.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { prepareBlock, voiceAudioSrc, type SpeechFeed } from './voice-api';

export interface PlayRequest {
  feed: SpeechFeed;
  id: string;
  title: string;
}

interface VoicePlayerValue {
  /** Block id currently loaded (playing or paused), if any. */
  current: string | null;
  playing: boolean;
  /** Block id being prepared (a fast-lane render can take a while). */
  preparing: string | null;
  error: string | null;
  played: ReadonlySet<string>;
  /** Play this block, or pause/resume it if it's the current one. */
  toggle: (req: PlayRequest) => void;
  /** Play these blocks in order, starting from the first. */
  playAll: (reqs: PlayRequest[]) => void;
  stop: () => void;
}

const PLAYED_KEY = 'openjarvis-voice-played';
const PLAYED_MAX = 300;

function loadPlayed(): Set<string> {
  try {
    const raw = localStorage.getItem(PLAYED_KEY);
    const ids = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function savePlayed(ids: Set<string>) {
  try {
    localStorage.setItem(PLAYED_KEY, JSON.stringify([...ids].slice(-PLAYED_MAX)));
  } catch {
    /* per-browser convenience only */
  }
}

const noop = () => {};
const Ctx = createContext<VoicePlayerValue>({
  current: null,
  playing: false,
  preparing: null,
  error: null,
  played: new Set(),
  toggle: noop,
  playAll: noop,
  stop: noop,
});

export const useVoicePlayer = () => useContext(Ctx);

export function VoicePlayerProvider({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playlist = useRef<PlayRequest[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [preparing, setPreparing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [played, setPlayed] = useState<Set<string>>(() => (typeof window === 'undefined' ? new Set() : loadPlayed()));

  const markPlayed = useCallback((id: string) => {
    setPlayed((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev).add(id);
      savePlayed(next);
      return next;
    });
  }, []);

  const start = useCallback(async (req: PlayRequest) => {
    const el = audioRef.current;
    if (!el) return;
    setError(null);
    setPreparing(req.id);
    try {
      const src = await voiceAudioSrc(await prepareBlock(req.feed, req.id));
      if (!src) throw new Error('No audio for this item yet');
      // One voice at a time: pause anything else on the page (e.g. the digest player).
      document.querySelectorAll('audio').forEach((a) => a !== el && a.pause());
      el.src = src;
      setCurrent(req.id);
      await el.play();
    } catch (e: any) {
      setError(e?.message ?? 'Playback failed');
      setPlaying(false);
      playlist.current = [];
    } finally {
      setPreparing(null);
    }
  }, []);

  const toggle = useCallback(
    (req: PlayRequest) => {
      const el = audioRef.current;
      if (!el) return;
      playlist.current = [];
      if (current === req.id && el.src) {
        if (el.paused) el.play().catch(() => setPlaying(false));
        else el.pause();
        return;
      }
      void start(req);
    },
    [current, start],
  );

  const playAll = useCallback(
    (reqs: PlayRequest[]) => {
      if (!reqs.length) return;
      playlist.current = reqs.slice(1);
      void start(reqs[0]);
    },
    [start],
  );

  const stop = useCallback(() => {
    playlist.current = [];
    audioRef.current?.pause();
  }, []);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => {
      setPlaying(false);
      if (current) markPlayed(current);
      const next = playlist.current.shift();
      if (next) void start(next);
    };
    el.addEventListener('play', onPlay);
    el.addEventListener('pause', onPause);
    el.addEventListener('ended', onEnded);
    return () => {
      el.removeEventListener('play', onPlay);
      el.removeEventListener('pause', onPause);
      el.removeEventListener('ended', onEnded);
    };
  }, [current, markPlayed, start]);

  return (
    <Ctx.Provider value={{ current, playing, preparing, error, played, toggle, playAll, stop }}>
      {children}
      <audio ref={audioRef} preload="none" style={{ display: 'none' }} />
    </Ctx.Provider>
  );
}
