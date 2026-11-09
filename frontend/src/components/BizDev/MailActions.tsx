import { createContext, useState } from 'react';
import { ChevronDown, Copy, Loader2, Mail, RefreshCw, Send } from 'lucide-react';
import {
  unresolvedFields,
  type Contact,
  type FeStatus,
  type LocalSendState,
  type SendConfig,
  type SendResult,
} from '../../lib/bizdev-api';
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
export function FeStatusChip({ status, error }: { status: FeStatus | null | undefined; error?: string | null }) {
  if (!status) return null;
  return (
    <Chip tone={FE_TONE[status] ?? 'muted'} title={error ? `Forward Email: ${error}` : 'Delivery status from Forward Email'}>
      {status}
    </Chip>
  );
}

/** Local send states by `sendCheckKey` and "Check now", for every composer
 * on the page (the 2026-11-03 follow-up). */
export interface SendChecksValue {
  states: Record<string, LocalSendState>;
  check?: (prospectId: number) => Promise<void>;
}

export const SendChecks = createContext<SendChecksValue>({ states: {} });

export const UNCONFIRMED_NOTE = 'Sent, but Forward Email didn’t confirm it. Checking…';

export function notSentNote(touch: number): string {
  return `Forward Email never received touch ${touch}. Nothing was sent. You can send it again.`;
}

/** Send through Forward Email (hq 0018), when the server has it configured. */
export interface SendMode {
  config: SendConfig;
  /** Why this draft can't be sent now (already sent, not the next touch). */
  blocked?: string | null;
  /** The touch's delivery status when it was already sent. */
  status?: FeStatus | null;
  /** Why it was deferred or rejected (v0.10.1 `fe_error`). */
  error?: string | null;
  onSend: (to: string, fromName: string) => Promise<SendResult>;
  /** This touch to this address is held unconfirmed or was never received. */
  local?: LocalSendState | null;
  touch?: number;
  /** Check now: settle an unconfirmed send by its Message-ID. */
  onCheck?: () => Promise<void>;
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
  to: toProp,
  onToChange,
}: {
  contacts: Contact[];
  subject: string;
  body: string;
  onMarkSent: () => void;
  sentLabel?: string;
  send?: SendMode | null;
  /** The recipient, when the caller merges fields for it (DraftComposer). */
  to?: string;
  onToChange?: (to: string) => void;
}) {
  const withEmail = contacts.filter((c) => c.email);
  const [toLocal, setToLocal] = useState(withEmail[0]?.email ?? '');
  const to = toProp ?? toLocal;
  const setTo = (v: string) => {
    setToLocal(v);
    onToChange?.(v);
  };
  const [askSent, setAskSent] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [fromName, setFromName] = useState(send?.config.sender_name ?? '');
  const [sending, setSending] = useState(false);
  // One click sends to one address: a send to A leaves Send open for B.
  const [results, setResults] = useState<Record<string, SendResult>>({});
  const [checking, setChecking] = useState(false);
  const local = send?.local ?? null;
  // The send log (`local`) decides: a send Forward Email never received is
  // void here. This click's result covers only the gap until Hermes shows the
  // touch (the log keeps no confirmed sends), so Send can't go twice.
  const result = local === 'not_sent' ? null : (results[to.toLowerCase()] ?? null);
  const unconfirmed = local === 'unconfirmed';
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
    : unconfirmed
      ? UNCONFIRMED_NOTE
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

  const doCheck = async () => {
    if (!send?.onCheck) return;
    setChecking(true);
    try {
      await send.onCheck();
    } finally {
      setChecking(false);
    }
  };

  const doSend = async () => {
    if (!send || sendBlocked) return;
    setSending(true);
    setStatus(null);
    try {
      const r = await send.onSend(to, fromName);
      setResults((prev) => ({ ...prev, [to.toLowerCase()]: r }));
    } catch (e: unknown) {
      setStatus(e instanceof Error ? e.message : 'Send failed');
    } finally {
      setSending(false);
    }
  };

  const toPicker = withEmail.length > (sendOn ? 0 : 1) && (
    <label className="flex items-center gap-1.5 text-ui-11" style={{ color: 'var(--color-text-tertiary)' }}>
      To
      <select
        value={to}
        onChange={(e) => setTo(e.target.value)}
        className="rounded-md px-1.5 py-1 text-ui-11-5 cursor-pointer"
        style={{ background: 'var(--color-bg-secondary)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
      >
        {withEmail.map((c) => (
          <option key={c.email!} value={c.email!} disabled={sendOn && !!c.bounce_hard_at}>
            {c.name || c.email}
            {c.title ? ` -- ${c.title}` : ''}
            {c.name && withEmail.length > 1 ? ` <${c.email}>` : ''}
            {c.bounce_hard_at ? ' (bounced)' : ''}
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
    <span className="text-ui-11" style={{ color: 'var(--color-text-tertiary)' }} role="status">
      {status}
    </span>
  );

  if (sendOn) {
    const confirmed = result && result.fe_status !== 'unconfirmed' ? result.fe_status : null;
    const shown = unconfirmed ? null : (confirmed ?? send!.status ?? null);
    return (
      <div className="flex flex-col gap-2" data-send-mode="forwardemail">
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-ui-11" style={{ color: 'var(--color-text-tertiary)' }}>
            From
            <input
              value={fromName}
              onChange={(e) => setFromName(e.target.value.slice(0, 100))}
              aria-label="From name"
              className="rounded-md px-1.5 py-1 text-ui-11-5 w-36"
              style={{ background: 'var(--color-bg-secondary)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
            />
          </label>
          {toPicker}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <SmallButton tone="accent" onClick={() => void doSend()} disabled={!!sendBlocked || sending} title={sendBlocked ?? `Send from ${send!.config.sender_address}`}>
            {sending ? <Loader2 size={11} className="animate-spin" /> : <Send size={11} />} {sending ? 'Sending…' : 'Send'}
          </SmallButton>
          <FeStatusChip status={shown} error={result ? null : send!.error} />
          <SmallButton onClick={() => setMore((m) => !m)} title="Mail link and copy buttons">
            More <ChevronDown size={11} />
          </SmallButton>
          {unconfirmed ? (
            <>
              <span className="text-ui-11" style={{ color: 'var(--color-warning)' }} role="status" data-send-check="unconfirmed">
                {UNCONFIRMED_NOTE}
              </span>
              {send!.onCheck && (
                <SmallButton onClick={() => void doCheck()} disabled={checking} title="Look the mail up by its Message-ID (nothing is sent)">
                  {checking ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />} Check now
                </SmallButton>
              )}
            </>
          ) : (
            sendBlocked &&
            sendBlocked !== 'Sent' &&
            !result && (
              <span className="text-ui-11" style={{ color: 'var(--color-text-tertiary)' }}>
                {sendBlocked}
              </span>
            )
          )}
          {local === 'not_sent' && !result && (
            <span className="text-ui-11" style={{ color: 'var(--color-text-tertiary)' }} role="status" data-send-check="not_sent">
              {notSentNote(send!.touch ?? 1)}
            </span>
          )}
          {result && !unconfirmed && (
            <span className="text-ui-11" style={{ color: 'var(--color-text-tertiary)' }} role="status">
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
          <span className="text-ui-11" style={{ color: 'var(--color-text-tertiary)' }}>
            {mailto.reason === 'no_address'
              ? 'No contact email on file -- copy and paste instead.'
              : 'Too long for a mail link -- copy and paste instead.'}
          </span>
        )}
        {statusLine}
      </div>

      {(askSent || !mailto.ok) && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-md px-2 py-1.5 text-ui-12"
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
