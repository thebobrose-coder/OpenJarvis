import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  nextTouch,
  sendRequest,
  unresolvedFields,
  type FollowUp,
  type PipelineProspect,
  type SendConfig,
} from '../../lib/bizdev-api';
import { FollowUpsStrip } from './FollowUpsStrip';
import { MailActions, type SendMode } from './MailActions';
import { ProspectDrawer } from './ProspectDrawer';

// Send through Forward Email (hq 0018, Part A). Neutral fixtures only: this
// repo is public.
const CONFIG: SendConfig = {
  enabled: true,
  sender_name: 'Sample Sender',
  sender_address: 'sender@example.org',
  reply_to: 'sender@example.org',
  missing: [],
};
const FIRST = '<bd-7-1-abcdef01@example.org>';
const CONTACTS = [{ name: 'A. Person', title: 'SID', email: 'a.person@example.edu' }];

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

const noSend = async () => ({ fe_id: 'x', message_id: 'y', fe_status: 'queued' as const, recorded: true });

function actions(send: Partial<SendMode> | null, body = 'Hello,\nSample body.') {
  return renderToStaticMarkup(
    <MailActions
      contacts={CONTACTS}
      subject="Sample subject"
      body={body}
      onMarkSent={() => {}}
      send={send ? { config: CONFIG, onSend: noSend, ...send } : null}
    />,
  );
}

describe('MailActions with Send', () => {
  it('without Send configured: the mail link path, unchanged', () => {
    const html = actions(null);
    expect(html).toContain('Open in mail');
    expect(html).not.toContain('data-send-mode');
    expect(actions({ config: { ...CONFIG, enabled: false } })).not.toContain('data-send-mode');
  });

  it('configured: Send is primary, From prefilled, mail link under More, no Mark as sent', () => {
    const html = actions({});
    expect(html).toContain('data-send-mode="forwardemail"');
    expect(html).toMatch(/<button[^>]*>.*Send<\/button>/s);
    expect(html).toContain('value="Sample Sender"');
    expect(html).toContain('More');
    expect(html).not.toContain('Open in mail'); // folded until More is opened
    expect(html).not.toContain('Mark');
    expect(html).toContain('a.person@example.edu'); // the To choice, even for one contact
  });

  it('blocks Send with the reason: already sent, or an unresolved merge field', () => {
    const sent = actions({ blocked: 'Touch 1 was sent', status: 'queued' });
    expect(sent).toContain('Touch 1 was sent');
    expect(sent).toMatch(/<button[^>]*disabled=""[^>]*title="Touch 1 was sent"/);
    expect(sent).toContain('>queued<');
    expect(actions({}, 'Hi {{first_name}},')).toContain('Unresolved merge field: {{first_name}}');
  });

  it('a rejected touch shows its chip and Send is enabled again', () => {
    const html = actions({ blocked: null, status: 'rejected' });
    expect(html).toContain('>rejected<');
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*title="Send from/);
  });
});

describe('the drawer and the strip', () => {
  const drawer = (p: PipelineProspect, config: SendConfig | null = CONFIG) =>
    renderToStaticMarkup(
      <ProspectDrawer
        prospect={p}
        onClose={() => {}}
        onMove={() => {}}
        onRecheck={() => {}}
        recheckDisabled={false}
        rechecksToday={0}
        recheckCap={5}
        sendConfig={config}
        onSend={noSend}
      />,
    );

  it('the drawer sends touch 1 and lists sent touches with their status', () => {
    expect(drawer(card())).toContain('data-send-mode');
    const sent = card({ stage: 'sent', touches: [{ n: 1, sent_at: '2026-10-20T15:00:00Z', fe_status: 'sent', message_id: FIRST, to_email: 'a.person@example.edu' }] });
    const html = drawer(sent);
    expect(html).toContain('Touch 1 was sent');
    expect(html).toContain('data-touch="1"');
    expect(html).toContain('>sent<');
    expect(drawer(card(), null)).toContain('Open in mail');
    expect(drawer(card())).toContain('Send sends the text as edited here');
    expect(drawer(card(), null)).toContain('aren’t saved or sent anywhere');
  });

  it('the follow-ups strip offers Send for the next touch', () => {
    const p = card({ stage: 'sent', touches: [{ n: 1, sent_at: '2026-10-20T15:00:00Z', fe_status: 'sent', message_id: FIRST }] });
    const f: FollowUp = { prospect_id: 7, touch: 2, due: '2026-10-27', draft: { subject: 'Re: Sample subject', body: 'Following up.' } };
    const html = renderToStaticMarkup(
      <FollowUpsStrip followUps={[f]} prospectsById={new Map([[7, p]])} onMarkSent={() => {}} sendConfig={CONFIG} onSend={async () => noSend()} />,
    );
    expect(html).toContain('data-send-mode');
    expect(html).not.toContain('isn’t the next one');
  });
});

describe('send helpers', () => {
  it('nextTouch: 1 when never sent, the same after a rejection, else the next', () => {
    expect(nextTouch({})).toBe(1);
    expect(nextTouch({ touches: [{ n: 1, sent_at: 'x', fe_status: 'sent' }] })).toBe(2);
    expect(nextTouch({ touches: [{ n: 1, sent_at: 'x' }] })).toBe(2); // marked by hand
    expect(nextTouch({ touches: [{ n: 1, sent_at: 'x', fe_status: 'rejected' }] })).toBe(1);
  });

  it('a follow-up carries in_reply_to from touch 1; the From name override is passed', () => {
    const p = { touches: [{ n: 1, sent_at: 'x', fe_status: 'sent' as const, message_id: FIRST }] };
    const req = sendRequest(p, { touch: 2, to: 'a.person@example.edu', fromName: ' S. Sender ', subject: 's', body: 'b' });
    expect(req).toEqual({
      to_email: 'a.person@example.edu',
      subject: 's',
      body: 'b',
      touch: 2,
      draft_source: 'hermes',
      from_name: 'S. Sender',
      in_reply_to_message_id: FIRST,
    });
    const first = sendRequest({}, { touch: 1, to: 'a.person@example.edu', fromName: '', subject: 's', body: 'b' });
    expect(first.in_reply_to_message_id).toBeUndefined();
    expect(first.from_name).toBeUndefined();
  });

  it('finds unresolved merge fields', () => {
    expect(unresolvedFields('Hi {{ first_name }}', 'at {{institution}} and {{first_name}}')).toEqual(['first_name', 'institution']);
    expect(unresolvedFields('No fields here')).toEqual([]);
  });
});
