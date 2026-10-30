import { useEffect, useRef } from 'react';

/** The voice's face (hq 0023 follow-up): state, never a count. */
export type OrbMood = 'offline' | 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'muted' | 'rendering';

type Hue = 'accent' | 'purple' | 'muted';

export interface OrbPreset {
  hue: Hue;
  /** Halo strength, 0 for none. */
  glow: number;
  /** Seconds per breath or pulse; 0 is still. */
  period: number;
  /** How far the pulse swells the sphere, as a fraction of its radius. */
  swell: number;
  /** Blob orbit speed, radians a second. */
  drift: number;
  /** Sphere opacity. */
  alpha: number;
  ripple?: boolean;
  bar?: boolean;
  sweep?: boolean;
}

const IDLE: OrbPreset = { hue: 'accent', glow: 0.45, period: 6, swell: 0.08, drift: 0.6, alpha: 0.9 };

export const PRESETS: Record<OrbMood, OrbPreset> = {
  offline: { hue: 'muted', glow: 0, period: 0, swell: 0, drift: 0, alpha: 0.4 },
  idle: IDLE,
  listening: { hue: 'accent', glow: 0.7, period: 0, swell: 0, drift: 1, alpha: 1, ripple: true },
  transcribing: { hue: 'purple', glow: 0.55, period: 0.9, swell: 0.04, drift: 3, alpha: 1 },
  thinking: { hue: 'purple', glow: 0.55, period: 2.2, swell: 0.07, drift: 3, alpha: 1 },
  speaking: { hue: 'accent', glow: 0.8, period: 0.4, swell: 0.1, drift: 1.2, alpha: 1 },
  muted: { hue: 'muted', glow: 0, period: 0, swell: 0, drift: 0, alpha: 0.7, bar: true },
  // A voice render is running: idle's drawing with a purple sweep round the rim.
  rendering: { ...IDLE, sweep: true },
};

export const HUE_VAR: Record<Hue, string> = {
  accent: '--color-accent',
  purple: '--color-accent-purple',
  muted: '--color-text-tertiary',
};

export const moodVar = (mood: OrbMood): string => HUE_VAR[PRESETS[mood].hue];

interface Palette {
  accent: string;
  purple: string;
  muted: string;
  glow: string;
}

function readPalette(): Palette {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    accent: v(HUE_VAR.accent, '#22d3ee'),
    purple: v(HUE_VAR.purple, '#b794ff'),
    muted: v(HUE_VAR.muted, '#71717a'),
    glow: v('--color-accent-glow', 'rgba(34, 211, 238, 0.3)'),
  };
}

/** A CSS colour (#rgb, #rrggbb, rgb() or rgba()) at the given opacity. */
export function withAlpha(color: string, a: number): string {
  const hex = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
    const n = parseInt(h, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  const rgb = color.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/i);
  if (rgb) return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${a * (rgb[4] ? Number(rgb[4]) : 1)})`;
  return color;
}

export const SIZE = 32;
const C = SIZE / 2;
const R = 9;
const TAU = Math.PI * 2;

/** One frame at `t` seconds, in CSS pixels. */
export function drawOrb(ctx: CanvasRenderingContext2D, mood: OrbMood, pal: Palette, t: number): void {
  const p = PRESETS[mood];
  const base = pal[p.hue];
  const beat = p.period > 0 ? 0.5 + 0.5 * Math.sin((TAU * t) / p.period) : 0;
  const r = R * (1 + p.swell * (beat - 0.5));
  // The breath also brightens and dims the sphere and its halo.
  const lift = p.period > 0 ? 0.7 + 0.3 * beat : 1;
  ctx.clearRect(0, 0, SIZE, SIZE);

  if (p.glow > 0) {
    const halo = p.hue === 'accent' ? pal.glow : withAlpha(base, 0.3);
    const reach = r + 2 + 5 * p.glow * (p.period > 0 ? 0.4 + 0.6 * beat : 1);
    const g = ctx.createRadialGradient(C, C, r * 0.8, C, C, reach);
    g.addColorStop(0, withAlpha(halo, Math.min(1, (0.6 + p.glow * 0.4) * lift)));
    g.addColorStop(1, withAlpha(halo, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(C, C, reach, 0, TAU);
    ctx.fill();
  }

  // The sphere: lit from the upper left.
  const body = ctx.createRadialGradient(C - r * 0.35, C - r * 0.4, r * 0.1, C, C, r);
  body.addColorStop(0, withAlpha(base, 0.75 * p.alpha * lift));
  body.addColorStop(1, withAlpha(base, 0.3 * p.alpha * lift));
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(C, C, r, 0, TAU);
  ctx.fill();

  // Drifting blobs inside it.
  ctx.save();
  ctx.beginPath();
  ctx.arc(C, C, r, 0, TAU);
  ctx.clip();
  for (let i = 0; i < 3; i++) {
    const a = t * p.drift * (i % 2 ? -1 : 1) + (i * TAU) / 3;
    const orbit = r * (0.35 + 0.1 * i);
    ctx.fillStyle = withAlpha(base, 0.35 * p.alpha);
    ctx.beginPath();
    ctx.arc(C + Math.cos(a) * orbit, C + Math.sin(a) * orbit, r * 0.5, 0, TAU);
    ctx.fill();
  }
  ctx.restore();

  ctx.lineWidth = 1;
  ctx.strokeStyle = withAlpha(base, 0.75 * p.alpha);
  ctx.beginPath();
  ctx.arc(C, C, r, 0, TAU);
  ctx.stroke();

  if (p.ripple) {
    const k = t % 1;
    ctx.strokeStyle = withAlpha(base, 0.6 * (1 - k));
    ctx.beginPath();
    ctx.arc(C, C, r + k * 6, 0, TAU);
    ctx.stroke();
  }
  if (p.bar) {
    const d = r * 0.7;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = pal.muted;
    ctx.beginPath();
    ctx.moveTo(C - d, C + d);
    ctx.lineTo(C + d, C - d);
    ctx.stroke();
  }
  if (p.sweep) {
    const a = (t * TAU) / 3;
    ctx.lineWidth = 2;
    ctx.strokeStyle = withAlpha(pal.purple, 0.9);
    ctx.beginPath();
    ctx.arc(C, C, r + 1, a, a + Math.PI / 2);
    ctx.stroke();
  }
}

export interface LoopDeps {
  raf: (cb: (ts: number) => void) => number;
  caf: (id: number) => void;
  now: () => number;
  reducedMotion: () => boolean;
  hidden: () => boolean;
}

export const FPS = 30;
/** The loop sleeps once the window has been out of focus this long. */
export const BLUR_SLEEP_MS = 10_000;

/** The frame loop: at most 30 frames a second, asleep while the page is
 * hidden or long unfocused, one still frame under reduced motion. */
export class OrbLoop {
  private frame: number | null = null;
  private last = -Infinity;
  private blurredAt: number | null = null;

  constructor(
    private readonly draw: (t: number) => void,
    private readonly deps: LoopDeps,
  ) {}

  get running(): boolean {
    return this.frame !== null;
  }

  private asleep(): boolean {
    return this.deps.hidden() || (this.blurredAt !== null && this.deps.now() - this.blurredAt > BLUR_SLEEP_MS);
  }

  /** Start, or draw the one still frame; called on mount and on every mood change. */
  start(): void {
    if (this.deps.reducedMotion()) {
      this.stop();
      this.draw(this.deps.now() / 1000);
      return;
    }
    if (this.frame !== null || this.asleep()) return;
    this.frame = this.deps.raf(this.tick);
  }

  private tick = (ts: number): void => {
    this.frame = null;
    if (this.asleep()) return;
    if (ts - this.last >= 1000 / FPS - 1) {
      this.last = ts;
      this.draw(ts / 1000);
    }
    this.frame = this.deps.raf(this.tick);
  };

  blur(): void {
    this.blurredAt = this.deps.now();
  }

  focus(): void {
    this.blurredAt = null;
    this.start();
  }

  stop(): void {
    if (this.frame !== null) this.deps.caf(this.frame);
    this.frame = null;
  }
}

/** The orb: a 32 px Canvas 2D drawing of `mood`. */
export function Orb({ mood }: { mood: OrbMood }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const moodRef = useRef(mood);
  const loopRef = useRef<OrbLoop | null>(null);
  moodRef.current = mood;

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = SIZE * dpr;
    canvas.height = SIZE * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    let palette = readPalette();
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    const scheme = window.matchMedia('(prefers-color-scheme: dark)');
    const loop = new OrbLoop((t) => drawOrb(ctx, moodRef.current, palette, t), {
      raf: (cb) => window.requestAnimationFrame(cb),
      caf: (id) => window.cancelAnimationFrame(id),
      now: () => performance.now(),
      reducedMotion: () => reduce.matches,
      hidden: () => document.hidden,
    });
    loopRef.current = loop;

    // Colours: read once, and again when the theme changes (the system
    // scheme, or the app's own light/dark class on <html>).
    const repaint = () => {
      palette = readPalette();
      loop.start();
    };
    const classes = new MutationObserver(repaint);
    classes.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    scheme.addEventListener('change', repaint);
    const onMotion = () => (reduce.matches ? loop.start() : (loop.stop(), loop.start()));
    reduce.addEventListener('change', onMotion);
    // Asleep only after a real blur event: WebView2 can report no focus at
    // load while the window has it, and then no focus event ever comes.
    // Any pointer or key input in the window wakes it as well.
    const onVisible = () => !document.hidden && loop.start();
    const onBlur = () => loop.blur();
    const onFocus = () => loop.focus();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    window.addEventListener('pointerdown', onFocus);
    window.addEventListener('keydown', onFocus);
    loop.start();
    return () => {
      loop.stop();
      loopRef.current = null;
      classes.disconnect();
      scheme.removeEventListener('change', repaint);
      reduce.removeEventListener('change', onMotion);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('pointerdown', onFocus);
      window.removeEventListener('keydown', onFocus);
    };
  }, []);

  // A new mood: the running loop picks it up; a still orb redraws once.
  useEffect(() => {
    loopRef.current?.start();
  }, [mood]);

  return (
    <canvas
      ref={ref}
      width={SIZE}
      height={SIZE}
      data-orb-mood={mood}
      aria-hidden="true"
      style={{ width: SIZE, height: SIZE, display: 'block' }}
    />
  );
}
