import { useState } from 'react';
import { ChevronDown, Copy, Loader2, Mail, Send } from 'lucide-react';
import { unresolvedFields, type Contact, type FeStatus, type SendConfig, type SendResult } from '../../lib/bizdev-api';
import { Chip, SmallButton, type Tone } from '../shared/ui';
import { buildMailto, copyText, openMailto } from './mail';

const FE_TONE: Record<FeStatus, Tone> = {
  pending: 'muted',
  queued: 'muted',
  deferred: 'warning',
  rejected: 'error',
  sent: 'success',
};

/** A sent touch's delivery status (contract v0.10 `fe_status`). */
export function FeStatusChip({ status }: { status: FeStatus | null | undefined }) {
  if (!status) return null;
  return (
    <Chip tone={FE_TONE[status] ?? 'muted'} title="Delivery status from Forward Email">
      {status}
    </Chip>
  );
}

/** Send through Forward Email (hq 0018), when the server has it configured. */
export interface SendMode {
  config: SendConfig;
  /** Why this draft can't be sent now (already sent, not the next touch). */
  blocked?: string | null;
  /** The touch's delivery status when it was already sent. */
  status?: FeStatus | null;
  onSend: (to: string, fromName: string) => Promise<SendResult>;
}

/**
 * The send controls for one draft, shared by the prospect drawer and the
 * follow-ups strip so both paths behave the same.
 *
 * With Send configured: a From name, the To choice and **Send** (the server
 * sends and records the touch; there is no "Mark as sent"), with the mail
 * link and the copy buttons under "More". Without it: Open in mail / Copy
 * subject / Copy body, then "Mark as sent?", as before.
 */
export function MailActions({
  contacts,
  subject,
  body,
  onMarkSent,
  sentLabel = 'Mark as sent?',
  send,
}: {
  contacts: Contact[];
  subject: string;
  body: string;
  onMarkSent: () => void;
  sentLabel?: string;
  send?: SendMode | null;
}) {
  const withEmail = contacts.filter((c) => c.email);
  const [to, setTo] = useState(withEmail[0]?.email ?? '');
  const [askSent, setAskSent] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [fromName, setFromName] = useState(send?.config.sender_name ?? '');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<SendResult | null>(null);
  const mailto = buildMailto(to, subject, body);
  const sendOn = !!send?.config.enabled;

  const copy = async (text: string, what: string) => {
    setStatus((await copyText(text)) ? `${what} copied` : `Couldn’t copy ${what.toLowerCase()}`);
  };

  const open = async () => {
    if (!mailto.ok) return;
    await openMailto(mailto.href);
    if (!sendOn) setAskSent(true);
  };

  const fields = unresolvedFields(subject, body);
  const sendBlocked = !sendOn
    ? null
    : result
      ? 'Sent'
      : send!.blocked ??
        (!to
          ? 'No contact email on file'
          : !body.trim() || !subject.trim()
            ? 'The subject and body can’t be empty'
            : fields.length
              ? `Unresolved merge field: ${fields.map((f) => `{{${f}}}`).join(', ')}`
              : null);

  const doSend = async () => {
    if (!send || sendBlocked) return;
    setSending(true);
    setStatus(null);
    try {
      setResult(await send.onSend(to, fromName));
    } catch (e: unknown) {
      setStatus(e instanceof Error ? e.message : 'Send failed');
    } finally {
      setSending(false);
    }
  };

  const toPicker = withEmail.length > (sendOn ? 0 : 1) && (
    <label className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
      To
      <select
        value={to}
        onChange={(e) => setTo(e.target.value)}
        className="rounded-md px-1.5 py-1 text-[11.5px] cursor-pointer"
        style={{ background: 'var(--color-bg-secondary)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
      >
        {withEmail.map((c) => (
          <option key={c.email!} value={c.email!}>
            {c.name}
            {c.title ? ` -- ${c.title}` : ''}
          </option>
        ))}
      </select>
    </label>
  );

  const mailButtons = (
    <>
      <SmallButton
        tone={sendOn ? 'neutral' : 'accent'}
        onClick={() => void open()}
        disabled={!mailto.ok}
        title={
          mailto.ok
            ? 'Opens a new message in your mail app'
            : mailto.reason === 'no_address'
              ? 'No contact email -- copy the text instead'
              : 'Too long for a mail link -- copy the subject and body instead'
        }
      >
        <Mail size={11} /> Open in mail
      </SmallButton>
      <SmallButton onClick={() => void copy(subject, 'Subject')}>
        <Copy size={11} /> Copy subject
      </SmallButton>
      <SmallButton onClick={() => void copy(body, 'Body')}>
        <Copy size={11} /> Copy body
      </SmallButton>
    </>
  );

  const statusLine = status && (
    <span className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }} role="status">
      {status}
    </span>
  );

  if (sendOn) {
    const shown = result?.fe_status ?? send!.status ?? null;
    return (
      <div className="flex flex-col gap-2" data-send-mode="forwardemail">
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
            From
            <input
              value={fromName}
              onChange={(e) => setFromName(e.target.value.slice(0, 100))}
              aria-label="From name"
              className="rounded-md px-1.5 py-1 text-[11.5px] w-36"
              style={{ background: 'var(--color-bg-secondary)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
            />
          </label>
          {toPicker}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <SmallButton tone="accent" onClick={() => void doSend()} disabled={!!sendBlocked || sending} title={sendBlocked ?? `Send from ${send!.config.sender_address}`}>
            {sending ? <Loader2 size={11} className="animate-spin" /> : <Send size={11} />} {sending ? 'Sending…' : 'Send'}
          </SmallButton>
          <FeStatusChip status={shown} />
          <SmallButton onClick={() => setMore((m) => !m)} title="Mail link and copy buttons">
            More <ChevronDown size={11} />
          </SmallButton>
          {sendBlocked && sendBlocked !== 'Sent' && !result && (
            <span className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
              {sendBlocked}
            </span>
          )}
          {result && (
            <span className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }} role="status">
              {result.recorded ? 'Sent; Hermes records it within a few minutes.' : 'Sent; the record is queued and retries on its own.'}
            </span>
          )}
          {statusLine}
        </div>
        {more && <div className="flex flex-wrap items-center gap-1.5">{mailButtons}</div>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {toPicker}

      <div className="flex flex-wrap items-center gap-1.5">
        {mailButtons}
        {!mailto.ok && (
          <span className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
            {mailto.reason === 'no_address'
              ? 'No contact email on file -- copy and paste instead.'
              : 'Too long for a mail link -- copy and paste instead.'}
          </span>
        )}
        {statusLine}
      </div>

      {(askSent || !mailto.ok) && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-md px-2 py-1.5 text-[12px]"
          style={{ background: 'var(--color-bg-secondary)' }}
        >
          <span>{askSent ? sentLabel : 'Sent it from your mail?'}</span>
          <SmallButton
            tone="success"
            onClick={() => {
              setAskSent(false);
              onMarkSent();
            }}
          >
            <Send size={11} /> Yes, mark sent
          </SmallButton>
          {askSent && <SmallButton onClick={() => setAskSent(false)}>Not yet</SmallButton>}
        </div>
      )}
    </div>
  );
}
