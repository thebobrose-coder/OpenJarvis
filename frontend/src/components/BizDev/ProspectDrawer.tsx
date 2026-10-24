import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { CalendarCheck, MessagesSquare, RotateCw, UserPlus, X } from 'lucide-react';
import {
  CONTACT_FIELD_MAX,
  EMAIL_MAX,
  MAX_CONTACTS,
  SUPPRESSION_STAGES,
  contactProblem,
  rankBreakdown,
  rankNumber,
  recheckReason,
  type Contact,
  type ContactAdd,
  type FollowUp,
  type PipelineProspect,
  type RecheckResult,
  type SendConfig,
  type SendResult,
  type SendRequest,
  type StageAction,
  type SuppressionStage,
  type TemplateSave,
} from '../../lib/bizdev-api';
import {
  engagementTimeline,
  proposesMeeting,
  recipientGroups,
  recipientName,
  templatesFor,
  touchTiming,
  type TimelineEvent,
} from '../../lib/bizdev-compose';
import { shortDateTime } from '../shared/format';
import { Chip, ExtLink, Quiet, SmallButton } from '../shared/ui';
import { DraftComposer, type ComposeLine } from './DraftComposer';
import { FeStatusChip } from './MailActions';
import { followUpRecipient } from './FollowUpsStrip';
import { EngagementChips, MeetingChip, RankChip, STAGE_LABELS } from './PipelineBoard';

const OUTCOMES: StageAction[] = ['replied', 'meeting', 'won', 'lost', 'not_interested', 'do_not_contact', 'bounced'];
const isSuppression = (s: string): s is SuppressionStage => (SUPPRESSION_STAGES as readonly string[]).includes(s);

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: 'var(--color-text-tertiary)' }}>
        {title}
      </h3>
      {children}
    </section>
  );
}

/**
 * What the last re-check found. When the new result was worse, Hermes kept
 * the earlier research, so the drawer says so and summarises what was
 * discarded -- a muted note for a manual look, not an error.
 */
export function RecheckNote({ recheck }: { recheck: RecheckResult }) {
  const reason = recheck.kept_previous ? recheckReason(recheck) : null;
  return (
    <div className="flex flex-col gap-0.5 text-[11.5px]" style={{ color: 'var(--color-text-tertiary)' }}>
      <span>Re-checked {shortDateTime(recheck.at)}</span>
      {recheck.kept_previous && (
        <>
          <span>New result was worse, so the earlier research was kept.</span>
          <span>
            New result: fit {recheck.fit_score ?? '—'}, {recheck.contacts ?? 0} contact{recheck.contacts === 1 ? '' : 's'}
            {reason ? ` -- ${reason}` : ''}
          </span>
        </>
      )}
    </div>
  );
}

const TONE_COLOR: Record<NonNullable<TimelineEvent['tone']>, string> = {
  success: 'var(--color-success)',
  warning: 'var(--color-warning)',
  error: 'var(--color-error)',
  muted: 'var(--color-text-tertiary)',
};

function EventItem({ ev }: { ev: TimelineEvent }) {
  const timing = ev.touch ? touchTiming(ev.touch) : [];
  return (
    <li className="flex flex-wrap items-center gap-1.5" data-event={ev.label} {...(ev.touch ? { 'data-touch': ev.touch.n } : {})}>
      <span style={{ color: ev.tone ? TONE_COLOR[ev.tone] : 'var(--color-text)' }}>{ev.label}</span> · {shortDateTime(ev.at)}
      {ev.detail && <span>· {ev.detail}</span>}
      {ev.touch && <FeStatusChip status={ev.touch.fe_status} error={ev.touch.fe_error} />}
      {ev.touch?.fe_error && (ev.touch.fe_status === 'deferred' || ev.touch.fe_status === 'rejected') && (
        <span className="basis-full text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
          {ev.touch.fe_error}
        </span>
      )}
      {timing.length > 0 && (
        <span className="basis-full text-[11px]" style={{ color: 'var(--color-text-tertiary)' }} data-timing>
          {timing.join(' · ')}
        </span>
      )}
    </li>
  );
}

/** Sends and what came back (Part B): delivery, opens (proxy prefetches
 * marked), replies, auto-replies, bounces, unsubscribes, in time order. A
 * card sent to more than one address (v0.10.7) lists each recipient with
 * its own touches and bounce, then the card's other events. */
export function EngagementTimeline({
  prospect,
}: {
  prospect: Pick<PipelineProspect, 'touches' | 'engagement'> & Partial<Pick<PipelineProspect, 'contacts' | 'draft'>>;
}) {
  const events = engagementTimeline(prospect);
  const groups = recipientGroups(prospect);
  if (groups.length <= 1) {
    return (
      <ol className="flex flex-col gap-1">
        {events.map((ev, i) => (
          <EventItem key={i} ev={ev} />
        ))}
      </ol>
    );
  }
  const rest = events.filter((ev) => !ev.recipient);
  return (
    <div className="flex flex-col gap-2.5">
      {groups.map((g) => {
        const name = recipientName(prospect, g.email);
        const row = g.row;
        return (
          <div key={g.email} className="flex flex-col gap-1" data-recipient={g.email}>
            <div className="flex flex-wrap items-center gap-1.5">
              <span style={{ color: 'var(--color-text)' }}>{name}</span>
              {name !== g.email && <span className="text-[11px]">{g.email}</span>}
              {g.bounced_at && <Chip tone="error">bounced</Chip>}
              {row?.replied_at && <Chip tone="success">replied</Chip>}
              {row && (
                <span className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
                  {row.touches} touch{row.touches === 1 ? '' : 'es'}
                  {row.opens ? ` · opened ×${row.opens}` : ''}
                </span>
              )}
            </div>
            <ol className="flex flex-col gap-1 pl-3">
              {events
                .filter((ev) => ev.recipient === g.email)
                .map((ev, i) => (
                  <EventItem key={i} ev={ev} />
                ))}
            </ol>
          </div>
        );
      })}
      {rest.length > 0 && (
        <ol className="flex flex-col gap-1">
          {rest.map((ev, i) => (
            <EventItem key={i} ev={ev} />
          ))}
        </ol>
      )}
    </div>
  );
}

const input = {
  background: 'var(--color-bg-secondary)',
  color: 'var(--color-text)',
  border: '1px solid var(--color-border)',
} as const;

/** What the page knows about an "Add recipient" it sent: Hermes confirms
 * only by publishing the contact, and drops a refused one silently. */
export type ContactNote = 'saved' | 'not_accepted';

export const CONTACT_NOTES: Record<ContactNote, string> = {
  saved: 'Saved; appears after the next refresh (about 2 minutes).',
  not_accepted: 'Hermes did not accept this address (free-mail, duplicate, suppressed card or the 3-contact cap).',
};

/**
 * "Add recipient" (hq 0018 A3): name, title and email, saved as a contact
 * through the bridge. Open when the card has no contacts, behind a link
 * otherwise; off at 3 contacts of any source. The page checks the address's
 * shape and length; Hermes checks the rest.
 */
export function AddRecipientForm({
  contacts,
  onAdd,
  note,
}: {
  contacts: Contact[];
  onAdd: (c: ContactAdd) => Promise<void>;
  note?: ContactNote | null;
}) {
  const [open, setOpen] = useState(contacts.length === 0);
  const [form, setForm] = useState<ContactAdd>({ name: '', title: '', email: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const full = contacts.length >= MAX_CONTACTS;
  const problem = contactProblem(form);

  const save = async () => {
    if (saving || full || problem) return;
    setSaving(true);
    setError(null);
    try {
      await onAdd(form);
      setForm({ name: '', title: '', email: '' });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Saving failed');
    } finally {
      setSaving(false);
    }
  };

  const status = (error || note) && (
    <span className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }} role="status">
      {error ?? CONTACT_NOTES[note!]}
    </span>
  );

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-2" data-add-recipient="collapsed">
        <button
          onClick={() => setOpen(true)}
          disabled={full}
          title={full ? `This card has ${MAX_CONTACTS} contacts, the most it can hold` : 'Add an address to send to'}
          className="flex items-center gap-1 text-[11.5px] cursor-pointer disabled:cursor-default disabled:opacity-50 p-0"
          style={{ background: 'transparent', border: 'none', color: 'var(--color-accent)' }}
        >
          <UserPlus size={11} /> Add recipient
        </button>
        {full && <span className="text-[11px]">{MAX_CONTACTS} contacts is the most a card holds.</span>}
        {status}
      </div>
    );
  }

  const set = (k: keyof ContactAdd, max: number) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value.slice(0, max) }));

  return (
    <div className="flex flex-col gap-1.5 rounded-md p-2" style={{ background: 'var(--color-bg-secondary)' }} data-add-recipient="open">
      <span className="text-[11px] font-medium" style={{ color: 'var(--color-text)' }}>
        Add recipient
      </span>
      <div className="flex flex-wrap gap-1.5">
        <input aria-label="Name" placeholder="Name" value={form.name} onChange={set('name', CONTACT_FIELD_MAX)} className="rounded-md px-1.5 py-1 text-[11.5px] w-36" style={input} disabled={full} />
        <input aria-label="Title" placeholder="Title" value={form.title} onChange={set('title', CONTACT_FIELD_MAX)} className="rounded-md px-1.5 py-1 text-[11.5px] w-40" style={input} disabled={full} />
        <input aria-label="Email" placeholder="Email" type="email" value={form.email} onChange={set('email', EMAIL_MAX + 1)} className="rounded-md px-1.5 py-1 text-[11.5px] w-52" style={input} disabled={full} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <SmallButton tone="accent" onClick={() => void save()} disabled={full || saving || !!problem} title={full ? undefined : problem ?? 'Save it as a contact on this card'}>
          {saving ? 'Saving…' : 'Save'}
        </SmallButton>
        {full ? (
          <span className="text-[11px]">This card has {MAX_CONTACTS} contacts, the most it can hold.</span>
        ) : (
          form.email.trim() && problem && <span className="text-[11px]">{problem}</span>
        )}
        {status}
      </div>
      <span className="text-[10.5px]" style={{ color: 'var(--color-text-tertiary)' }}>
        Hermes refuses free-mail addresses, duplicates and a 4th contact. It doesn’t re-draft: Send’s To offers the address.
      </span>
    </div>
  );
}

/** "Permanent" confirmation for the three suppression outcomes. */
export function SuppressionConfirm({
  stage,
  name,
  onConfirm,
  onCancel,
}: {
  stage: SuppressionStage;
  name: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      role="alertdialog"
      aria-label={`Confirm ${STAGE_LABELS[stage]}`}
      className="flex flex-col gap-2 rounded-lg p-3"
      style={{ border: '1px solid var(--color-warning)', background: 'var(--color-bg-secondary)' }}
    >
      <p style={{ color: 'var(--color-text)' }}>
        Mark {name} as <strong>{STAGE_LABELS[stage].toLowerCase()}</strong>?
      </p>
      <p className="text-[11.5px]">
        This is permanent: the prospect leaves the pipeline and Hermes will never research or draft for it again.
      </p>
      <div className="flex gap-1.5">
        <SmallButton tone="warning" onClick={onConfirm}>
          Yes, permanently
        </SmallButton>
        <SmallButton onClick={onCancel}>Cancel</SmallButton>
      </div>
    </div>
  );
}

export function ProspectDrawer({
  prospect,
  onClose,
  onMove,
  onRecheck,
  recheckDisabled,
  rechecksToday,
  recheckCap,
  sendConfig = null,
  onSend,
  line,
  onSaveTemplate,
  onAddContact,
  contactNote = null,
  onConfirmMeeting,
  followUp = null,
  onMarkFollowUpSent,
  deskDraft = null,
  onAskDesk,
}: {
  prospect: PipelineProspect;
  onClose: () => void;
  onMove: (stage: StageAction, note: string) => void;
  onRecheck: () => void;
  recheckDisabled: boolean;
  rechecksToday: number;
  recheckCap: number;
  /** Send through Forward Email (hq 0018); null or disabled keeps the mail link path. */
  sendConfig?: SendConfig | null;
  onSend?: (req: SendRequest) => Promise<SendResult>;
  /** The prospect's line: its screen and templates (Part C). */
  line?: ComposeLine | null;
  onSaveTemplate?: (t: TemplateSave) => Promise<void>;
  /** "Add recipient" (A3); absent hides the form. */
  onAddContact?: (c: ContactAdd) => Promise<void>;
  contactNote?: ContactNote | null;
  /** Part D: the stage move to Meeting, with the calendar note. */
  onConfirmMeeting?: () => Promise<void>;
  /** This card's due follow-up: the drawer's Draft is that touch, as in the strip. */
  followUp?: FollowUp | null;
  onMarkFollowUpSent?: (touch: number) => void;
  /** A BD desk card's draft (hq 0020 P2), placed in the message field. Send
   * is still this drawer's own button. */
  deskDraft?: string | null;
  /** "Ask the desk": open a BD desk thread with this card as context. */
  onAskDesk?: () => void;
}) {
  const closeButton = (
    <button onClick={onClose} aria-label="Close" className="cursor-pointer p-1" style={{ background: 'transparent', border: 'none', color: 'inherit' }}>
      <X size={14} />
    </button>
  );
  const [note, setNote] = useState('');
  const [confirm, setConfirm] = useState<SuppressionStage | null>(null);
  // 'idle' | 'posting' | 'posted', or the error message.
  const [meeting, setMeeting] = useState('idle');

  useEffect(() => {
    setNote('');
    setConfirm(null);
    setMeeting('idle');
  }, [prospect.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const decide = (stage: StageAction) => {
    if (isSuppression(stage)) setConfirm(stage);
    else onMove(stage, note);
  };
  const contacts = prospect.contacts ?? [];
  const signals = prospect.signals ?? {};

  const drawer = (
    <div className="fixed inset-0 z-[70] flex justify-end" style={{ background: 'rgba(0,0,0,0.35)' }} onClick={onClose}>
      <aside
        role="dialog"
        aria-label={prospect.name}
        onClick={(e) => e.stopPropagation()}
        className="h-full w-full max-w-[34rem] overflow-y-auto flex flex-col gap-4 p-5 text-[12.5px]"
        style={{ background: 'var(--color-surface)', borderLeft: '1px solid var(--color-border)', color: 'var(--color-text-secondary)' }}
      >
        <header className="flex items-start justify-between gap-2">
          <div className="flex flex-col gap-1">
            <h2 className="text-[15px] font-semibold" style={{ color: 'var(--color-text)' }}>
              {prospect.name}
            </h2>
            <span>{[prospect.association, prospect.division, prospect.conference, prospect.state].filter(Boolean).join(' · ')}</span>
            <div className="flex flex-wrap items-center gap-1.5">
              <Chip tone="accent">{STAGE_LABELS[prospect.stage] ?? prospect.stage}</Chip>
              <RankChip p={prospect} />
              {prospect.fit_score != null && <Chip>fit {prospect.fit_score} / 5</Chip>}
              {prospect.affiliation && <Chip tone="muted">{prospect.affiliation}</Chip>}
              {prospect.days_in_stage != null && <Chip tone="muted">{prospect.days_in_stage} d in stage</Chip>}
              <EngagementChips p={prospect} />
            </div>
            {proposesMeeting(prospect) && (
              <div className="flex flex-wrap items-center gap-1.5" data-meeting-proposal>
                <MeetingChip p={prospect} />
                {onConfirmMeeting && (
                  <SmallButton
                    tone="success"
                    disabled={meeting === 'posting' || meeting === 'posted'}
                    title="Move this card to Meeting"
                    onClick={() => {
                      setMeeting('posting');
                      onConfirmMeeting().then(
                        () => setMeeting('posted'),
                        (e: unknown) => setMeeting(e instanceof Error ? e.message : 'Confirm failed'),
                      );
                    }}
                  >
                    <CalendarCheck size={11} /> Confirm
                  </SmallButton>
                )}
                {meeting !== 'idle' && meeting !== 'posting' && (
                  <span className="text-[11px]" role="status">
                    {meeting === 'posted' ? 'Confirmed; the card moves at the next refresh.' : meeting}
                  </span>
                )}
              </div>
            )}
            <div className="flex flex-wrap gap-3 text-[11.5px]" style={{ color: 'var(--color-accent)' }}>
              {prospect.website && <ExtLink url={prospect.website}>Website</ExtLink>}
              {prospect.athletics_url && <ExtLink url={prospect.athletics_url}>Athletics site</ExtLink>}
              {prospect.directory_url && <ExtLink url={prospect.directory_url}>Staff directory</ExtLink>}
            </div>
          </div>
          {onAskDesk ? (
            <div className="flex items-start gap-1 shrink-0">
              <SmallButton onClick={onAskDesk} title="Open a BD desk thread with this card as context">
                <MessagesSquare size={11} /> Ask the desk
              </SmallButton>
              {closeButton}
            </div>
          ) : (
            closeButton
          )}
        </header>

        {(prospect.fit_rationale || prospect.rank) && (
          <Section title="Why it fits">
            {prospect.fit_rationale && <p style={{ color: 'var(--color-text)' }}>{prospect.fit_rationale}</p>}
            {prospect.rank && (
              <p className="text-[11.5px] tabular-nums">
                Rank {rankNumber(prospect.rank.score)}: {rankBreakdown(prospect)}
              </p>
            )}
          </Section>
        )}

        <Section title="Signals">
          <div className="flex flex-wrap gap-1.5">
            {signals.platform && <Chip>platform: {signals.platform}</Chip>}
            <Chip tone={signals.directory_found ? 'success' : 'muted'}>
              {signals.directory_found ? 'directory found' : 'no directory'}
            </Chip>
            {signals.latest_date_on_home && <Chip tone="muted">latest post {signals.latest_date_on_home}</Chip>}
          </div>
          {(prospect.signal_notes?.length ?? 0) > 0 && (
            <ul className="list-disc pl-4 flex flex-col gap-0.5">
              {prospect.signal_notes!.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
          {(prospect.sources?.length ?? 0) > 0 && (
            <div className="flex flex-wrap gap-x-3 text-[11px]" style={{ color: 'var(--color-accent)' }}>
              {prospect.sources!.map((s, i) => (
                <ExtLink key={i} url={s}>
                  source {i + 1}
                </ExtLink>
              ))}
            </div>
          )}
          {prospect.triage?.reason && (
            <p className="text-[11.5px]">
              <span style={{ color: 'var(--color-text-tertiary)' }}>Triage ({prospect.triage.engine ?? 'local'}): </span>
              {prospect.triage.reason}
            </p>
          )}
        </Section>

        <Section title="Contacts (official directory)">
          {contacts.length === 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <Chip tone="warning">no contacts</Chip>
              <span className="text-[11.5px]">Re-check asks Hermes to look again.</span>
            </div>
          ) : (
            <ul className="flex flex-col gap-1">
              {contacts.map((c, i) => (
                <li key={i}>
                  <span style={{ color: 'var(--color-text)' }}>{c.name}</span>
                  {c.title ? ` -- ${c.title}` : ''}
                  {c.source === 'operator' && (
                    <>
                      {' '}
                      <Chip tone="muted">added by you</Chip>
                    </>
                  )}
                  {c.bounce_hard_at && (
                    <>
                      {' '}
                      <Chip tone="error" title={`Hard bounce ${shortDateTime(c.bounce_hard_at)}`}>
                        bounced
                      </Chip>
                    </>
                  )}
                  <div className="text-[11.5px]">{[c.email, c.phone].filter(Boolean).join(' · ')}</div>
                </li>
              ))}
            </ul>
          )}
          {onAddContact && !isSuppression(prospect.stage) && (
            <AddRecipientForm key={prospect.id} contacts={contacts} onAdd={onAddContact} note={contactNote} />
          )}
        </Section>

        <Section title={followUp ? `Draft: follow-up, touch ${followUp.touch}` : 'Draft'}>
          {deskDraft && (
            <p role="note" className="text-[11px]" style={{ color: 'var(--color-accent)' }}>
              The BD desk’s draft is in the message below. Nothing is sent until you press Send.
            </p>
          )}
          {followUp ? (
            <DraftComposer
              key={`${prospect.id}-${followUp.touch}-${deskDraft ?? ''}`}
              prospect={prospect}
              line={line}
              touch={followUp.touch}
              draft={{ ...followUp.draft, to_email: followUpRecipient(followUp, prospect), draft_source: followUp.draft_source }}
              sendConfig={sendConfig}
              onSend={onSend}
              sentLabel={`Mark touch ${followUp.touch} as sent?`}
              onMarkSent={() => onMarkFollowUpSent?.(followUp.touch)}
              onSaveTemplate={onSaveTemplate}
              prefillBody={deskDraft}
            />
          ) : prospect.draft || templatesFor(line?.templates, 1).length > 0 || deskDraft ? (
            <>
              {prospect.draft?.to_role && <span className="text-[11px]">For: {prospect.draft.to_role}</span>}
              {!prospect.draft && <Quiet>No Hermes draft; pick a template.</Quiet>}
              {(prospect.draft_problems?.length ?? 0) > 0 && (
                <Quiet>Hermes flagged: {prospect.draft_problems!.join('; ')}</Quiet>
              )}
              <DraftComposer
                key={`${prospect.id}-${deskDraft ?? ''}`}
                prospect={prospect}
                line={line}
                // The drawer's draft is touch 1 unless a follow-up is due.
                touch={1}
                draft={prospect.draft ?? { subject: '', body: '' }}
                sendConfig={sendConfig}
                onSend={onSend}
                onMarkSent={() => onMove('sent', note)}
                onSaveTemplate={onSaveTemplate}
                prefillBody={deskDraft}
              />
            </>
          ) : (
            <Quiet>No draft -- Hermes drafts for the week’s top prospects.</Quiet>
          )}
        </Section>

        <Section title="Outcome">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value.slice(0, 500))}
            rows={2}
            placeholder="Optional note (kept with the stage change)"
            className="rounded-md px-2 py-1.5 resize-y"
            style={{ background: 'var(--color-bg-secondary)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
          />
          {confirm ? (
            <SuppressionConfirm
              stage={confirm}
              name={prospect.name}
              onCancel={() => setConfirm(null)}
              onConfirm={() => {
                setConfirm(null);
                onMove(confirm, note);
              }}
            />
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {OUTCOMES.map((s) => (
                <SmallButton key={s} tone={isSuppression(s) ? 'neutral' : s === 'won' ? 'success' : 'accent'} onClick={() => decide(s)}>
                  {STAGE_LABELS[s]}
                </SmallButton>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2 mt-1">
            <SmallButton onClick={onRecheck} disabled={recheckDisabled} title="Ask Hermes to research this prospect again">
              <RotateCw size={11} /> Re-check
            </SmallButton>
            <span className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
              {recheckDisabled ? 'Daily re-check cap reached' : `${rechecksToday} of ${recheckCap} re-checks used today`}
            </span>
          </div>
          {prospect.recheck && <RecheckNote recheck={prospect.recheck} />}
        </Section>

        {(prospect.touches?.length ?? 0) > 0 && (
          <Section title="Engagement">
            <EngagementTimeline prospect={prospect} />
          </Section>
        )}

        {(prospect.history?.length ?? 0) > 0 && (
          <Section title="History">
            <ol className="flex flex-col gap-1">
              {prospect.history!.map((h, i) => (
                <li key={i} className="flex flex-col">
                  <span>
                    <span style={{ color: 'var(--color-text)' }}>{STAGE_LABELS[h.stage] ?? h.stage}</span> · {shortDateTime(h.at)}
                  </span>
                  {h.note && <span className="italic">“{h.note}”</span>}
                  {h.subject && (
                    <span className="text-[11.5px]" title={h.body ?? undefined}>
                      Sent: {h.subject}
                      {h.draft_source && h.draft_source !== 'hermes' ? ` (${h.draft_source})` : ''}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </Section>
        )}
      </aside>
    </div>
  );
  // Portalled to <body>: the page content sits in its own stacking context
  // (Layout), which would otherwise keep the drawer under the header bell.
  // The server renderer used in tests has no document, so it renders inline.
  return typeof document === 'undefined' ? drawer : createPortal(drawer, document.body);
}
