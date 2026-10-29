import { useState } from 'react';
import { CheckCircle } from 'lucide-react';
import { Chip, SmallButton } from '../shared/ui';
import {
  DISMISS_NOTE_MAX,
  SNOOZE_DAYS,
  SNOOZE_DEFAULT,
  TABS,
  ago,
  dispatchLabel,
  dueLabel,
  filedRows,
  fmtAge,
  groupItems,
  laneCount,
  laneOf,
  linkFor,
  patchHref,
  rowKey,
  rowStatusText,
  staleSources,
  type FiledRow,
  type Lane,
  type RowStatus,
  type StaleNote,
  type Waiting,
  type WaitingGroup,
  type WaitingItem,
} from '../../lib/waiting-api';

export const EMPTY = 'Nothing waiting on you';
export const EMPTY_LANE: Record<Lane, string> = {
  act: EMPTY,
  delegate: 'Nothing to dispatch',
  fyi: 'Nothing filed',
};

/** Whether a row does anything when clicked: a page link or a drawer here. */
export const isOpenable = (item: WaitingItem) =>
  item.opens === 'decisions' || item.opens === 'g1' || item.opens === 'workorder' || linkFor(item) != null;

/** The row actions: Dispatch on a delegate row and Snooze on a rec (hq 0023);
 * Fix it on a product-copy rec and Dismiss on a work-order row (hq 0024). */
export interface RowActions {
  status: Record<string, RowStatus>;
  onDispatch: (item: WaitingItem) => void;
  onSnooze: (item: WaitingItem, days: number) => void;
  onFix?: (item: WaitingItem) => void;
  onDismiss?: (item: WaitingItem, note: string) => void;
  /** Open a page in the app ("patch ready"). */
  onNavigate?: (href: string) => void;
}

/** Dismiss with a one-click confirm and an optional one-line note (0024 J4).
 * Shared by the work-order row and the report drawer. */
export function DismissControl({ id, busy, onDismiss }: { id: string; busy?: boolean; onDismiss: (note: string) => void }) {
  const [armed, setArmed] = useState(false);
  const [note, setNote] = useState('');
  if (!armed) {
    return (
      <span data-dismiss={id}>
        <SmallButton disabled={busy} onClick={() => setArmed(true)} title="You've read the report: take the row off For you">
          Dismiss
        </SmallButton>
      </span>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <input
        aria-label="Dismiss note (optional)"
        data-dismiss-note
        value={note}
        maxLength={DISMISS_NOTE_MAX}
        placeholder="Note (optional)"
        onChange={(e) => setNote(e.target.value.replace(/[\r\n]+/g, ' '))}
        className="text-[11px] rounded px-1.5 py-0.5 min-w-0 w-40"
        style={{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
      />
      <span data-confirm-dismiss={id}>
        <SmallButton
          tone="accent"
          disabled={busy}
          onClick={() => {
            setArmed(false);
            onDismiss(note);
          }}
        >
          Confirm: Dismiss
        </SmallButton>
      </span>
      <SmallButton onClick={() => setArmed(false)}>Cancel</SmallButton>
    </span>
  );
}

function Actions({ item, actions }: { item: WaitingItem; actions: RowActions }) {
  const [armed, setArmed] = useState(false);
  const [days, setDays] = useState<number>(SNOOZE_DEFAULT);
  const status = actions.status[rowKey(item)];
  const busy = status?.kind === 'busy';
  const lane = laneOf(item);
  // A product-copy rec is fixed, never dispatched (0024 D1).
  const fixable = item.kind === 'rec' && item.fix === true && lane !== 'fyi' && !!actions.onFix;
  const label = fixable ? 'Fix it' : lane === 'delegate' && item.fix !== true ? dispatchLabel(item.delegate) : null;
  const snoozable = item.kind === 'rec' && lane !== 'fyi';
  const dismissable = item.kind === 'workorder' && !!actions.onDismiss;
  const patchId = item.kind === 'rec' ? item.fix_patch_id : null;
  const done = status != null && status.kind !== 'busy' && status.kind !== 'error';
  if (!label && !snoozable && !dismissable && !patchId) return null;
  return (
    <div className="flex flex-col gap-1 px-2 pb-1.5">
      {patchId && (
        <span className="flex items-center gap-1.5 text-[11px]">
          <button
            type="button"
            data-patch-ready={patchId}
            data-href={patchHref(patchId)}
            onClick={() => actions.onNavigate?.(patchHref(patchId))}
            className="cursor-pointer underline"
            style={{ background: 'transparent', border: 'none', padding: 0, color: 'var(--color-accent)' }}
            title="Open the patch on the Fixes tab"
          >
            patch ready
          </button>
        </span>
      )}
      {!done && (
        <div className="flex flex-wrap items-center gap-1.5">
          {dismissable && <DismissControl id={String(item.id)} busy={busy} onDismiss={(note) => actions.onDismiss!(item, note)} />}
          {label &&
            (armed ? (
              <>
                <span data-confirm-dispatch={rowKey(item)}>
                  <SmallButton
                    tone="accent"
                    disabled={busy}
                    onClick={() => {
                      setArmed(false);
                      if (fixable) actions.onFix!(item);
                      else actions.onDispatch(item);
                    }}
                  >
                    Confirm: {label}
                  </SmallButton>
                </span>
                <SmallButton onClick={() => setArmed(false)}>Cancel</SmallButton>
              </>
            ) : (
              <span data-dispatch={rowKey(item)} data-fix={fixable ? rowKey(item) : undefined}>
                <SmallButton
                  disabled={busy}
                  onClick={() => setArmed(true)}
                  title={fixable ? 'The catalog fixer writes the copy as a patch in Fixes; you tick it there' : undefined}
                >
                  {label}
                </SmallButton>
              </span>
            ))}
          {snoozable && !armed && (
            <span className="flex items-center gap-1">
              <select
                aria-label="Snooze for"
                data-snooze-days
                value={days}
                disabled={busy}
                onChange={(e) => setDays(Number(e.target.value))}
                className="text-[11px] rounded px-1 py-0.5"
                style={{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
              >
                {SNOOZE_DAYS.map((d) => (
                  <option key={d} value={d}>
                    {d} day{d === 1 ? '' : 's'}
                  </option>
                ))}
              </select>
              <span data-snooze={rowKey(item)}>
                <SmallButton disabled={busy} onClick={() => actions.onSnooze(item, days)}>
                  Snooze
                </SmallButton>
              </span>
            </span>
          )}
        </div>
      )}
      {status && (
        <span
          className="text-[11px]"
          data-row-status={status.kind}
          style={{ color: status.kind === 'error' ? 'var(--color-error)' : 'var(--color-text-secondary)' }}
        >
          {rowStatusText(status)}
        </span>
      )}
    </div>
  );
}

function Row({
  item,
  now,
  compact,
  onOpen,
  actions,
}: {
  item: WaitingItem;
  now: number;
  compact: boolean;
  onOpen: (item: WaitingItem) => void;
  actions?: RowActions;
}) {
  const due = dueLabel(item.due, now);
  const overdue = due?.endsWith('overdue') ?? false;
  const openable = isOpenable(item);
  const href = linkFor(item);
  const seen = item.times_seen ?? 0;
  const age = item.last_seen ?? item.created_at;
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
        title={
          openable
            ? item.opens === 'decisions'
              ? 'Open the Decisions drawer'
              : item.opens === 'workorder'
              ? 'Open the report'
              : `Open ${href}`
            : undefined
        }
      >
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="text-[12.5px] truncate" style={{ color: 'var(--color-text)' }}>
            {item.title}
          </span>
        </span>
        <span className="flex flex-wrap items-center gap-1.5 text-[10.5px]" style={{ color: 'var(--color-text-tertiary)' }}>
          {item.scope && <Chip tone="muted">{item.scope}</Chip>}
          {due && <Chip tone={overdue ? 'error' : 'warning'}>{due}</Chip>}
          {seen >= 2 && (
            <Chip tone="accent" title="The briefing proposed this again">
              seen {seen} times
            </Chip>
          )}
          {age && <span>{ago(age, now)}</span>}
        </span>
        {!compact && item.detail && (
          <span className="text-[11.5px] line-clamp-2" style={{ color: 'var(--color-text-secondary)' }}>
            {item.detail}
          </span>
        )}
      </button>
      {actions && <Actions item={item} actions={actions} />}
    </li>
  );
}

/**
 * The merged list, grouped by kind with each group's count. Rows link to the
 * page holding the action (or open a drawer here); the list itself acts only
 * through the two row actions, when they are passed. Pure: the bell and the
 * Dashboard panel pass the shared poll in.
 */
export function WaitingListView({
  groups,
  stale = [],
  now,
  compact = false,
  perGroup,
  limit,
  onMore,
  empty = EMPTY,
  onOpen,
  actions,
}: {
  groups: WaitingGroup[];
  stale?: StaleNote[];
  now: number;
  compact?: boolean;
  /** Rows shown per group before "+ n more" (the count stays whole). */
  perGroup?: number;
  /** Rows shown in all, across groups, before "N more" (the Dashboard's 10). */
  limit?: number;
  /** Where "N more" goes: the full list. */
  onMore?: () => void;
  empty?: string;
  onOpen: (item: WaitingItem) => void;
  actions?: RowActions;
}) {
  let left = limit ?? Infinity;
  const total = groups.reduce((n, g) => n + g.count, 0);
  let shownAll = 0;
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
          {empty}
        </div>
      ) : (
        groups.map((g) => {
          if (left <= 0) return null;
          const shown = g.items.slice(0, Math.min(perGroup ?? Infinity, left));
          left -= shown.length;
          shownAll += shown.length;
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
                  <Row key={rowKey(item)} item={item} now={now} compact={compact} onOpen={onOpen} actions={actions} />
                ))}
              </ul>
              {more > 0 && limit == null && (
                <p className="text-[10.5px] px-2" style={{ color: 'var(--color-text-tertiary)' }}>
                  + {more} more on the page
                </p>
              )}
            </section>
          );
        })
      )}
      {limit != null && total > shownAll && (
        <button
          type="button"
          data-more
          onClick={onMore}
          className="self-start text-[11px] px-2 cursor-pointer"
          style={{ background: 'transparent', border: 'none', color: 'var(--color-accent)' }}
        >
          {total - shownAll} more
        </button>
      )}
    </div>
  );
}

/** Filed (`fyi`): counts only, each opening the page or drawer it is filed in. */
export function FiledView({ rows, onOpen }: { rows: FiledRow[]; onOpen: (row: FiledRow) => void }) {
  if (rows.length === 0) {
    return (
      <div className="flex items-center gap-2 py-4 text-[12.5px]" style={{ color: 'var(--color-text-secondary)' }}>
        <CheckCircle size={15} style={{ opacity: 0.5 }} />
        {EMPTY_LANE.fyi}
      </div>
    );
  }
  return (
    <ul className="flex flex-col">
      {rows.map((r) => (
        <li key={r.key}>
          <button
            type="button"
            data-filed={r.key}
            data-href={r.href}
            onClick={() => onOpen(r)}
            className="w-full text-left flex items-center justify-between gap-2 rounded-md px-2 py-1.5 cursor-pointer text-[12.5px]"
            style={{ background: 'transparent', border: 'none', color: 'var(--color-text)' }}
          >
            <span>{r.label}</span>
            <span data-count style={{ color: 'var(--color-text-tertiary)' }}>
              {r.count}
            </span>
          </button>
          {r.notes && r.notes.length > 0 && (
            <ul className="flex flex-col gap-0.5 px-2 pb-1.5">
              {r.notes.map((n) => (
                <li key={n.id} data-filed-note={n.id} className="flex flex-col text-[11.5px]">
                  <span style={{ color: 'var(--color-text-secondary)' }}>{n.title}</span>
                  <span className="flex flex-wrap items-center gap-1.5 text-[10.5px]" style={{ color: 'var(--color-text-tertiary)' }}>
                    {n.store && <Chip tone="muted">{n.store}</Chip>}
                    <span>{n.note}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The three tabs over one poll: For you, Dispatch, Filed (hq 0023 D1). */
export function WaitingTabsView({
  waiting,
  tab,
  onTab,
  now,
  compact = false,
  perGroup,
  onOpen,
  onFiled,
  actions,
}: {
  waiting: Waiting | null;
  tab: Lane;
  onTab: (lane: Lane) => void;
  now: number;
  compact?: boolean;
  perGroup?: number;
  onOpen: (item: WaitingItem) => void;
  onFiled: (row: FiledRow) => void;
  actions?: RowActions;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div role="tablist" className="flex gap-1 px-1">
        {TABS.map((t) => (
          <button
            key={t.lane}
            type="button"
            role="tab"
            aria-selected={tab === t.lane}
            data-tab={t.lane}
            onClick={() => onTab(t.lane)}
            className="text-[11.5px] rounded-md px-2 py-1 cursor-pointer"
            style={{
              background: tab === t.lane ? 'var(--color-bg-tertiary)' : 'transparent',
              color: tab === t.lane ? 'var(--color-text)' : 'var(--color-text-secondary)',
              border: 'none',
            }}
          >
            {t.label} <span data-tab-count>{laneCount(waiting, t.lane)}</span>
          </button>
        ))}
      </div>
      {tab === 'fyi' ? (
        <FiledView rows={filedRows(waiting)} onOpen={onFiled} />
      ) : (
        <WaitingListView
          groups={groupItems(waiting, tab)}
          stale={tab === 'act' ? staleSources(waiting) : []}
          now={now}
          compact={compact}
          perGroup={perGroup}
          empty={EMPTY_LANE[tab]}
          onOpen={onOpen}
          actions={actions}
        />
      )}
    </div>
  );
}
