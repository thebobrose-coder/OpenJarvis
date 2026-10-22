import { useEffect, useMemo, useRef, useState } from 'react';
import { BookmarkPlus, ChevronDown } from 'lucide-react';
import {
  sendBlock,
  sendRequest,
  touchOf,
  type PipelineProspect,
  type Screen,
  type SendConfig,
  type SendRequest,
  type SendResult,
  type Template,
  type TemplateSave,
} from '../../lib/bizdev-api';
import {
  charsChanged,
  fillSender,
  footerPreview,
  mergeText,
  mergeValues,
  screenReason,
  templateSourceId,
  templatesFor,
  withoutFooter,
  type MergeValues,
} from '../../lib/bizdev-compose';
import { Quiet, SmallButton } from '../shared/ui';
import { MailActions } from './MailActions';
import { TemplateEditor } from './Templates';

const field = {
  background: 'var(--color-bg-secondary)',
  color: 'var(--color-text)',
  border: '1px solid var(--color-border)',
} as const;

const HERMES = 'hermes';

/** The line a draft is composed for: its screen and its templates. */
export interface ComposeLine {
  line: string;
  screen?: Screen;
  templates?: Template[];
}

/** The text a choice starts from, and its `draft_source`; what is sent is
 * compared against it for `draft_edited`. A template is merged from the
 * card; the Hermes draft gets only the sender's fields, which Hermes leaves
 * for the page, and loses the line's footer, which the server adds back
 * filled (the editor shows it read-only). */
export function startingText(
  choice: string,
  templates: Template[],
  draft: { subject: string; body: string; draft_source?: string | null },
  values: MergeValues,
  screen?: Screen | null,
): { subject: string; body: string; source: string } {
  const t = choice === HERMES ? null : templates.find((x) => String(x.id) === choice);
  if (t) return { subject: mergeText(t.subject, values), body: mergeText(t.body, values), source: `template:${t.id}` };
  return {
    subject: fillSender(draft.subject, values),
    body: withoutFooter(fillSender(draft.body, values), screen),
    source: draft.draft_source || HERMES,
  };
}

/** Send's To starts at the contact the draft is for, when it is one of the
 * card's contacts with an address that hasn't hard-bounced; else the first
 * such contact; else the first with an address (listed, but disabled). */
export function initialRecipient(
  contacts: { email?: string | null; bounce_hard_at?: string | null }[],
  draftTo: string | null | undefined,
): string {
  const want = (draftTo ?? '').toLowerCase();
  const live = contacts.filter((c) => c.email && !c.bounce_hard_at);
  const hit = want ? live.find((c) => (c.email ?? '').toLowerCase() === want) : undefined;
  return hit?.email ?? live[0]?.email ?? contacts.find((c) => c.email)?.email ?? '';
}

/**
 * One draft for one touch, shared by the prospect drawer (touch 1) and the
 * follow-ups strip (touches 2 and 3), so both paths behave the same:
 *
 * - **Template**: "Hermes draft" first, then the line's templates for this
 *   touch and for any touch. Picking one fills the subject and body with its
 *   merge fields resolved from the card; a field the card can't fill stays
 *   as `{{field}}` and blocks Send with its name.
 * - The subject and body are edited in place; edits are never saved back to
 *   Hermes. Send carries the source (`hermes` / `template:<id>`) and how
 *   many characters were changed (`draft_edited`).
 * - The line's screen runs here as an early warning; the server runs it
 *   again before anything is sent.
 * - **Save as template…** saves the current text (without the footer).
 */
export function DraftComposer({
  prospect,
  line,
  touch,
  draft,
  sendConfig,
  onSend,
  onMarkSent,
  sentLabel,
  blocked,
  onSaveTemplate,
  compact = false,
}: {
  prospect: PipelineProspect;
  line: ComposeLine | null | undefined;
  touch: number;
  /** Hermes's draft for this touch (a follow-up's may come from a default template). */
  draft: { subject: string; body: string; draft_source?: string | null; to_email?: string | null };
  sendConfig: SendConfig | null;
  onSend?: (req: SendRequest) => Promise<SendResult>;
  onMarkSent: () => void;
  sentLabel?: string;
  /** Why this draft can't be sent at all; per-recipient checks (touch
   * number, bounced, the 3-recipient cap) run here on the chosen To. */
  blocked?: string | null;
  onSaveTemplate?: (t: TemplateSave) => Promise<void>;
  /** The strip: the editor folds away under "Edit". */
  compact?: boolean;
}) {
  const contacts = prospect.contacts ?? [];
  const [to, setTo] = useState(() => initialRecipient(contacts, draft.to_email));
  // A card with no address yet picks up the first one Hermes publishes
  // (an operator's "Add recipient" shows at the next refresh).
  const firstPick = initialRecipient(contacts, draft.to_email);
  useEffect(() => {
    if (!to && firstPick) setTo(firstPick);
  }, [to, firstPick]);
  const [choice, setChoice] = useState<string>(HERMES);
  const [open, setOpen] = useState(!compact);
  const [saving, setSaving] = useState(false);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const templates = line?.templates ?? [];
  const groups = templatesFor(templates, touch);
  const values = useMemo(() => mergeValues(prospect, to, sendConfig), [prospect, to, sendConfig]);

  const base = useMemo(
    () => startingText(choice, templates, draft, values, line?.screen),
    [choice, templates, draft.subject, draft.body, draft.draft_source, values, line?.screen], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const [subject, setSubject] = useState(base.subject);
  const [body, setBody] = useState(base.body);
  // Another template replaces the editor's text. A new starting text for the
  // same choice (another recipient's merge, a new Hermes draft) replaces it
  // only when it wasn't edited; a pipeline refresh that changes nothing
  // leaves it alone.
  const prev = useRef({ choice, subject: base.subject, body: base.body });
  useEffect(() => {
    const p = prev.current;
    if (choice !== p.choice || (subject === p.subject && body === p.body)) {
      setSubject(base.subject);
      setBody(base.body);
    }
    prev.current = { choice, subject: base.subject, body: base.body };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the edited text is read, not watched
  }, [choice, base.subject, base.body]);

  const sendOn = !!sendConfig?.enabled && !!onSend;
  const sentTouch = to ? touchOf(prospect, touch, to) : undefined;
  const screened = sendOn ? screenReason(line?.screen, subject, body) : null;
  const sourceId = templateSourceId(base.source);
  const goneTemplate =
    sourceId != null && !templates.some((t) => t.id === sourceId && !t.archived_at)
      ? 'Its template was archived; pick another or the Hermes draft'
      : null;
  const footer = footerPreview(line?.screen, values.sender_name);
  const edited = charsChanged(`${base.subject}\n${base.body}`, `${subject}\n${body}`);

  const editor = (
    <>
      <input
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        aria-label="Subject"
        className="rounded-md px-2 py-1.5"
        style={field}
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        aria-label="Body"
        rows={compact ? 7 : 10}
        className="rounded-md px-2 py-1.5 resize-y leading-relaxed"
        style={field}
      />
      {footer && (
        <pre
          className="text-[11px] whitespace-pre-wrap font-[inherit] m-0 px-2"
          style={{ color: 'var(--color-text-tertiary)' }}
          aria-label="Footer added on send"
          title="Added to every mail when it is sent"
        >
          {footer}
        </pre>
      )}
      <span className="text-[10.5px]" style={{ color: 'var(--color-text-tertiary)' }}>
        {sendOn
          ? 'Send sends the text as edited here, with the footer filled in; edits aren’t saved back to Hermes.'
          : 'Edits stay on this screen; they aren’t saved or sent anywhere.'}
      </span>
    </>
  );

  return (
    <div className="flex flex-col gap-2" data-composer-touch={touch}>
      {groups.length > 0 && (
        <label className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
          Template
          <select
            value={choice}
            onChange={(e) => setChoice(e.target.value)}
            aria-label="Template"
            className="rounded-md px-1.5 py-1 text-[11.5px] cursor-pointer max-w-[16rem]"
            style={field}
          >
            <option value={HERMES}>{draft.draft_source && draft.draft_source !== HERMES ? 'Hermes draft (from a template)' : 'Hermes draft'}</option>
            {groups.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.items.map((t) => (
                  <option key={t.id} value={String(t.id)}>
                    {t.name}
                    {t.default_for_touch ? ' (default)' : ''}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
      )}

      {compact && !open ? (
        <div className="flex items-center gap-2">
          <span className="text-[12px] min-w-0 truncate" style={{ color: 'var(--color-text)' }} title={subject}>
            {subject}
          </span>
          <SmallButton onClick={() => setOpen(true)} title="Edit the subject and body">
            Edit <ChevronDown size={11} />
          </SmallButton>
        </div>
      ) : (
        editor
      )}

      {screened && <Quiet>Withheld by the screen: {screened}</Quiet>}

      <MailActions
        key={`${prospect.id}-${touch}`}
        contacts={contacts}
        subject={subject}
        body={body}
        to={to}
        onToChange={setTo}
        sentLabel={sentLabel}
        onMarkSent={onMarkSent}
        send={
          sendOn
            ? {
                config: sendConfig!,
                blocked: blocked ?? sendBlock(prospect, to, touch) ?? (screened ? `Withheld by the screen: ${screened}` : goneTemplate),
                status: sentTouch?.fe_status ?? null,
                error: sentTouch?.fe_error ?? null,
                onSend: (recipient, fromName) =>
                  onSend!(
                    sendRequest(prospect, {
                      touch,
                      to: recipient,
                      fromName,
                      subject,
                      body,
                      draftSource: base.source,
                      draftEdited: edited,
                    }),
                  ),
              }
            : null
        }
      />

      {onSaveTemplate && line && (
        saving ? (
          <TemplateEditor
            title="Save as template"
            initial={{ line: line.line, name: '', touch: touch as 1 | 2 | 3, subject, body: withoutFooter(body, line.screen) }}
            onSave={async (t) => {
              await onSaveTemplate(t);
              setSaving(false);
              setSavedNote('Template saved; it shows up within about 2 minutes.');
            }}
            onCancel={() => setSaving(false)}
          />
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <SmallButton onClick={() => setSaving(true)} title="Save this subject and body as a template; put {{fields}} in place of names first">
              <BookmarkPlus size={11} /> Save as template…
            </SmallButton>
            {savedNote && (
              <span className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }} role="status">
                {savedNote}
              </span>
            )}
          </div>
        )
      )}
    </div>
  );
}
