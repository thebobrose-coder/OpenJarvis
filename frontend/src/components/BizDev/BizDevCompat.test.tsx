import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { FollowUp, PipelineProspect, SendConfig } from '../../lib/bizdev-api';
import { FollowUpsStrip } from './FollowUpsStrip';
import { EngagementChips } from './PipelineBoard';
import { EngagementTimeline, ProspectDrawer } from './ProspectDrawer';

// A pre-v0.10.7 feed (no `engagement.recipients`, no `contacts[].source`) on a
// one-contact card renders exactly as it did before A2/A3: the snapshot was
// recorded on the code before them. Neutral fixtures only: this repo is public.
const CONFIG: SendConfig = {
  enabled: true,
  sender_name: 'Sample Sender',
  sender_address: 'sender@example.org',
  reply_to: 'sender@example.org',
  missing: [],
};

const CARD: PipelineProspect = {
  id: 9,
  name: 'Example College 9',
  association: 'NAIA',
  stage: 'sent',
  contacts: [{ name: 'A. Person', title: 'SID', email: 'a.person@example.edu' }],
  draft: { subject: 'Sample subject', body: 'Hello,\nSample body.', to_email: 'a.person@example.edu' },
  touches: [
    {
      n: 1,
      sent_at: '2026-10-20T15:00:00Z',
      fe_id: 'fe1',
      fe_status: 'sent',
      to_email: 'a.person@example.edu',
      message_id: '<bd-9-1-abcdef01@example.org>',
      opens: 2,
    },
  ],
  engagement: {
    sent_at: '2026-10-20T15:00:00Z',
    fe_status: 'sent',
    opens: 2,
    proxy_opens: 1,
    first_open_at: '2026-10-20T16:00:00Z',
    last_open_at: '2026-10-21T09:00:00Z',
    replied_at: '2026-10-21T10:00:00Z',
    reply_kind: 'reply',
    replied_touch: 1,
    time_to_reply_h: 19,
  },
};

const FOLLOW_UP: FollowUp = {
  prospect_id: 9,
  touch: 2,
  due: '2026-10-27',
  draft: { subject: 'Re: Sample subject', body: 'Following up.' },
};

describe('pre-v0.10.7 feed on a one-contact card', () => {
  it('renders as before', () => {
    const html = [
      renderToStaticMarkup(<EngagementChips p={CARD} />),
      renderToStaticMarkup(<EngagementTimeline prospect={CARD} />),
      renderToStaticMarkup(
        <ProspectDrawer
          prospect={CARD}
          onClose={() => {}}
          onMove={() => {}}
          onRecheck={() => {}}
          recheckDisabled={false}
          rechecksToday={0}
          recheckCap={5}
          sendConfig={CONFIG}
          onSend={async () => ({ fe_id: 'x', message_id: 'y', fe_status: 'queued', recorded: true })}
        />,
      ),
      renderToStaticMarkup(
        <FollowUpsStrip
          followUps={[FOLLOW_UP]}
          prospectsById={new Map([[9, CARD]])}
          onMarkSent={() => {}}
          sendConfig={CONFIG}
          onSend={async () => ({ fe_id: 'x', message_id: 'y', fe_status: 'queued', recorded: true })}
        />,
      ),
    ]
      .join('\n')
      // The clock and the machine's locale aren't part of the comparison.
      .replace(/\d+ d overdue|due today|due in \d+ d/g, '<due>')
      .replace(/[A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2}[\s ]?[AP]M/g, '<time>');
    expect(html).toMatchSnapshot();
  });
});
