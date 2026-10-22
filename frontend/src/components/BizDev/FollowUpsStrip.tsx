import { CalendarClock } from 'lucide-react';
import {
  firstRecipient,
  type FollowUp,
  type PipelineProspect,
  type SendConfig,
  type SendRequest,
  type SendResult,
  type TemplateSave,
} from '../../lib/bizdev-api';
import { recipientName } from '../../lib/bizdev-compose';
import { DashboardPanel } from '../Dashboard/DashboardPanel';
import { Chip } from '../shared/ui';
import { DraftComposer, type ComposeLine } from './DraftComposer';
import { MailActions } from './MailActions';

function dueLabel(due: string): { text: string; overdue: boolean } {
  const d = new Date(`${due.slice(0, 10)}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((d.getTime() - today.getTime()) / 86_400_000);
  if (Number.isNaN(days)) return { text: due, overdue: false };
  if (days < 0) return { text: `${-days} d overdue`, overdue: true };
  if (days === 0) return { text: 'due today', overdue: false };
  return { text: `due in ${days} d`, overdue: false };
}

/** The address a follow-up goes to: its `to_email` (v0.10.7), else the
 * card's first recipient (a proposal made before v0.10.7). */
export function followUpRecipient(f: FollowUp, p: PipelineProspect | undefined): string {
  return f.to_email || f.draft.to_email || (p ? firstRecipient(p) : '');
}

/** Follow-ups Hermes has drafted (touch 2 at 7 days, touch 3 at 14), one per
 * card, each for one recipient. */
export function FollowUpsStrip({
  followUps,
  prospectsById,
  onMarkSent,
  sendConfig = null,
  onSend,
  line,
  onSaveTemplate,
}: {
  followUps: FollowUp[];
  prospectsById: Map<number, PipelineProspect>;
  onMarkSent: (prospectId: number, touch: number) => void;
  /** Send through Forward Email (hq 0018); a follow-up threads on touch 1. */
  sendConfig?: SendConfig | null;
  onSend?: (prospectId: number, req: SendRequest) => Promise<SendResult>;
  /** The line's screen and templates (Part C). */
  line?: ComposeLine | null;
  onSaveTemplate?: (t: TemplateSave) => Promise<void>;
}) {
  if (followUps.length === 0) return null;
  return (
    <DashboardPanel icon={CalendarClock} title="Follow-ups due" tag={`${followUps.length}`} size="full">
      <div className="flex gap-3 overflow-x-auto pb-1">
        {followUps.map((f) => {
          const p = prospectsById.get(f.prospect_id);
          const due = dueLabel(f.due);
          const to = followUpRecipient(f, p);
          return (
            <article
              key={`${f.prospect_id}-${f.touch}-${to}`}
              className="flex flex-col gap-2 rounded-lg p-3 min-w-[20rem] max-w-[24rem] shrink-0"
              style={{ background: 'var(--color-bg-secondary)' }}
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[12.5px] font-medium" style={{ color: 'var(--color-text)' }}>
                  {p?.name ?? `Prospect ${f.prospect_id}`}
                </span>
                <Chip tone="accent">touch {f.touch}</Chip>
                {p && to && (p.contacts ?? []).filter((c) => c.email).length > 1 && <Chip tone="muted">to {recipientName(p, to)}</Chip>}
                <Chip tone={due.overdue ? 'warning' : 'muted'}>{due.text}</Chip>
              </div>
              {p ? (
                <DraftComposer
                  prospect={p}
                  line={line}
                  touch={f.touch}
                  draft={{ ...f.draft, to_email: to, draft_source: f.draft_source }}
                  sendConfig={sendConfig}
                  onSend={onSend ? (req) => onSend(f.prospect_id, req) : undefined}
                  sentLabel={`Mark touch ${f.touch} as sent?`}
                  onMarkSent={() => onMarkSent(f.prospect_id, f.touch)}
                  onSaveTemplate={onSaveTemplate}
                  compact
                />
              ) : (
                <>
                  <div className="text-[12px]" style={{ color: 'var(--color-text)' }}>
                    {f.draft.subject}
                  </div>
                  <MailActions
                    contacts={[]}
                    subject={f.draft.subject}
                    body={f.draft.body}
                    sentLabel={`Mark touch ${f.touch} as sent?`}
                    onMarkSent={() => onMarkSent(f.prospect_id, f.touch)}
                    send={
                      sendConfig?.enabled && onSend
                        ? {
                            config: sendConfig,
                            blocked: 'Prospect not on the board',
                            onSend: () => Promise.reject(new Error('Prospect not on the board')),
                          }
                        : null
                    }
                  />
                </>
              )}
            </article>
          );
        })}
      </div>
    </DashboardPanel>
  );
}
