/** Pure helpers for the Episodes panel and drawer (foundry-studio.md). */
import type { Tone } from '../shared/ui';
import { PUBLISH_LIMITS, type Claim, type G0Body, type Manifest, type PlanBeat, type PublishFile } from '../../lib/studio-api';

export const STAGE: Record<string, { label: string; tone: Tone }> = {
  queued: { label: 'queued', tone: 'neutral' },
  scripting: { label: 'scripting', tone: 'accent' },
  scripted: { label: 'scripted', tone: 'accent' },
  'awaiting-g0': { label: 'at G0', tone: 'warning' },
  'rewrite-requested': { label: 'rewrite asked', tone: 'accent' },
  narrating: { label: 'narrating', tone: 'accent' },
  visualizing: { label: 'visuals', tone: 'accent' },
  assembling: { label: 'assembling', tone: 'accent' },
  scanning: { label: 'scanning', tone: 'accent' },
  'at-g1': { label: 'at G1', tone: 'warning' },
  publishing: { label: 'publishing', tone: 'accent' },
  published: { label: 'published', tone: 'success' },
  stopped: { label: 'stopped', tone: 'error' },
  rejected: { label: 'rejected', tone: 'muted' },
};

export const stageInfo = (stage: string) => STAGE[stage] ?? { label: stage, tone: 'neutral' as Tone };

/** Stages after which publish.json no longer matters: the episode is with the pipeline. */
const SUBMITTED = new Set(['scanning', 'at-g1', 'publishing', 'published', 'rejected']);
export const publishEditable = (m: Pick<Manifest, 'stage'> & { executionArn?: string }) =>
  !SUBMITTED.has(m.stage) && !m.executionArn;

/** Episode ids are ULIDs; the "Waiting on you" G0 row links `?focus=<id>`. */
export const isEpisodeId = (id: string | null | undefined) => !!id && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id);

/**
 * The studio's quality notes for G0: they ride on the latest `scripted` stage
 * entry as "1 pass; for G0: beat 1: …; beat 6: …" (foundry-studio.md v0.1.3).
 */
export function g0Notes(m: Pick<Manifest, 'stages'>): string[] {
  const entry = [...(m.stages ?? [])].reverse().find((s) => s.stage === 'scripted');
  const note = entry?.note ?? '';
  const at = note.indexOf('for G0:');
  if (at < 0) return [];
  return note
    .slice(at + 'for G0:'.length)
    .split(/;\s*(?=beat\s+\d+:)/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The studio's refusals and waits since the current stage began (e.g. "G0 approve refused: …"). */
export function stageNotes(m: Pick<Manifest, 'stages' | 'stage'>): string[] {
  const stages = m.stages ?? [];
  let start = stages.length;
  for (let i = stages.length - 1; i >= 0; i--) {
    if (stages[i].stage !== m.stage) break;
    start = i;
  }
  return stages
    .slice(start)
    .map((s) => s.note ?? '')
    .filter(Boolean);
}

/** `script.md` beats are `## …` headings, one per planned beat. */
export const scriptSections = (script: string) => script.split(/\r?\n/).filter((l) => /^##\s/.test(l)).length;

export const needsRuling = (c: Pick<Claim, 'source'>) => c.source === 'unsourced';

export const fmtMinutes = (n: number | null | undefined) => (n == null ? '—' : `${Math.round(n * 10) / 10} min`);
export const fmtUsd = (n: number | null | undefined) => (n == null ? '—' : `$${n.toFixed(2)}`);

export function fmtBytes(n: number | null | undefined): string {
  if (n == null) return '';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
}

export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds == null) return '—';
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Tags as typed: comma-separated, trimmed, empties dropped. */
export const parseTags = (text: string) =>
  text
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

/** What stops Save on publish.json, checked as Foundry's submit checks it. */
export function publishProblems(p: PublishFile, thumbs: string[]): string[] {
  const out: string[] = [];
  const title = p.title.trim().replace(/\s+/g, ' ');
  if (title.length < PUBLISH_LIMITS.titleMin || title.length > PUBLISH_LIMITS.titleMax) {
    out.push(`The title is ${PUBLISH_LIMITS.titleMin}–${PUBLISH_LIMITS.titleMax} characters.`);
  }
  if (/[<>]/.test(p.title + p.description + p.tags.join(''))) out.push('YouTube refuses < and >.');
  if (p.description.trim().length > PUBLISH_LIMITS.description) {
    out.push(`The description is at most ${PUBLISH_LIMITS.description} characters.`);
  }
  if (p.tags.join(',').length > PUBLISH_LIMITS.tags) out.push(`Tags are at most ${PUBLISH_LIMITS.tags} characters together.`);
  if (!thumbs.includes(p.thumbnail)) out.push('Pick a thumbnail.');
  return out;
}

/**
 * The G0 decision as the drawer sends it (foundry-studio.md v0.4). Motion
 * shots are on by default per channel: an approve with the switch unticked
 * sends `motion: "off"`; ticked sends no `motion` key, so the channel default
 * applies. `omni` is never written (the studio ignores `omni: false`).
 */
export function g0Body(
  decision: G0Body['decision'],
  form: { note: string; motion: boolean; checked: Iterable<string>; edited: boolean },
): G0Body {
  const note = form.note.trim();
  return {
    decision,
    ...(note ? { note } : {}),
    ...(decision === 'approve' && !form.motion ? { motion: 'off' as const } : {}),
    claimsChecked: [...form.checked],
    edited: form.edited,
  };
}

/** One line for what a beat shows: a v0.4 scene (its sentence) or an older kind. */
export function beatVisual(b: Pick<PlanBeat, 'visual'>): string {
  const v = b.visual;
  if (!v) return '—';
  if (v.scene) return v.scene;
  if (v.prompt) return v.prompt;
  if (v.lines?.length) return v.lines.join(' / ');
  if (v.timeline?.events?.length) return v.timeline.events.map((e) => `${e.label}: ${e.text}`).join(' · ');
  return '';
}

/** The marks beside a v0.4 beat: its shots, the motion opener, the overlay's kind. */
export function beatMarks(b: Pick<PlanBeat, 'visual'>): string[] {
  const v = b.visual;
  if (!v) return [];
  return [
    ...(v.shots?.length ? [`${v.shots.length} shot${v.shots.length > 1 ? 's' : ''}`] : []),
    ...(v.motion ? ['motion'] : []),
    ...(v.overlay?.kind ? [`${v.overlay.kind} overlay`] : []),
  ];
}
