import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BLUR_SLEEP_MS, drawOrb, FPS, HUE_VAR, moodVar, Orb, OrbLoop, PRESETS, withAlpha, type LoopDeps, type OrbMood } from './Orb';

const MOODS: OrbMood[] = ['offline', 'idle', 'listening', 'transcribing', 'thinking', 'speaking', 'muted', 'rendering'];

/** A hand-cranked requestAnimationFrame. */
function rig(over: Partial<LoopDeps> = {}) {
  let next = 1;
  const pending = new Map<number, (ts: number) => void>();
  const s = { now: 0, hidden: false, reduced: false, draws: [] as number[], cancelled: [] as number[] };
  const deps: LoopDeps = {
    raf: (cb) => {
      const id = next++;
      pending.set(id, cb);
      return id;
    },
    caf: (id) => {
      s.cancelled.push(id);
      pending.delete(id);
    },
    now: () => s.now,
    reducedMotion: () => s.reduced,
    hidden: () => s.hidden,
    ...over,
  };
  const loop = new OrbLoop((t) => s.draws.push(t), deps);
  /** Run the pending frame at `ms`. */
  const step = (ms: number) => {
    s.now = ms;
    const [id, cb] = [...pending.entries()][0] ?? [];
    if (id === undefined) return false;
    pending.delete(id);
    cb!(ms);
    return true;
  };
  return { s, loop, step, pending };
}

describe('orb presets', () => {
  it('every mood has a preset and a colour variable from the theme', () => {
    for (const m of MOODS) {
      expect(PRESETS[m]).toBeDefined();
      expect(Object.values(HUE_VAR)).toContain(moodVar(m));
    }
    expect(moodVar('idle')).toBe('--color-accent');
    expect(moodVar('listening')).toBe('--color-accent');
    expect(moodVar('speaking')).toBe('--color-accent');
    expect(moodVar('thinking')).toBe('--color-accent-purple');
    expect(moodVar('transcribing')).toBe('--color-accent-purple');
    expect(moodVar('muted')).toBe('--color-text-tertiary');
    expect(moodVar('offline')).toBe('--color-text-tertiary');
  });

  it('offline and muted are still with no glow; muted has the bar, rendering the sweep, listening the ripple', () => {
    expect(PRESETS.offline).toMatchObject({ glow: 0, period: 0, drift: 0 });
    expect(PRESETS.muted).toMatchObject({ glow: 0, period: 0, bar: true });
    expect(PRESETS.rendering.sweep).toBe(true);
    expect(PRESETS.listening.ripple).toBe(true);
    expect(PRESETS.idle.period).toBe(6);
    // Speaking pulses at 2 to 3 Hz; thinking pulses slower than transcribing.
    expect(1 / PRESETS.speaking.period).toBeGreaterThanOrEqual(2);
    expect(1 / PRESETS.speaking.period).toBeLessThanOrEqual(3);
    expect(PRESETS.thinking.period).toBeGreaterThan(PRESETS.transcribing.period);
  });

  it('applies opacity to hex and rgb colours', () => {
    expect(withAlpha('#22d3ee', 0.5)).toBe('rgba(34, 211, 238, 0.5)');
    expect(withAlpha('#fff', 1)).toBe('rgba(255, 255, 255, 1)');
    expect(withAlpha('rgba(34, 211, 238, 0.3)', 0.5)).toBe('rgba(34, 211, 238, 0.15)');
    expect(withAlpha('rgb(1, 2, 3)', 0.2)).toBe('rgba(1, 2, 3, 0.2)');
  });

  it('draws every mood without throwing (a recording 2D context)', () => {
    const calls: string[] = [];
    const ctx = new Proxy(
      {},
      {
        get: (_t, k) =>
          k === 'createRadialGradient' ? () => ({ addColorStop: () => {} }) : (..._a: unknown[]) => void calls.push(String(k)),
        set: () => true,
      },
    ) as unknown as CanvasRenderingContext2D;
    const pal = { accent: '#22d3ee', purple: '#b794ff', muted: '#5c5c63', glow: 'rgba(34, 211, 238, 0.3)' };
    for (const m of MOODS) drawOrb(ctx, m, pal, 1.25);
    expect(calls).toContain('arc');
    expect(calls).toContain('clearRect');
  });

  it('server-renders a 32 px canvas with its mood', () => {
    const html = renderToStaticMarkup(<Orb mood="idle" />);
    expect(html).toContain('<canvas');
    expect(html).toContain('width="32"');
    expect(html).toContain('data-orb-mood="idle"');
  });
});

describe('orb loop', () => {
  it('draws at most 30 frames a second', () => {
    const { s, loop, step } = rig();
    loop.start();
    for (let ms = 0; ms <= 1000; ms += 1000 / 120) step(ms); // a 120 Hz display
    expect(s.draws.length).toBeGreaterThanOrEqual(FPS - 1);
    expect(s.draws.length).toBeLessThanOrEqual(FPS + 1);
  });

  it('reduced motion: one frame per start, and no loop scheduled', () => {
    const { s, loop, pending } = rig();
    s.reduced = true;
    loop.start();
    expect(s.draws).toHaveLength(1);
    expect(pending.size).toBe(0);
    expect(loop.running).toBe(false);
    loop.start(); // a mood change
    expect(s.draws).toHaveLength(2);
    expect(pending.size).toBe(0);
  });

  it('stops while the document is hidden, and starts again when shown', () => {
    const { s, loop, step } = rig();
    loop.start();
    step(0);
    s.hidden = true;
    const before = s.draws.length;
    step(100);
    expect(loop.running).toBe(false);
    expect(s.draws.length).toBe(before);
    loop.start(); // still hidden: stays asleep
    expect(loop.running).toBe(false);
    s.hidden = false;
    loop.start();
    expect(loop.running).toBe(true);
  });

  it('sleeps after 10 s out of focus, and wakes on focus', () => {
    const { s, loop, step } = rig();
    loop.start();
    loop.blur();
    step(BLUR_SLEEP_MS - 1);
    expect(loop.running).toBe(true);
    step(BLUR_SLEEP_MS + 1);
    expect(loop.running).toBe(false);
    s.now = BLUR_SLEEP_MS + 5000;
    loop.focus();
    expect(loop.running).toBe(true);
  });

  it('unmount (stop) cancels the pending frame', () => {
    const { s, loop, pending } = rig();
    loop.start();
    expect(pending.size).toBe(1);
    loop.stop();
    expect(s.cancelled).toHaveLength(1);
    expect(pending.size).toBe(0);
    expect(loop.running).toBe(false);
  });

  it('a second start while running schedules nothing more', () => {
    const { loop, pending } = rig();
    loop.start();
    loop.start();
    expect(pending.size).toBe(1);
  });
});
