/**
 * A short two-note alert chime, synthesised with Web Audio so no sound file
 * ships with the app. The stack-health dock plays it once when a run turns
 * red (hq 0017 A2 D6). Silent where Web Audio is unavailable.
 */
let ctx: AudioContext | null = null;

export function playChime(): void {
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    ctx = ctx ?? new Ctor();
    void ctx.resume?.();
    const start = ctx.currentTime + 0.02;
    [880, 660].forEach((freq, i) => {
      const t = start + i * 0.18;
      const osc = ctx!.createOscillator();
      const gain = ctx!.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      osc.connect(gain).connect(ctx!.destination);
      osc.start(t);
      osc.stop(t + 0.4);
    });
  } catch {
    // A chime is a courtesy; the red strip is the alert.
  }
}
