/**
 * Business Development Send, the page's side of Parts B and C (hq 0018,
 * contract v0.10 / v0.10.2): template merge fields resolved from the card,
 * the line's screen as an early warning (the server applies it again and is
 * the authority), the edit count sent as `draft_edited`, and the engagement
 * timeline and chips read from `engagement` and `touches[]`.
 */
import {
  firstRecipient,
  recipientsOf,
  touchOf,
  type Contact,
  type Engagement,
  type PipelineProspect,
  type RecipientEngagement,
  type Screen,
  type SendConfig,
  type Template,
  type Touch,
} from './bizdev-api';

// ---------------------------------------------------------------------------
// Merge fields: the same values Hermes's own merge uses (bd_research
// `merge_values`), plus the sender's two, which are machine-local here.
// ---------------------------------------------------------------------------

export const MERGE_FIELDS = [
  'first_name',
  'last_name',
  'title',
  'institution',
  'short_name',
  'association',
  'division',
  'conference',
  'state',
  'platform',
  'signal_1',
  'sport_hint',
  'sender_name',
  'sender_title',
  'first_subject',
  'days_since_first',
] as const;
export type MergeField = (typeof MERGE_FIELDS)[number];
export type MergeValues = Partial<Record<MergeField, string | null>>;

const SPORTS = [
  'cross country',
  'track and field',
  'football',
  'basketball',
  'baseball',
  'softball',
  'volleyball',
  'soccer',
  'wrestling',
  'golf',
  'tennis',
  'lacrosse',
  'swimming',
  'bowling',
  'track',
];
const HONORIFIC = /^(dr|mr|mrs|ms|coach)\.?$/i;
const MERGE_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** "University of Sampleton" -> "Sampleton", "College of the Hills" -> "the Hills". */
export function shortName(name: string): string {
  const s = name.replace(/\b(College of|University of)\b|\bUniversity\b/g, ' ');
  return s.replace(/\s+/g, ' ').replace(/^[ ,-]+|[ ,-]+$/g, '') || name;
}

export function mergeValues(
  p: PipelineProspect,
  toEmail: string | null | undefined,
  sender: Pick<SendConfig, 'sender_name' | 'sender_title'> | null,
  fromName?: string,
  now: Date = new Date(),
): MergeValues {
  const contact = (p.contacts ?? []).find((c) => toEmail && (c.email ?? '').toLowerCase() === toEmail.toLowerCase());
  const words = (contact?.name ?? '').split(/\s+/).filter((w) => w && !HONORIFIC.test(w));
  // `first_subject` / `days_since_first` read the chosen recipient's touch 1 (v0.10.7).
  const first = touchOf(p, 1, toEmail || firstRecipient(p));
  const platform = p.signals?.platform;
  const text = [...(p.signal_notes ?? []), p.fit_rationale ?? ''].join(' ').toLowerCase();
  const sent = first?.sent_at ? Date.parse(first.sent_at) : NaN;
  return {
    first_name: words[0] ?? null,
    last_name: words.length > 1 ? words[words.length - 1] : null,
    title: contact?.title || null,
    institution: p.name || null,
    short_name: p.name ? shortName(p.name) : null,
    association: p.association || null,
    division: p.division || null,
    conference: p.conference || null,
    state: p.state || null,
    platform: !platform || platform === 'unknown / custom' ? null : platform,
    signal_1: p.signal_notes?.[0] || null,
    sport_hint: SPORTS.find((s) => new RegExp(`\\b${s}\\b`).test(text)) ?? null,
    sender_name: fromName?.trim() || sender?.sender_name || null,
    sender_title: sender?.sender_title || null,
    first_subject: first?.subject || p.draft?.subject || null,
    days_since_first: Number.isNaN(sent) ? null : String(Math.floor((now.getTime() - sent) / 86_400_000)),
  };
}

/** The text with every resolvable field filled; unresolved ones stay as `{{field}}`. */
export function mergeText(text: string, values: MergeValues): string {
  return text.replace(MERGE_RE, (whole, name: string) => {
    const v = values[name as MergeField];
    return v == null || v === '' ? whole : v;
  });
}

/** Only the sender's own fields, which Hermes leaves literal in its drafts. */
export function fillSender(text: string, values: MergeValues): string {
  return mergeText(text, { sender_name: values.sender_name, sender_title: values.sender_title });
}

// ---------------------------------------------------------------------------
// The line's footer and screen
// ---------------------------------------------------------------------------

/** The body without the line's published footer (Hermes drafts end with it;
 * the server adds it back, filled). Used when saving a draft as a template. */
export function withoutFooter(body: string, screen: Screen | null | undefined): string {
  const tail = screen?.footer?.trim();
  const text = body.replace(/\s+$/, '');
  return tail && text.endsWith(tail) ? text.slice(0, -tail.length).replace(/\s+$/, '') : text;
}

/** The footer as it will be sent: the name filled, the postal address
 * (machine-local, never sent to the page) named. */
export function footerPreview(screen: Screen | null | undefined, name: string | null | undefined): string | null {
  const f = screen?.footer?.trim();
  if (!f) return null;
  return f.replace('[Your name]', name || '[Your name]').replace('[postal address]', '(your postal address)');
}

/** A Python pattern as a JS RegExp: a leading `(?i)` becomes the `i` flag.
 * Null when it can't be read here (the server still applies it). */
function toRegExp(pattern: string): RegExp | null {
  let src = pattern;
  let flags = '';
  const m = /^\(\?([aiLmsux]+)\)/.exec(src);
  if (m) {
    src = src.slice(m[0].length);
    if (m[1].includes('i')) flags += 'i';
    if (m[1].includes('m')) flags += 'm';
    if (m[1].includes('s')) flags += 's';
  }
  try {
    return new RegExp(src, flags);
  } catch {
    return null;
  }
}

/** The first forbidden pattern's reason, on subject + body minus the footer. */
export function screenReason(screen: Screen | null | undefined, subject: string, body: string): string | null {
  const text = `${subject}\n${withoutFooter(body, screen)}`;
  for (const p of screen?.patterns ?? []) {
    if (toRegExp(p.regex)?.test(text)) return p.reason || 'the line’s screen';
  }
  return null;
}

/** Characters changed between the starting text and the text sent: the
 * longer side of what differs once the common start and end are set aside. */
export function charsChanged(before: string, after: string): number {
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before[start] === after[start]) start += 1;
  let end = 0;
  while (end < max - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end += 1;
  return Math.max(before.length - start - end, after.length - start - end);
}

// ---------------------------------------------------------------------------
// Templates on a draft
// ---------------------------------------------------------------------------

/** Current templates usable for a touch, grouped: that touch's own, then "any". */
export function templatesFor(templates: Template[] | undefined, touch: number): { label: string; items: Template[] }[] {
  const live = (templates ?? []).filter((t) => !t.archived_at);
  const own = live.filter((t) => t.touch === touch);
  const any = live.filter((t) => t.touch === 'any');
  return [
    { label: `Touch ${touch}`, items: own },
    { label: 'Any touch', items: any },
  ].filter((g) => g.items.length > 0);
}

export function templateSourceId(source: string | null | undefined): number | null {
  const m = /^template:(\d+)$/.exec(source ?? '');
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------------------
// Engagement (Part B)
// ---------------------------------------------------------------------------

export type EngagementChipKind = 'opened' | 'replied' | 'referred' | 'auto_reply' | 'bounced' | 'unsubscribed';

export const ENGAGEMENT_CHIP_LABELS: Record<EngagementChipKind, string> = {
  opened: 'Opened',
  replied: 'Replied',
  referred: 'Referred',
  auto_reply: 'Auto-reply',
  bounced: 'Bounced',
  unsubscribed: 'Unsubscribed',
};

/** Card chips. "Opened" needs a non-proxy open: a proxy prefetch says nothing.
 * "Bounced" follows the stage: since v0.10.7 a hard bounce to one of several
 * recipients sets `bounce_kind` while the card stays `sent`. */
export function engagementChips(e: Engagement | undefined, stage?: string): EngagementChipKind[] {
  if (!e) return stage === 'bounced' ? ['bounced'] : [];
  const out: EngagementChipKind[] = [];
  if ((e.opens ?? 0) - (e.proxy_opens ?? 0) > 0) out.push('opened');
  if (e.reply_kind === 'reply') out.push('replied');
  if (e.reply_kind === 'reply_other_sender') out.push('referred');
  if (e.reply_kind === 'auto_reply') out.push('auto_reply');
  if (stage === 'bounced') out.push('bounced');
  if (e.unsubscribed_at) out.push('unsubscribed');
  return out;
}

/** "Opened ×3 (2 proxy)", "Opened ×1 (proxy)", "Opened ×2". */
export function opensLabel(opens: number, proxy: number): string {
  const tag = proxy <= 0 ? '' : proxy >= opens ? ' (proxy)' : ` (${proxy} proxy)`;
  return `Opened ×${opens}${tag}`;
}

/** Part D: a calendar event's day in Central, "Thu, Oct 30". */
export function meetingDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric' }).format(d);
}

/** Part D: the chip shows only on a `replied` card Hermes marks `meeting`. */
export function proposesMeeting(p: Pick<PipelineProspect, 'stage' | 'proposed_stage'>): boolean {
  return p.stage === 'replied' && p.proposed_stage === 'meeting';
}

export interface TimelineEvent {
  at: string;
  label: string;
  detail?: string | null;
  touch?: Touch;
  /** A send's address (lower-cased), for grouping by recipient. */
  recipient?: string;
  tone?: 'success' | 'warning' | 'error' | 'muted';
}

type TimelineCard = Pick<PipelineProspect, 'touches' | 'engagement'> & Partial<Pick<PipelineProspect, 'contacts' | 'draft'>>;

const lower = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

function contactFor(p: Partial<Pick<PipelineProspect, 'contacts'>>, email: string | null | undefined): Contact | undefined {
  return (p.contacts ?? []).find((c) => email && lower(c.email) === lower(email));
}

/** "Ann Person" when the address is a contact with a name, else the address. */
export function recipientName(p: Partial<Pick<PipelineProspect, 'contacts'>>, email: string): string {
  return contactFor(p, email)?.name || email;
}

/** Part D: "Wed 01:00 CT", "drafted → sent 2.0 h", "edited 12 chars"; absent fields say nothing. */
export function touchTiming(t: Pick<Touch, 'send_dow' | 'send_hour' | 'send_latency_h' | 'draft_edited'>): string[] {
  const out: string[] = [];
  if (t.send_dow && t.send_hour != null) out.push(`${t.send_dow} ${String(t.send_hour).padStart(2, '0')}:00 CT`);
  if (t.send_latency_h != null) out.push(`drafted → sent ${t.send_latency_h.toFixed(1)} h`);
  if (t.draft_edited != null && t.draft_edited > 0) out.push(`edited ${t.draft_edited} char${t.draft_edited === 1 ? '' : 's'}`);
  return out;
}

/** Hard bounces per address (v0.10.7), from the contacts and the recipient rows. */
function addressBounces(p: TimelineCard): { email: string; at: string }[] {
  const out = new Map<string, string>();
  for (const c of p.contacts ?? []) if (c.email && c.bounce_hard_at) out.set(lower(c.email), c.bounce_hard_at);
  for (const r of p.engagement?.recipients ?? []) if (r.bounce_hard_at && !out.has(lower(r.to_email))) out.set(lower(r.to_email), r.bounce_hard_at);
  return [...out].map(([email, at]) => ({ email, at }));
}

/** Sends, then what came back, in time order. */
export function engagementTimeline(p: TimelineCard): TimelineEvent[] {
  const e = p.engagement ?? {};
  const out: TimelineEvent[] = [];
  const first = firstRecipient({ touches: p.touches, contacts: p.contacts, draft: p.draft });
  for (const t of p.touches ?? []) {
    const opened = t.opens ? ` · opened ×${t.opens}` : '';
    const soft = t.soft_bounces ? ` · ${t.soft_bounces} soft bounce${t.soft_bounces > 1 ? 's' : ''}` : '';
    out.push({
      at: t.sent_at,
      label: `Touch ${t.n} sent`,
      detail: [t.to_email, opened + soft].filter(Boolean).join('') || null,
      touch: t,
      recipient: t.to_email ? lower(t.to_email) : first,
    });
  }
  const opens = e.opens ?? 0;
  if (opens > 0 && e.first_open_at) {
    const proxy = e.proxy_opens ?? 0;
    out.push({ at: e.first_open_at, label: opensLabel(opens, proxy), tone: opens > proxy ? 'success' : 'muted' });
    if (e.last_open_at && e.last_open_at !== e.first_open_at) out.push({ at: e.last_open_at, label: 'Last opened', tone: 'muted' });
  }
  if (e.auto_reply_at) {
    out.push({
      at: e.auto_reply_at,
      label: 'Auto-reply',
      detail: e.followup_hold_until ? `follow-ups held until ${e.followup_hold_until.slice(0, 10)}` : null,
      tone: 'muted',
    });
  }
  if (e.replied_at) {
    const after = e.time_to_reply_h != null ? `${e.time_to_reply_h} h after touch ${e.replied_touch ?? '?'}` : null;
    out.push({
      at: e.replied_at,
      label: e.reply_kind === 'reply_other_sender' ? 'Replied from another address (referred)' : 'Replied',
      detail:
        [
          e.replied_to_email ? `to ${recipientName(p, e.replied_to_email)}` : null,
          after,
          (e.replies ?? 0) > 1 ? `${e.replies} replies` : null,
        ]
          .filter(Boolean)
          .join(' · ') || null,
      tone: 'success',
    });
  }
  const bounces = addressBounces(p);
  for (const b of bounces) out.push({ at: b.at, label: 'Bounced (hard)', detail: recipientName(p, b.email), recipient: b.email, tone: 'error' });
  // With per-address bounces, the card-level hard bounce repeats the latest one.
  if (e.bounced_at && !(bounces.length && e.bounce_kind === 'hard')) {
    out.push({ at: e.bounced_at, label: `Bounced (${e.bounce_kind ?? 'unknown'})`, tone: 'error' });
  }
  if (e.unsubscribed_at) out.push({ at: e.unsubscribed_at, label: 'Unsubscribed', tone: 'warning' });
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

export interface RecipientGroup {
  email: string;
  contact?: Contact;
  /** `engagement.recipients[]`'s row for it, when Hermes publishes one. */
  row?: RecipientEngagement;
  bounced_at?: string | null;
}

/** The card's recipients in first-sent order: `engagement.recipients` when
 * present, else the addresses its touches went to. */
export function recipientGroups(p: TimelineCard): RecipientGroup[] {
  const rows = p.engagement?.recipients ?? [];
  const emails = rows.length ? rows.map((r) => lower(r.to_email)) : recipientsOf({ touches: p.touches, contacts: p.contacts, draft: p.draft });
  return emails.map((email) => {
    const contact = contactFor(p, email);
    const row = rows.find((r) => lower(r.to_email) === email);
    return { email, contact, row, bounced_at: contact?.bounce_hard_at ?? row?.bounce_hard_at ?? null };
  });
}
