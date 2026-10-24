/**
 * Desks (hq 0020 P2; contract §1 "Desk endpoints"): the roster, each desk's
 * soul (edited in place, 0020 D1) and the operator's rulings. A desk thread
 * is a Chat conversation with a desk id; its turns go through
 * /v1/chat/completions with `desk` and `desk_session` set.
 */
import { apiFetch } from './api';

export type DeskId = 'content' | 'bd';
export type CardKind = 'open' | 'tick' | 'proposal_decision' | 'ruling';

export interface DeskInfo {
  id: DeskId;
  name: string;
  default_route: 'local' | 'hermes';
  pages: string[];
  local_tools: string[];
  panel_feeds: string[];
  hermes_tools: string[];
  card_kinds: CardKind[];
  cost_note: string;
  soul: { exists: boolean; hash: string | null; chars: number; max: number };
  rulings: number;
}

export interface Soul {
  exists: boolean;
  text: string | null;
  hash: string | null;
  chars: number;
  max: number;
}

export interface Ruling {
  id: number;
  text: string;
  created_at: string;
  updated_at: string;
  thread: string | null;
}

export const SOUL_MAX = 8000;
export const RULING_MAX = 500;
export const CONTEXT_MAX = 8 * 1024;

/** The registry as the app ships it, for rendering before /api/desks answers
 * (and in tests). The server's copy wins once loaded. */
export const DESK_DEFAULTS: Record<DeskId, Pick<DeskInfo, 'id' | 'name' | 'default_route' | 'pages' | 'card_kinds'>> = {
  content: {
    id: 'content',
    name: 'Content desk',
    default_route: 'local',
    pages: ['/content'],
    card_kinds: ['open', 'tick', 'proposal_decision', 'ruling'],
  },
  bd: { id: 'bd', name: 'BD desk', default_route: 'hermes', pages: ['/bizdev'], card_kinds: ['open', 'ruling'] },
};

export const isDeskId = (v: unknown): v is DeskId => v === 'content' || v === 'bd';

async function detail(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => null);
  return typeof body?.detail === 'string' ? body.detail : fallback;
}

export async function fetchDesks(): Promise<{ desks: DeskInfo[]; data_configured: boolean }> {
  const res = await apiFetch('/api/desks');
  if (!res.ok) throw new Error(await detail(res, `Desks: ${res.status}`));
  return res.json();
}

export async function fetchSoul(desk: DeskId): Promise<Soul> {
  const res = await apiFetch(`/api/desks/${desk}/soul`);
  if (!res.ok) throw new Error(await detail(res, `Soul: ${res.status}`));
  return res.json();
}

export type SoulSave = { kind: 'saved'; soul: Soul } | { kind: 'conflict'; message: string } | { kind: 'error'; message: string };

/** Save only if the file is still the copy this page read (the hash check). */
export async function saveSoul(desk: DeskId, text: string, hash: string | null): Promise<SoulSave> {
  const res = await apiFetch(`/api/desks/${desk}/soul`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, hash }),
  });
  if (res.ok) return { kind: 'saved', soul: await res.json() };
  const message = await detail(res, `Save failed (${res.status})`);
  return res.status === 409 ? { kind: 'conflict', message } : { kind: 'error', message };
}

export async function fetchRulings(desk: DeskId): Promise<Ruling[]> {
  const res = await apiFetch(`/api/desks/${desk}/rulings`);
  if (!res.ok) throw new Error(await detail(res, `Rulings: ${res.status}`));
  return (await res.json()).rulings ?? [];
}

export async function addRuling(desk: DeskId, text: string, thread?: string): Promise<Ruling['id']> {
  const res = await apiFetch(`/api/desks/${desk}/rulings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(thread ? { text, thread } : { text }),
  });
  if (!res.ok) throw new Error(await detail(res, `Ruling not recorded (${res.status})`));
  return (await res.json()).id;
}

export async function editRuling(desk: DeskId, id: number, text: string): Promise<void> {
  const res = await apiFetch(`/api/desks/${desk}/rulings/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(await detail(res, `Edit failed (${res.status})`));
}

export async function deleteRuling(desk: DeskId, id: number): Promise<void> {
  const res = await apiFetch(`/api/desks/${desk}/rulings/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(await detail(res, `Delete failed (${res.status})`));
}

const SECRETISH = /token|secret|password|api[_-]?key|authorization|cookie|credential/i;

/** The page's selected item as the first message's `context` block (contract
 * §1 "Page context"): one JSON object, at most 8 KB, with no secret-looking
 * keys. Long values are dropped, largest first, until it fits. */
export function contextBlock(item: Record<string, unknown>): string {
  const clean = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (!SECRETISH.test(k)) out[k] = clean(val);
      }
      return out;
    }
    return v;
  };
  const obj = clean(item) as Record<string, unknown>;
  const size = (o: unknown) => new TextEncoder().encode(JSON.stringify(o)).length;
  while (size(obj) > CONTEXT_MAX) {
    const keys = Object.keys(obj);
    if (keys.length === 0) break;
    const biggest = keys.reduce((a, b) => (size(obj[a]) >= size(obj[b]) ? a : b));
    delete obj[biggest];
    obj._trimmed = true;
  }
  return '```context\n' + JSON.stringify(obj) + '\n```\n\n';
}
