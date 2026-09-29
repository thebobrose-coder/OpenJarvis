import { CalendarClock } from 'lucide-react';
import type { FollowUp, PipelineProspect } from '../../lib/bizdev-api';
import { DashboardPanel } from '../Dashboard/DashboardPanel';
import { Chip } from '../shared/ui';
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

/** Follow-ups Hermes has drafted (touch 2 at 7 days, touch 3 at 14). */
export function FollowUpsStrip({
  followUps,
  prospectsById,
  onMarkSent,
}: {
  followUps: FollowUp[];
  prospectsById: Map<number, PipelineProspect>;
  onMarkSent: (prospectId: number, touch: number) => void;
}) {
  if (followUps.length === 0) return null;
  return (
    <DashboardPanel icon={CalendarClock} title="Follow-ups due" tag={`${followUps.length}`} size="full">
      <div className="flex gap-3 overflow-x-auto pb-1">
        {followUps.map((f) => {
          const p = prospectsById.get(f.prospect_id);
          const due = dueLabel(f.due);
          return (
            <article
              key={`${f.prospect_id}-${f.touch}`}
              className="flex flex-col gap-2 rounded-lg p-3 min-w-[20rem] max-w-[24rem] shrink-0"
              style={{ background: 'var(--color-bg-secondary)' }}
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[12.5px] font-medium" style={{ color: 'var(--color-text)' }}>
                  {p?.name ?? `Prospect ${f.prospect_id}`}
                </span>
                <Chip tone="accent">touch {f.touch}</Chip>
                <Chip tone={due.overdue ? 'warning' : 'muted'}>{due.text}</Chip>
              </div>
              <div className="text-[12px]" style={{ color: 'var(--color-text)' }}>
                {f.draft.subject}
              </div>
              <MailActions
                contacts={p?.contacts ?? []}
                subject={f.draft.subject}
                body={f.draft.body}
                sentLabel={`Mark touch ${f.touch} as sent?`}
                onMarkSent={() => onMarkSent(f.prospect_id, f.touch)}
              />
            </article>
          );
        })}
      </div>
    </DashboardPanel>
  );
}
