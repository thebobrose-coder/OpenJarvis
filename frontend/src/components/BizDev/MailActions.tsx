import { useState } from 'react';
import { Copy, Mail, Send } from 'lucide-react';
import type { Contact } from '../../lib/bizdev-api';
import { SmallButton } from '../shared/ui';
import { buildMailto, copyText, openMailto } from './mail';

/**
 * Open in mail / Copy subject / Copy body for one draft, then "Mark as
 * sent?". Shared by the prospect drawer and the follow-ups strip, so both
 * send paths behave the same.
 */
export function MailActions({
  contacts,
  subject,
  body,
  onMarkSent,
  sentLabel = 'Mark as sent?',
}: {
  contacts: Contact[];
  subject: string;
  body: string;
  onMarkSent: () => void;
  sentLabel?: string;
}) {
  const withEmail = contacts.filter((c) => c.email);
  const [to, setTo] = useState(withEmail[0]?.email ?? '');
  const [askSent, setAskSent] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const mailto = buildMailto(to, subject, body);

  const copy = async (text: string, what: string) => {
    setStatus((await copyText(text)) ? `${what} copied` : `Couldn’t copy ${what.toLowerCase()}`);
  };

  const open = async () => {
    if (!mailto.ok) return;
    await openMailto(mailto.href);
    setAskSent(true);
  };

  return (
    <div className="flex flex-col gap-2">
      {withEmail.length > 1 && (
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
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        <SmallButton
          tone="accent"
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
        {!mailto.ok && (
          <span className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
            {mailto.reason === 'no_address'
              ? 'No contact email on file -- copy and paste instead.'
              : 'Too long for a mail link -- copy and paste instead.'}
          </span>
        )}
        {status && (
          <span className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }} role="status">
            {status}
          </span>
        )}
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
