import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Digest } from './api';
import {
  createDigestRefresher,
  EVENT_THROTTLE_MS,
  POLL_MS,
  sameDigest,
  type DigestSnapshot,
} from './digestRefresh';

// Invented text only: this repo is public.
function digest(over: Partial<Digest> = {}): Digest {
  return {
    text: 'Overnight copy.',
    sections: {},
    sources_used: [],
    generated_at: '2026-10-09T07:30:00Z',
    model_used: 'm',
    voice_used: 'v',
    audio_available: true,
    audio_path: null,
    audio_version: null,
    age_seconds: 60,
    stale: false,
    ...over,
  };
}

function snap(d: Digest | null): DigestSnapshot {
  return { digest: d, audioUrl: d ? `/api/digest/audio?v=${d.audio_version ?? d.generated_at}` : null };
}

/** A Provider stand-in: the refresher plus the state it would set. */
function harness(first: Digest | null = digest()) {
  let next: Digest | null | Error = first;
  const state = {
    digest: null as Digest | null,
    src: null as string | null,
    error: null as string | null,
    applies: 0,
    playing: false,
  };
  const fetchSnapshot = vi.fn(async () => {
    if (next instanceof Error) throw next;
    return snap(next);
  });
  const refresher = createDigestRefresher({
    fetchSnapshot,
    apply: (s) => {
      state.digest = s.digest;
      state.src = s.audioUrl;
      state.applies += 1;
    },
    onOk: () => {
      state.error = null;
    },
    onError: (m) => {
      state.error = m;
    },
    isPlaying: () => state.playing,
  });
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  return {
    state,
    fetchSnapshot,
    refresher,
    win,
    doc,
    serve(d: Digest | null | Error) {
      next = d;
    },
    start: () => refresher.start({ win, doc }),
  };
}

const NEW_RUN = { text: 'Morning copy.', generated_at: '2026-10-09T11:00:00Z' };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse('2026-10-09T07:30:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('digest refresher', () => {
  it('fetches once on mount', async () => {
    const h = harness();
    await h.start();
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(1);
    expect(h.state.digest?.text).toBe('Overnight copy.');
  });

  it('re-fetches every 5 minutes and applies a new run', async () => {
    const h = harness();
    await h.start();
    h.serve(digest(NEW_RUN));
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(2);
    expect(h.state.digest?.text).toBe('Morning copy.');
    expect(h.state.src).toContain('2026-10-09T11:00:00Z');
  });

  it('leaves state alone when the digest is unchanged', async () => {
    const h = harness();
    await h.start();
    const src = h.state.src;
    // Same run, older age: only age_seconds moved.
    h.serve(digest({ age_seconds: 360 }));
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(2);
    expect(h.state.applies).toBe(1);
    expect(h.state.src).toBe(src);
  });

  it('applies a new audio_version for the same run', async () => {
    const h = harness();
    await h.start();
    h.serve(digest({ audio_version: 'expressive-1' }));
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(h.state.applies).toBe(2);
    expect(h.state.src).toContain('expressive-1');
  });

  it('holds a newer digest while playing, then applies it on pause', async () => {
    const h = harness();
    await h.start();
    const src = h.state.src;
    h.state.playing = true;
    h.serve(digest(NEW_RUN));
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(h.state.src).toBe(src);
    expect(h.state.digest?.text).toBe('Overnight copy.');

    // Still playing: flush does nothing.
    h.refresher.flush();
    expect(h.state.src).toBe(src);

    h.state.playing = false;
    h.refresher.flush();
    expect(h.state.src).not.toBe(src);
    expect(h.state.digest?.text).toBe('Morning copy.');
  });

  it('fetches when the page becomes visible', async () => {
    const h = harness();
    await h.start();
    await vi.advanceTimersByTimeAsync(EVENT_THROTTLE_MS + 1);
    h.doc.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(2);
  });

  it('ignores visibilitychange to hidden', async () => {
    const h = harness();
    await h.start();
    await vi.advanceTimersByTimeAsync(EVENT_THROTTLE_MS + 1);
    h.doc.visibilityState = 'hidden';
    h.doc.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(1);
  });

  it('throttles focus churn to one fetch a minute', async () => {
    const h = harness();
    await h.start();
    await vi.advanceTimersByTimeAsync(EVENT_THROTTLE_MS + 1);
    h.win.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(10_000);
    h.win.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(2);
  });

  it('keeps the last good digest when a poll fails, with no error', async () => {
    const h = harness();
    await h.start();
    h.serve(new Error('Failed: 502'));
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(2);
    expect(h.state.digest?.text).toBe('Overnight copy.');
    expect(h.state.error).toBeNull();
  });

  it('reports a failed first load, and a later good poll clears it', async () => {
    const h = harness(new Error('Failed: 502') as never);
    await h.start();
    expect(h.state.error).toBe('Failed: 502');
    h.serve(digest(NEW_RUN));
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(h.state.error).toBeNull();
    expect(h.state.digest?.text).toBe('Morning copy.');
  });

  it('reports a failed operator load', async () => {
    const h = harness();
    await h.start();
    h.serve(new Error('Failed: 500'));
    await h.refresher.load('user');
    expect(h.state.error).toBe('Failed: 500');
  });

  it('stops fetching after unmount', async () => {
    const h = harness();
    await h.start();
    h.refresher.stop();
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    h.win.dispatchEvent(new Event('focus'));
    h.doc.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(1);
  });

  it('drops a fetch that lands after unmount', async () => {
    const h = harness();
    await h.start();
    h.serve(digest(NEW_RUN));
    const late = h.refresher.load('poll');
    h.refresher.stop();
    await late;
    expect(h.state.digest?.text).toBe('Overnight copy.');
  });

  it('survives the StrictMode start, stop, start', async () => {
    const h = harness();
    void h.start();
    h.refresher.stop();
    await h.start();
    expect(h.state.digest?.text).toBe('Overnight copy.');
    await vi.advanceTimersByTimeAsync(POLL_MS);
    // Two mount fetches, then one poll: the first interval was cleared.
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(3);
  });
});

describe('sameDigest', () => {
  it('compares run, audio and stale flag, not age', () => {
    expect(sameDigest(digest(), digest({ age_seconds: 9999 }))).toBe(true);
    expect(sameDigest(digest(), digest({ generated_at: '2026-10-10T11:00:00Z' }))).toBe(false);
    expect(sameDigest(digest(), digest({ audio_version: 'x' }))).toBe(false);
    expect(sameDigest(digest(), digest({ audio_available: false }))).toBe(false);
    expect(sameDigest(digest(), digest({ stale: true }))).toBe(false);
    expect(sameDigest(null, null)).toBe(true);
    expect(sameDigest(null, digest())).toBe(false);
  });
});
