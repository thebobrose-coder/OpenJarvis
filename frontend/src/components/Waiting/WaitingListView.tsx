import { CheckCircle } from 'lucide-react';
import { Chip } from '../shared/ui';
import {
  ago,
  dueLabel,
  fmtAge,
  linkFor,
  type StaleNote,
  type WaitingGroup,
  type WaitingItem,
} from '../../lib/waiting-api';

export const EMPTY = 'Nothing waiting on you';

/** Whether a row does anything when clicked: a page link or a drawer here. */
export const isOpenable = (item: WaitingItem) => item.opens === 'decisions' || linkFor(item) != null;

function Row({ item, now, compact, onOpen }: { item: WaitingItem; now: number; compact: boolean; onOpen: (item: WaitingItem) => void }) {
  const due = dueLabel(item.due, now);
  const overdue = due?.endsWith('overdue') ?? false;
  const openable = isOpenable(item);
  const href = linkFor(item);
  return (
    <li>
      <button
        type="button"
        onClick={() => openable && onOpen(item)}
        disabled={!openable}
        data-href={href ?? undefined}
        data-kind={item.kind}
        className="w-full text-left flex flex-col gap-0.5 rounded-md px-2 py-1.5 cursor-pointer disabled:cursor-default"
        style={{ background: 'transparent', border: 'none' }}
        title={openable ? (item.opens === 'decisions' ? 'Open the Decisions drawer' : `Open ${href}`) : undefined}
      >
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="text-[12.5px] truncate" style={{ color: 'var(--color-text)' }}>
            {item.title}
          </span>
        </span>
        <span className="flex flex-wrap items-center gap-1.5 text-[10.5px]" style={{ color: 'var(--color-text-tertiary)' }}>
          {item.scope && <Chip tone="muted">{item.scope}</Chip>}
          {due && <Chip tone={overdue ? 'error' : 'warning'}>{due}</Chip>}
          {item.created_at && <span>{ago(item.created_at, now)}</span>}
        </span>
        {!compact && item.detail && (
          <span className="text-[11.5px] line-clamp-2" style={{ color: 'var(--color-text-secondary)' }}>
            {item.detail}
          </span>
        )}
      </button>
    </li>
  );
}

/**
 * The merged list, grouped by kind with each group's uncapped count. Rows
 * link to the page holding the action (or open the Decisions drawer); the
 * list itself never acts. Pure: the bell and the Dashboard panel pass the
 * shared poll in.
 */
export function WaitingListView({
  groups,
  stale = [],
  now,
  compact = false,
  perGroup,
  onOpen,
}: {
  groups: WaitingGroup[];
  stale?: StaleNote[];
  now: number;
  compact?: boolean;
  /** Rows shown per group before "+ n more" (the count stays whole). */
  perGroup?: number;
  onOpen: (item: WaitingItem) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      {stale.length > 0 && (
        <p className="text-[11px]" style={{ color: 'var(--color-warning)' }} data-stale>
          {stale.map((s) => `${s.label}: ${s.error ? 'unavailable' : fmtAge(s.age)}`).join(' · ')}
        </p>
      )}
      {groups.length === 0 ? (
        <div className="flex items-center gap-2 py-4 text-[12.5px]" style={{ color: 'var(--color-text-secondary)' }}>
          <CheckCircle size={15} style={{ opacity: 0.5 }} />
          {EMPTY}
        </div>
      ) : (
        groups.map((g) => {
          const shown = perGroup ? g.items.slice(0, perGroup) : g.items;
          const more = g.count - shown.length;
          return (
            <section key={g.kind} data-group={g.kind}>
              <h3
                className="flex items-center justify-between text-[10.5px] uppercase tracking-wide px-2 mb-0.5"
                style={{ color: 'var(--color-text-tertiary)' }}
              >
                <span>{g.label}</span>
                <span data-count>{g.count}</span>
              </h3>
              <ul className="flex flex-col">
                {shown.map((item) => (
                  <Row key={`${item.kind}:${item.id}`} item={item} now={now} compact={compact} onOpen={onOpen} />
                ))}
              </ul>
              {more > 0 && (
                <p className="text-[10.5px] px-2" style={{ color: 'var(--color-text-tertiary)' }}>
                  + {more} more on the page
                </p>
              )}
            </section>
          );
        })
      )}
    </div>
  );
}
