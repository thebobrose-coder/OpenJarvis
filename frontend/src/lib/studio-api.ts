/**
 * The studio's Episodes surface (hq 0019 Part B; hq/contracts/foundry-studio.md):
 * Foundry's local studio writes `status.json` and one folder per episode, and
 * the server's /api/studio routes read them. The page writes only the
 * operator's files: the G0 edit and decision, publish.json and the pause flag.
 */
import { apiFetch } from './api';

export type EpisodeStage =
  | 'queued'
  | 'scripting'
  | 'scripted'
  | 'awaiting-g0'
  | 'rewrite-requested'
  | 'narrating'
  | 'visualizing'
  | 'assembling'
  | 'scanning'
  | 'at-g1'
  | 'publishing'
  | 'published'
  | 'stopped'
  | 'rejected';

/** An unclaimed seed in a lane, in lane order (v0.4.5). */
export interface QueuedSeed {
  signalId: string;
  title: string | null;
  episodeClass: string | null;
  createdAt: string | null;
  /** Where the seed came from, e.g. the operator, the intake or a companion post. */
  source: string | null;
  /** A companion seed whose post hasn't been published yet: the studio doesn't claim it. */
  waitingForPost?: boolean;
}

/** An ended or stopped episode whose seed is still claimed (v0.4.5). */
export interface HeldSeed {
  episodeId: string;
  signalId: string;
  stage: EpisodeStage | string;
  title: string | null;
}

export interface StudioLane {
  propertyId: string;
  queued: number;
  inProduction: number;
  published30d: number;
  runwayDays: number;
  queue?: QueuedSeed[];
  heldSeeds?: HeldSeed[];
}

export interface StudioSpend {
  usd: number;
  capUsd: number;
  gpuMinutes: number;
}

/** The bundle's studio block for one channel, as the server passes it. */
export interface StudioChannel {
  channelName: string | null;
  lanePerWeek: number | null;
  cloudCapUsdPerEpisode: number | null;
  cloudCapUsdPerMonth: number | null;
  gpuMinutesCap: number | null;
  firstUnlisted: number | null;
  episodeClasses: { id: string; name: string; operatorOnly: boolean }[];
}

export interface StudioStatus {
  generatedAt: string;
  paused: Record<string, boolean>;
  lanes: StudioLane[];
  inFlight: { episodeId: string; propertyId: string; stage: EpisodeStage | string; since: string; stoppedReason?: string }[];
  spend: { month: string } & Record<string, StudioSpend | string>;
  lastRun: { at: string; ok: boolean; advanced: number; note?: string };
  published: Record<string, number>;
  channels: Record<string, StudioChannel>;
  age_seconds: number | null;
  stale: boolean;
}

export interface EpisodeSummary {
  episodeId: string;
  propertyId: string;
  stage: EpisodeStage | string;
  since: string | null;
  updatedAt: string | null;
  title: string | null;
  topic: string | null;
  episodeClass: string | null;
  targetMinutes: number | null;
  gpuMinutes: number | null;
  spentUsd: number | null;
  durationSeconds: number | null;
  youtubeVisibility: 'unlisted' | 'public' | null;
  postId: string | null;
  stoppedReason: string | null;
  /** The studio's latest note in the current stage: a wait, a refusal or a stop. */
  stageNote: string | null;
  rewrites: number;
  /** A g0.json is written and waits for the studio's next run. */
  g0Pending: boolean;
  /** v0.4.5: an action.json written and not yet consumed by the studio. */
  actionPending: ActionFile | null;
  /** v0.4.5: the episode ended or stopped but still holds its seed (Requeue seed applies). */
  seedHeld: boolean;
}

export type EpisodeAction = 'retry' | 'reject' | 'requeue';

/** `action.json` (v0.4.5): consumed once per run, renamed `action.<at>.json`. */
export interface ActionFile {
  action: EpisodeAction;
  note?: string;
  at: string;
}

export interface Claim {
  id: string;
  beat: number;
  text: string;
  /** An https link, "unsourced" (the studio's audit) or "" (lore). */
  source: string;
  kind: 'fact' | 'lore';
}

/** An overlay panel over a scene beat (v0.4): a chart or a timeline. */
export interface BeatOverlay {
  kind: 'chart' | 'timeline' | string;
  chart?: unknown;
  timeline?: { events: { label: string; text: string }[] };
}

export interface BeatVisual {
  /** v0.4: "scene" or "motion"; older plans keep "still", "kinetic", "chart", "timeline", "reference". */
  kind: string;
  prompt?: string;
  lines?: string[];
  timeline?: { events: { label: string; text: string }[] };
  chart?: unknown;
  /** v0.4: one sentence for the image model, and its 2-3 framings. */
  scene?: string;
  shots?: string[];
  /** v0.4: the beat opens on a motion shot. */
  motion?: boolean;
  overlay?: BeatOverlay;
}

export interface PlanBeat {
  beat: number;
  heading: string;
  words?: number;
  visual?: BeatVisual;
  sound?: string;
  claimIds?: string[];
}

export interface Plan {
  title?: string;
  shortBeat?: number;
  beats: PlanBeat[];
  /** v0.4: the episode's one on-screen sentence, a lower-third on its beat. */
  pullQuote?: { beat: number; text: string };
}

export interface StageEntry {
  stage: string;
  at: string;
  ok: boolean;
  note?: string;
}

export interface Manifest {
  episodeId: string;
  propertyId: string;
  stage: EpisodeStage | string;
  stages: StageEntry[];
  episodeClass?: string;
  targetMinutes?: number;
  sources?: string[];
  topic?: string;
  title?: string;
  operatorEdited?: boolean;
  prescreen?: { passes: number; verdict: 'pass' | 'fail'; reasons: string[] };
  cloud?: { capEpisodeUsd: number; spentUsd: number; omniAllowed: boolean; items: { kind: string; usd: number; at: string; note?: string }[] };
  gpuMinutes?: number;
  durationSeconds?: number;
  rewrites?: number;
  youtubeVisibility?: 'unlisted' | 'public';
  postId?: string;
  stoppedReason?: string;
  /** v0.1.4: the source-copy check on the current script; absent on a draft written before it. */
  sourceCopy?: SourceCopyHit[];
  /** v0.4.5: set when a requeue freed the seed back to its lane. */
  seedReleasedAt?: string;
}

/** A stretch of narration in a source's wording (v0.1.4): a note for G0, never a block. */
export interface SourceCopyHit {
  beat: number;
  sentence: string;
  /** 1-based, as in `sources/index.json`. */
  sourceN: number;
  /** The shared words, at most 30. */
  run: string;
  kind: 'run' | 'density';
}

export interface PublishFile {
  title: string;
  description: string;
  tags: string[];
  thumbnail: string;
}

export interface G0File {
  decision: 'approve' | 'rewrite' | 'reject';
  at: string;
  note?: string;
  /** Before v0.4; the studio reads only `true`. No longer written. */
  omni?: boolean;
  /** v0.4: "off" turns the episode's motion shots off; absent is the channel default (on). */
  motion?: 'on' | 'off';
  claimsChecked: string[];
  edited: boolean;
}

export interface EpisodeDetail {
  summary: EpisodeSummary;
  manifest: Manifest;
  script: string | null;
  claims: Claim[] | null;
  plan: Plan | null;
  chapters: string[] | null;
  publish: PublishFile | null;
  narration: { ok: boolean; seconds?: number; gpuMinutes?: number; error?: string } | null;
  g0Pending: G0File | null;
  g0History: G0File[];
  /** v0.4.5: the actions the studio consumed, oldest first. */
  actionHistory: ActionFile[];
  media: { cut: number | null; short: number | null; thumbs: string[] };
  /** Hash of script.md + claims.json, sent back with an edit. */
  version: string;
  edited: boolean;
  channel: StudioChannel | null;
  visibility: { visibility: 'unlisted' | 'public'; number: number | null; first: number } | null;
  paused: boolean;
  /** The studio's source snapshot, to name a copy hit's source; null before it exists. */
  sourceIndex: { n: number; url: string }[] | null;
}

export const RUN_COOLDOWN_MS = 2 * 60 * 1000;
/** The studio's task runs every 10 minutes. */
export const RUN_EVERY_MS = 10 * 60 * 1000;
export const G0_NOTE_MAX = 1000;
export const ACTION_NOTE_MAX = 1000;
export const MAX_REWRITES = 2;
export const PUBLISH_LIMITS = { titleMin: 2, titleMax: 100, description: 5000, tags: 500 } as const;

async function failure(res: Response, what: string): Promise<Error> {
  const detail = await res.json().then((b) => b?.detail).catch(() => null);
  return new Error(detail ? String(detail) : `${what} failed: ${res.status}`);
}

const json = (method: string, body: object): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/** Null when the studio hasn't run yet or the data folder isn't configured (404). */
export async function fetchStudioStatus(): Promise<StudioStatus | null> {
  const res = await apiFetch('/api/studio/status');
  if (res.status === 404) return null;
  if (!res.ok) throw await failure(res, 'Studio status');
  return res.json();
}

export async function fetchEpisodes(): Promise<EpisodeSummary[]> {
  const res = await apiFetch('/api/studio/episodes');
  if (res.status === 404) return [];
  if (!res.ok) throw await failure(res, 'Episodes');
  return (await res.json()).episodes ?? [];
}

export async function fetchEpisode(id: string): Promise<EpisodeDetail> {
  const res = await apiFetch(`/api/studio/episodes/${encodeURIComponent(id)}`);
  if (!res.ok) throw await failure(res, 'Episode');
  return res.json();
}

/** Save the operator's G0 edit; resolves to the new version hash. */
export async function saveScript(
  id: string,
  version: string,
  edit: { script?: string; claims?: Claim[] },
): Promise<string> {
  const res = await apiFetch(`/api/studio/episodes/${encodeURIComponent(id)}/script`, json('PUT', { version, ...edit }));
  if (!res.ok) throw await failure(res, 'Save');
  return (await res.json()).version;
}

export interface G0Body {
  decision: 'approve' | 'rewrite' | 'reject';
  note?: string;
  /** v0.4: sent as "off" only when the operator unticks motion shots on an approve. */
  motion?: 'on' | 'off';
  claimsChecked: string[];
  edited: boolean;
}

export async function sendG0(id: string, body: G0Body): Promise<G0File> {
  const res = await apiFetch(`/api/studio/episodes/${encodeURIComponent(id)}/g0`, json('POST', body));
  if (!res.ok) throw await failure(res, 'G0');
  return res.json();
}

/**
 * Write action.json (v0.4.5). The server applies the contract's stage rules
 * (400) and refuses a second action while one waits (409); the studio
 * consumes the file on its next run and leaves the outcome as a stage note.
 */
export async function sendAction(id: string, body: { action: EpisodeAction; note?: string }): Promise<ActionFile> {
  const res = await apiFetch(`/api/studio/episodes/${encodeURIComponent(id)}/action`, json('POST', body));
  if (!res.ok) throw await failure(res, 'Action');
  return res.json();
}

export async function savePublish(id: string, body: PublishFile): Promise<PublishFile> {
  const res = await apiFetch(`/api/studio/episodes/${encodeURIComponent(id)}/publish`, json('PUT', body));
  if (!res.ok) throw await failure(res, 'Save');
  return res.json();
}

export async function setPaused(propertyId: string, paused: boolean): Promise<void> {
  const res = await apiFetch(`/api/studio/pause/${encodeURIComponent(propertyId)}`, { method: paused ? 'POST' : 'DELETE' });
  if (!res.ok) throw await failure(res, paused ? 'Pause' : 'Resume');
}

/** Start the studio now. `started` is false when it ran under 2 minutes ago (429). */
export async function runStudio(): Promise<{ started: boolean; availableAt: number }> {
  const res = await apiFetch('/api/studio/run', { method: 'POST' });
  if (res.status === 429) {
    const body = await res.json().catch(() => null);
    const wait = Number(body?.retry_after) || RUN_COOLDOWN_MS / 1000;
    return { started: false, availableAt: Date.now() + wait * 1000 };
  }
  if (!res.ok) throw await failure(res, 'Studio run');
  return { started: true, availableAt: Date.now() + RUN_COOLDOWN_MS };
}

/**
 * One media file as an object URL. The desktop app's page and the server are
 * different origins (and the server may want a bearer token), so media is
 * fetched with apiFetch and played from a blob, which the CSP allows.
 * The caller revokes it.
 */
export async function mediaUrl(id: string, name: string): Promise<string> {
  const path = name.split('/').map(encodeURIComponent).join('/');
  const res = await apiFetch(`/api/studio/episodes/${encodeURIComponent(id)}/media/${path}`);
  if (!res.ok) throw await failure(res, 'Media');
  return URL.createObjectURL(await res.blob());
}
