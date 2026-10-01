/**
 * The assistant's voice (hq/contracts/openjarvis-hermes.md v1.1, hq decision 0009).
 * Hermes writes `speech` blocks; the local voice worker renders them; the
 * backend's /api/voice routes read the worker's cache.
 */
import { apiFetch, getBase, isTauri } from './api';

/** A spoken script Hermes attaches to a feed (`data.speech`). */
export interface SpeechBlock {
  id: string;
  title: string;
  text?: string;
  mood: 'neutral' | 'upbeat' | 'grave' | 'dry' | string;
  priority: 'briefing' | 'alert' | 'info' | string;
  lane: 'expressive' | 'fast' | string;
  created_at: string;
}

export type AudioStatus = 'missing' | 'fast' | 'expressive';

export interface VoiceAudio {
  audio: AudioStatus;
  /** Absolute path of the cached WAV (the desktop app plays it via the asset protocol). */
  audio_path: string | null;
  audio_url: string | null;
  /** Changes when fast audio is upgraded to the expressive render. */
  audio_version: string | null;
  duration?: number | null;
}

export interface VoiceQueueItem extends SpeechBlock, VoiceAudio {
  source_feed: string;
  order: number;
}

export interface VoiceQueue {
  run_at: string | null;
  generated_at: string | null;
  worker: boolean;
  /** The expressive voice's display name (machine-local worker config). */
  voice_name?: string;
  items: VoiceQueueItem[];
}

/** Feeds whose speech blocks can be played (the backend's allowlist). */
export type SpeechFeed =
  | 'voice_queue'
  | 'digest_general'
  | 'digest_culture'
  | 'ecom_briefing'
  | 'compliance_findings'
  | 'bd_prospects'
  | 'bd_pipeline'
  | 'content_proposals';

export const SOURCE_LABELS: Record<string, string> = {
  digest_general: 'Digest',
  digest_culture: 'Culture',
  ecom_briefing: 'Commerce',
  compliance_findings: 'Compliance',
  bd_prospects: 'Business Development',
  bd_pipeline: 'Business Development',
  content_proposals: 'Content',
};

/** The expressive voice's name for its render, "fast" for Kokoro, null if not rendered. */
export function laneBadge(audio: AudioStatus, voiceName = 'Expressive'): string | null {
  if (audio === 'expressive') return voiceName;
  if (audio === 'fast') return 'fast';
  return null;
}

/** The first playable block of a feed's `speech`, if any. */
export function firstBlock(speech: SpeechBlock[] | null | undefined): SpeechBlock | null {
  const b = (speech ?? []).find((s) => /^[0-9a-f]{16}$/.test(s?.id ?? ''));
  return b ?? null;
}

export async function fetchVoiceQueue(): Promise<VoiceQueue> {
  const res = await apiFetch('/api/voice/queue');
  if (!res.ok) throw new Error(res.status === 503 ? 'Hermes voice queue unavailable' : `Failed: ${res.status}`);
  return res.json();
}

/** Cached audio for a block, or a fast-lane render made now. */
export async function prepareBlock(feed: SpeechFeed, id: string): Promise<VoiceAudio> {
  const res = await apiFetch('/api/voice/prepare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ feed, id }),
  });
  if (!res.ok) {
    const detail = res.status === 503 ? 'The voice worker is not running' : `Audio unavailable (${res.status})`;
    throw new Error(detail);
  }
  return res.json();
}

/** The <audio> src: the asset protocol in the desktop app (WebView2 rejects
 * http: and blob: media there), the HTTP route in the browser. The version
 * suffix makes an upgraded render load fresh; the asset protocol ignores it. */
export async function voiceAudioSrc(a: VoiceAudio): Promise<string | null> {
  const version = a.audio_version ? `?v=${encodeURIComponent(a.audio_version)}` : '';
  if (isTauri() && a.audio_path) {
    const { convertFileSrc } = await import('@tauri-apps/api/core');
    return convertFileSrc(a.audio_path) + version;
  }
  return a.audio_url ? `${getBase()}${a.audio_url}${version}` : null;
}

// ---------------------------------------------------------------------------
// Voice input (hq 0010 phase 1): the worker's conversation state, live.
// ---------------------------------------------------------------------------

export type VoiceStateName = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'muted';

export interface VoiceTurn {
  role: 'user' | 'assistant';
  text: string;
  at: string;
}

export interface VoiceState {
  state: VoiceStateName;
  conversation_id: string | null;
  duplex: 'full' | 'half' | string;
  device: string;
  /** This conversation's turns only, in memory on the worker. */
  turns: VoiceTurn[];
}

export async function fetchVoiceState(): Promise<VoiceState> {
  const res = await apiFetch('/api/voice/state');
  if (!res.ok) throw new Error(res.status === 503 ? 'Voice input is not running' : `Failed: ${res.status}`);
  return res.json();
}

export async function voiceAction(action: 'start' | 'stop' | 'mute' | 'unmute'): Promise<VoiceState> {
  const res = await apiFetch(`/api/voice/${action}`, { method: 'POST' });
  if (!res.ok) throw new Error(res.status === 503 ? 'Voice input is not running' : `Failed: ${res.status}`);
  return res.json();
}

/** Live state updates; returns an unsubscribe function. */
export function subscribeVoiceState(onState: (s: VoiceState) => void, onError?: () => void): () => void {
  const source = new EventSource(`${getBase()}/api/voice/events`);
  source.onmessage = (e) => {
    try {
      onState(JSON.parse(e.data) as VoiceState);
    } catch {
      /* ignore a malformed event */
    }
  };
  source.onerror = () => onError?.();
  return () => source.close();
}
