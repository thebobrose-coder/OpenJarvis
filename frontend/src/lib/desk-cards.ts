/**
 * Proposal cards (contract §1 "Proposal cards"): a desk ends its reply with
 * fenced blocks whose info string is `card`, each one JSON object
 * `{kind, label, target, body?}`. They are validated against the desk's
 * allowed kinds and each kind's target rules; an invalid one is dropped and
 * shown as dropped. Nothing acts until the operator clicks, and then only
 * through the existing route or control.
 */
import { LIMITS } from './content-api';
import type { CardKind, DeskInfo } from './desks-api';

export interface OpenCard {
  kind: 'open';
  label: string;
  page: string;
  focus: string;
  /** Prefills the page's own text field (the BD drawer's message); never sent. */
  draft?: string;
}
export interface TickCard {
  kind: 'tick';
  label: string;
  file: string;
  box: number;
  note: string;
}
export interface ProposalFields {
  topic?: string;
  pillar_hint?: string;
  product_handle?: string;
  note?: string;
  target_queries?: string[];
  priority?: number;
}
export interface DecisionCard {
  kind: 'proposal_decision';
  label: string;
  id: string;
  decision: 'approve' | 'reject';
  fields: ProposalFields;
}
export interface RulingCard {
  kind: 'ruling';
  label: string;
  text: string;
}
export type DeskCard = OpenCard | TickCard | DecisionCard | RulingCard;
export interface DroppedCard {
  label: string;
  reason: string;
}

export const LABEL_MAX = 120;
export const DRAFT_MAX = 5000;
const KINDS: CardKind[] = ['open', 'tick', 'proposal_decision', 'ruling'];
/** Pages with a text field an `open` card's draft can fill. */
const DRAFT_PAGES = new Set(['/bizdev']);
/** Pages whose `open` card must name an item. */
const FOCUS_REQUIRED = new Set(['/bizdev', '/content', '/commerce#fixes']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FOCUS = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const BRIEF = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.md$/;
const CARD_BLOCK = /```card[ \t]*\r?\n([\s\S]*?)```/g;

type Desk = Pick<DeskInfo, 'card_kinds' | 'pages'>;
type Result = { card: DeskCard } | { dropped: DroppedCard };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

const DEFAULT_LABEL: Record<CardKind, string> = {
  open: 'Open',
  tick: 'Tick',
  proposal_decision: 'Decide proposal',
  ruling: 'Record ruling',
};

function drop(label: string, reason: string): Result {
  return { dropped: { label, reason } };
}

/** One parsed card block, checked against the desk. */
export function validateCard(raw: unknown, desk: Desk): Result {
  if (!isObj(raw)) return drop('Card', 'not a JSON object');
  const kind = str(raw.kind) as CardKind;
  const label = (str(raw.label) || (KINDS.includes(kind) ? DEFAULT_LABEL[kind] : 'Card')).slice(0, LABEL_MAX);
  if (!KINDS.includes(kind)) return drop(label, `unknown kind “${str(raw.kind) || '?'}”`);
  if (!desk.card_kinds.includes(kind)) return drop(label, `${kind} cards aren't allowed on this desk`);
  const target = isObj(raw.target) ? raw.target : {};
  const body = isObj(raw.body) ? raw.body : {};

  if (kind === 'open') {
    const page = str(target.page);
    const focus = typeof target.focus === 'number' ? String(target.focus) : str(target.focus);
    if (!desk.pages.includes(page)) return drop(label, `this desk can't open ${page || 'that page'}`);
    // A page with no item (the Stack drawer, a whole page) may leave focus empty.
    if (focus && !FOCUS.test(focus)) return drop(label, 'not an item id');
    if (!focus && FOCUS_REQUIRED.has(page)) return drop(label, 'no item to focus');
    if (page === '/bizdev' && !/^[1-9][0-9]{0,9}$/.test(focus)) return drop(label, 'not a prospect id');
    const draft = typeof body.draft === 'string' ? body.draft.trim() : '';
    if (draft && !DRAFT_PAGES.has(page)) return drop(label, `${page} has no text field for a draft`);
    if (draft.length > DRAFT_MAX) return drop(label, `draft over ${DRAFT_MAX} characters`);
    return { card: { kind, label, page, focus, ...(draft ? { draft } : {}) } };
  }

  if (kind === 'tick') {
    const file = str(target.file);
    const m = /^D(\d{1,2})$/i.exec(str(target.box));
    if (!BRIEF.test(file)) return drop(label, 'not an inbox brief (<folder>/<name>.md)');
    if (!m) return drop(label, 'not a decision box (D1, D2, …)');
    const note = str(body.note);
    if (/[\r\n]/.test(note) || note.length > LIMITS.note) return drop(label, 'the note is one line, at most 500 characters');
    return { card: { kind, label, file, box: Number(m[1]), note } };
  }

  if (kind === 'proposal_decision') {
    const id = str(target.id ?? target.proposal_id);
    if (!UUID.test(id)) return drop(label, 'not a proposal id');
    const decision = str(body.decision);
    if (decision !== 'approve' && decision !== 'reject') return drop(label, 'decision must be approve or reject');
    const fields: ProposalFields = {};
    const keys = decision === 'reject' ? (['note'] as const) : (['topic', 'pillar_hint', 'product_handle', 'note'] as const);
    for (const k of keys) {
      const v = str(body[k]);
      if (!v) continue;
      if (v.length > LIMITS[k]) return drop(label, `${k} over ${LIMITS[k]} characters`);
      fields[k] = v;
    }
    if (decision === 'approve' && Array.isArray(body.target_queries)) {
      const q = body.target_queries.map(str).filter(Boolean);
      if (q.length > LIMITS.target_queries || q.some((x) => x.length > LIMITS.target_query)) {
        return drop(label, 'at most 3 target queries of 80 characters');
      }
      fields.target_queries = q;
    }
    if (decision === 'approve' && body.priority != null) {
      const p = Number(body.priority);
      if (![1, 2, 3].includes(p)) return drop(label, 'priority is 1-3');
      fields.priority = p;
    }
    return { card: { kind, label, id, decision, fields } };
  }

  const text = str(body.text).replace(/\s+/g, ' ');
  if (!text) return drop(label, 'a ruling needs text');
  if (text.length > 500) return drop(label, 'a ruling is at most 500 characters');
  return { card: { kind: 'ruling', label, text } };
}

/** The reply without its card blocks, the valid cards, and the dropped ones.
 * While a reply streams, an unclosed card block is hidden, not shown raw. */
export function parseCards(
  content: string,
  desk: Desk,
): { text: string; cards: DeskCard[]; dropped: DroppedCard[] } {
  const cards: DeskCard[] = [];
  const dropped: DroppedCard[] = [];
  let text = content.replace(CARD_BLOCK, (_, json: string) => {
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch {
      dropped.push({ label: 'Card', reason: 'not valid JSON' });
      return '';
    }
    const r = validateCard(raw, desk);
    if ('card' in r) cards.push(r.card);
    else dropped.push(r.dropped);
    return '';
  });
  const open = text.indexOf('```card');
  if (open >= 0) text = text.slice(0, open);
  return { text: text.trimEnd(), cards, dropped };
}

/** The thread's system line after the operator acted on a card. */
export function outcomeLine(card: DeskCard, result: 'done' | 'opened', extra?: string): string {
  switch (card.kind) {
    case 'open':
      if (card.page === '/stack') return 'Opened the Stack drawer';
      return `Opened ${card.page}${card.focus ? ` (${card.focus})` : ''}${card.draft ? ', draft in the message field' : ''}`;
    case 'tick':
      return `Ticked D${card.box}${extra ? ` on ${extra}` : ''}`;
    case 'proposal_decision':
      return result === 'opened'
        ? `Opened the ${card.decision} editor for proposal ${card.id.slice(0, 8)}`
        : `Proposal ${card.decision === 'approve' ? 'approved' : 'rejected'}`;
    case 'ruling':
      return 'Ruling recorded';
  }
}

/** Where an `open` card goes: `/commerce#fixes` with a focus is
 * `/commerce?focus=<id>#fixes`, as "Waiting on you" links it. */
export function openUrl(page: string, focus: string): string {
  const [path, hash] = page.split('#', 2);
  const query = focus ? `?focus=${encodeURIComponent(focus)}` : '';
  return `${path}${query}${hash ? `#${hash}` : ''}`;
}
