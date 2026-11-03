import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { applyMoves, applySendChecks, type PendingMove } from '../../hooks/useBizDevData';
import {
  resolveLocalSends,
  sendCheckKey,
  toKey,
  type BdPipeline,
  type LocalSend,
  type PipelineLine,
  type PipelineProspect,
  type SendConfig,
} from '../../lib/bizdev-api';
import { MailActions, notSentNote, SendChecks, UNCONFIRMED_NOTE, type SendMode } from './MailActions';
import { ProspectDrawer } from './ProspectDrawer';

// The 2026-11-03 follow-up: a send Forward Email didn't answer is held
// unconfirmed and settled by Message-ID. Neutral fixtures only.
const CONFIG: SendConfig = {
  enabled: true,
  sender_name: 'Sample Sender',
  sender_address: 'sender@example.org',
  reply_to: 'sender@example.org',
  missing: [],
};
const TO = 'a.person@example.edu';
const CONTACTS = [{ name: 'A. Person', email: TO }];
const noSend = async () => ({ fe_id: 'x', message_id: 'y', fe_status: 'queued' as const, recorded: true });

function card(over: Partial<PipelineProspect> = {}): PipelineProspect {
  return {
    id: 7,
    name: 'Example College 7',
    contacts: CONTACTS,
    draft: { subject: 'Sample subject', body: 'Hello,\nSample body.' },
    stage: 'drafted',
    ...over,
  };
}

function actions(send: Partial<SendMode>) {
  return renderToStaticMarkup(
    <MailActions contacts={CONTACTS} subject="Sample subject" body="Hello." onMarkSent={() => {}} send={{ config: CONFIG, onSend: noSend, ...send }} />,
  );
}

const local = (fe_status: LocalSend['fe_status'], touch = 1): LocalSend => ({
  prospect_id: 7,
  touch,
  to_key: '33bc679a3ca47a41',
  message_id: '<bd-7-1-abcd@example.org>',
  fe_status,
});

describe('MailActions for a send being checked', () => {
  it('unconfirmed: the note, Check now, and Send disabled', () => {
    const html = actions({ local: 'unconfirmed', touch: 1, onCheck: async () => {} });
    expect(html).toContain(UNCONFIRMED_NOTE);
    expect(html).toContain('Check now');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="Sent, but Forward Email/);
    expect(html).not.toContain(notSentNote(1));
  });

  it('not_sent: says nothing was sent, and Send is enabled', () => {
    const html = actions({ local: 'not_sent', touch: 2 });
    expect(html).toContain('Forward Email never received touch 2. Nothing was sent. You can send it again.');
    expect(html).not.toContain('Check now');
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*title="Send/);
  });

  it('no local state: as before', () => {
    const html = actions({});
    expect(html).not.toContain(UNCONFIRMED_NOTE);
    expect(html).not.toContain('Nothing was sent');
  });
});

describe('the drawer with a send being checked', () => {
  const drawer = (states: Record<string, 'unconfirmed' | 'not_sent'>) =>
    renderToStaticMarkup(
      <SendChecks.Provider value={{ states, check: async () => {} }}>
        <ProspectDrawer
          prospect={card()}
          onClose={() => {}}
          onMove={() => {}}
          onRecheck={() => {}}
          recheckDisabled={false}
          rechecksToday={0}
          recheckCap={5}
          sendConfig={CONFIG}
          onSend={noSend}
        />
      </SendChecks.Provider>,
    );

  it('unconfirmed: the draft stays visible, read-only, with Check now', () => {
    const html = drawer({ [sendCheckKey(7, 1, TO)]: 'unconfirmed' });
    expect(html).toContain(UNCONFIRMED_NOTE);
    expect(html).toContain('Check now');
    expect(html).toMatch(/<textarea[^>]*readonly=""[^>]*aria-label="Body"/i);
    expect(html).toContain('Sample body.');
  });

  it('not_sent: the draft is editable again', () => {
    const html = drawer({ [sendCheckKey(7, 1, TO.toUpperCase())]: 'not_sent' });
    expect(html).toContain(notSentNote(1));
    expect(html).not.toMatch(/<textarea[^>]*readonly/i);
  });
});

describe('local send states on the board', () => {
  it('toKey matches the server hash (sha256, 16 hex)', async () => {
    expect(await toKey(' A.Person@Example.edu ')).toBe('33bc679a3ca47a41');
  });

  it('resolves a state to the contact of its card', async () => {
    const pipeline = { lines: [{ line: 'sample', stages: { sent: [card({ contacts: [{ name: 'B. Person', email: 'b.person@example.edu' }, ...CONTACTS] })] } }] } as unknown as BdPipeline;
    expect(await resolveLocalSends(pipeline, [local('unconfirmed')])).toEqual({ [sendCheckKey(7, 1, TO)]: 'unconfirmed' });
    expect(await resolveLocalSends(pipeline, [{ ...local('unconfirmed'), prospect_id: 8 }])).toEqual({});
  });

  it('unconfirmed keeps the move fresh; not_sent undoes it; confirmed clears checking', () => {
    const old: Record<number, PendingMove> = { 7: { stage: 'sent', at: 0, touch: 2 }, 9: { stage: 'lost', at: 0 } };
    const held = applySendChecks(old, [local('unconfirmed', 2)], 1000);
    expect(held[7]).toEqual({ stage: 'sent', at: 1000, touch: 2, checking: true });
    expect(held[9]).toEqual(old[9]);
    expect(applySendChecks(old, [local('not_sent', 2)], 1000)[7]).toBeUndefined();
    expect(applySendChecks(old, [local('unconfirmed', 1)], 1000)[7]).toEqual(old[7]); // another touch
    expect(applySendChecks(held, [], 2000)[7]).toEqual({ stage: 'sent', at: 2000, touch: 2, checking: false });
  });

  it('a follow-up being checked stays in the strip; a sent one leaves it', () => {
    const line = {
      line: 'sample',
      stages: { sent: [card({ stage: 'sent' })] },
      follow_ups_due: [{ prospect_id: 7, touch: 2, due: '2026-11-03', draft: { subject: 'Re', body: 'Hi' } }],
    } as unknown as PipelineLine;
    expect(applyMoves(line, { 7: { stage: 'sent', at: 0, touch: 2 } }).followUps).toEqual([]);
    expect(applyMoves(line, { 7: { stage: 'sent', at: 0, touch: 2, checking: true } }).followUps).toHaveLength(1);
  });
});
