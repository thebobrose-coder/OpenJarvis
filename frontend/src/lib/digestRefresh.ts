import type { Digest } from './api';

/**
 * Keeps a shared digest current while the app stays open (the Provider in
 * sharedDigestAudio.tsx used to fetch once on mount, so an app started
 * before the 06:00 run showed the overnight copy all morning). DOM-free so
 * it runs under vitest's node environment; the Provider wires it to React
 * state, the <audio> element, window and document.
 *
 * - Polls every 5 minutes, and on window focus / the page becoming visible,
 *   throttled to one event-driven fetch a minute.
 * - Applies a fetched digest only when it differs (sameDigest), so a quiet
 *   poll never resets the <audio> element or re-renders the panels.
 * - Never swaps the audio under a playing element: a newer digest waits as
 *   pending until flush() runs on pause/end.
 * - A failed background fetch keeps the last good digest silently; only the
 *   first load and operator-driven loads report errors.
 */

export const POLL_MS = 5 * 60_000;
export const EVENT_THROTTLE_MS = 60_000;

export interface DigestSnapshot {
  digest: Digest | null;
  audioUrl: string | null;
}

/** What a reload can change on screen or in the player. age_seconds is left
 * out on purpose: FeedFreshness counts forward on its own. */
export function sameDigest(a: Digest | null, b: Digest | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.generated_at === b.generated_at &&
    (a.audio_version ?? null) === (b.audio_version ?? null) &&
    a.audio_available === b.audio_available &&
    !!a.stale === !!b.stale
  );
}

/** 'initial' and 'user' report errors; 'poll' and 'event' stay silent. */
export type LoadMode = 'initial' | 'user' | 'poll' | 'event';

export interface DigestRefresherOptions {
  fetchSnapshot: () => Promise<DigestSnapshot>;
  /** Commit a changed digest (and its audio src) to state. */
  apply: (snapshot: DigestSnapshot) => void;
  /** Any successful fetch, changed or not (clears a shown error). */
  onOk: () => void;
  onError: (message: string) => void;
  isPlaying: () => boolean;
}

export interface RefresherTargets {
  win: EventTarget;
  doc: EventTarget & { visibilityState?: string };
}

export function createDigestRefresher(opts: DigestRefresherOptions) {
  let current: Digest | null = null;
  let pending: DigestSnapshot | null = null;
  let seq = 0;
  let lastFetchAt = -Infinity;
  let disposed = false;
  let teardown: (() => void) | null = null;

  function commit(snapshot: DigestSnapshot) {
    current = snapshot.digest;
    pending = null;
    opts.apply(snapshot);
  }

  async function load(mode: LoadMode): Promise<void> {
    const mine = ++seq;
    lastFetchAt = Date.now();
    let snapshot: DigestSnapshot;
    try {
      snapshot = await opts.fetchSnapshot();
    } catch (e: any) {
      if (!disposed && (mode === 'initial' || mode === 'user')) {
        opts.onError(e?.message ?? 'Failed to load.');
      }
      return;
    }
    // A later load superseded this one, or the Provider unmounted.
    if (disposed || mine !== seq) return;
    opts.onOk();
    if (mode === 'initial') {
      commit(snapshot);
      return;
    }
    if (sameDigest(snapshot.digest, current)) {
      pending = null;
      return;
    }
    if (opts.isPlaying()) {
      pending = snapshot;
      return;
    }
    commit(snapshot);
  }

  function onEvent() {
    if (Date.now() - lastFetchAt < EVENT_THROTTLE_MS) return;
    void load('event');
  }

  return {
    load,

    /** Initial load, then the 5-minute poll and the focus/visibility hooks. */
    start(targets?: RefresherTargets): Promise<void> {
      // StrictMode runs effects twice (start, stop, start): revive here.
      disposed = false;
      const first = load('initial');
      const timer = setInterval(() => void load('poll'), POLL_MS);
      const onVisibility = () => {
        if (targets?.doc.visibilityState === 'visible') onEvent();
      };
      targets?.win.addEventListener('focus', onEvent);
      targets?.doc.addEventListener('visibilitychange', onVisibility);
      teardown = () => {
        clearInterval(timer);
        targets?.win.removeEventListener('focus', onEvent);
        targets?.doc.removeEventListener('visibilitychange', onVisibility);
      };
      return first;
    },

    /** Apply a digest held back during playback. Call on pause/end. */
    flush() {
      if (pending && !disposed && !opts.isPlaying()) commit(pending);
    },

    stop() {
      disposed = true;
      teardown?.();
      teardown = null;
    },
  };
}
