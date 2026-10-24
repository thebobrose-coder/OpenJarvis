/**
 * The G1 mirror (hq 0020 D4; hq/contracts/foundry-g1-mirror.md): Foundry's
 * open approvals with the Telegram card's text, decided through the same
 * code as Telegram's buttons. The server signs every call; the page never
 * sees a presigned link: the still and the clip come through
 * /api/g1/approvals/<id>/media/<still|clip> as blobs.
 */
import { apiFetch } from './api';

export interface G1Item {
  approvalId: string;
  gate: 'G1' | 'G2';
  propertyId: string;
  /** `short`, `thesis`, … or `episode` for a studio episode (0019). */
  contentType: string | null;
  executionName: string;
  createdAt: string;
  expiresAt: string;
  headline: string;
  caption: string;
  disclosures: string[];
  escalation: string | null;
  /** Where it posts; an episode's tags. */
  targets: string[] | null;
  motion: { release: string; beat: string | null } | null;
  /** False for G2: listed for reading, decided in Telegram (0020 A2). */
  decidable: boolean;
  hasStill: boolean;
  hasClip: boolean;
}

export const G1_NOTE_MAX = 500;

export type G1Outcome =
  | { kind: 'decided'; status: string }
  | { kind: 'already'; status: string }
  | { kind: 'error'; message: string };

async function detail(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => null);
  return typeof body?.detail === 'string' ? body.detail : fallback;
}

export async function fetchG1(): Promise<G1Item[]> {
  const res = await apiFetch('/api/g1/approvals');
  if (!res.ok) throw new Error(await detail(res, `G1 mirror: ${res.status}`));
  return (await res.json()).items ?? [];
}

/** Approve or reject. 409 means Telegram or the app decided it first, or it expired. */
export async function decideG1(id: string, decision: 'approve' | 'reject', note: string): Promise<G1Outcome> {
  const res = await apiFetch(`/api/g1/approvals/${encodeURIComponent(id)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(note.trim() ? { decision, note: note.trim() } : { decision }),
  });
  const body = await res.json().catch(() => null);
  if (res.status === 200) return { kind: 'decided', status: String(body?.status ?? decision) };
  if (res.status === 409) return { kind: 'already', status: String(body?.status ?? '') };
  if (res.status === 403) return { kind: 'error', message: 'This one is G2: decide it in Telegram.' };
  if (res.status === 404) return { kind: 'error', message: 'No longer open.' };
  return { kind: 'error', message: typeof body?.detail === 'string' ? body.detail : `G1 mirror: ${res.status}` };
}

/** The row's still or clip as an object URL (the caller revokes it). */
export async function g1Media(id: string, which: 'still' | 'clip'): Promise<string> {
  const res = await apiFetch(`/api/g1/approvals/${encodeURIComponent(id)}/media/${which}`);
  if (!res.ok) throw new Error(await detail(res, `${which}: ${res.status}`));
  return URL.createObjectURL(await res.blob());
}
