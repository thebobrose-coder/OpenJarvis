import { useNavigate } from 'react-router';
import { Inbox } from 'lucide-react';
import { DashboardPanel } from './DashboardPanel';
import { SmallButton } from '../shared/ui';
import { WaitingListView, type RowActions } from '../Waiting/WaitingListView';
import { useWaiting } from '../../lib/WaitingContext';
import { bellCount, fmtAge, groupItems, linkFor, sourceAges, staleSources, type Waiting, type WaitingItem } from '../../lib/waiting-api';

/** The Dashboard shows this many "For you" rows; the rest are in the bell. */
export const PANEL_ROWS = 10;

/** Pure: the panel's body for a given poll (see WaitingPanel). */
export function WaitingPanelView({
  waiting,
  loading,
  error,
  now,
  onOpen,
  onDecisions,
  onMore = () => {},
  actions,
}: {
  waiting: Waiting | null;
  loading: boolean;
  error: string | null;
  now: number;
  onOpen: (item: WaitingItem) => void;
  onDecisions: () => void;
  /** "N more": the full list (the bell's dropdown). */
  onMore?: () => void;
  actions?: RowActions;
}) {
  const act = bellCount(waiting);
  return (
    <DashboardPanel
      icon={Inbox}
      title="Waiting on you"
      tag={waiting ? `${act} for you` : undefined}
      size="full"
      priority={act > 0}
      loading={loading && !waiting}
      error={!waiting ? error : null}
      actions={
        <SmallButton onClick={onDecisions} title="The open decision boxes in the inbox briefs">
          Decisions
        </SmallButton>
      }
    >
      <div className="max-h-[26rem] overflow-y-auto pr-1">
        <WaitingListView
          groups={groupItems(waiting, 'act')}
          stale={staleSources(waiting)}
          now={now}
          limit={PANEL_ROWS}
          onMore={onMore}
          onOpen={onOpen}
          actions={actions}
        />
      </div>
      {waiting && (
        <p className="text-[10.5px]" style={{ color: 'var(--color-text-tertiary)' }} data-ages>
          {sourceAges(waiting, now)
            .map((s) => `${s.label} ${fmtAge(s.age)}`)
            .join(' · ')}
        </p>
      )}
    </DashboardPanel>
  );
}

/**
 * The Dashboard's "Waiting on you" panel (hq 0020 P1, 0023 D1): the For you
 * lane only, at most ten rows, with "N more" opening the bell's full list.
 * Each row opens the page that holds its action; a rec can be snoozed or
 * fixed here, and a work-order row dismissed.
 */
export function WaitingPanel() {
  const { waiting, loading, error, setDecisionsOpen, setG1Open, setReportOpen, setBellOpen, rowActions } = useWaiting();
  const navigate = useNavigate();
  return (
    <WaitingPanelView
      waiting={waiting}
      loading={loading}
      error={error}
      now={Date.now()}
      onDecisions={() => setDecisionsOpen(true)}
      onMore={() => setBellOpen(true)}
      actions={rowActions}
      onOpen={(item) => {
        if (item.opens === 'decisions') setDecisionsOpen(true);
        else if (item.opens === 'g1') setG1Open(String(item.id));
        else if (item.opens === 'workorder') setReportOpen(String(item.id));
        else {
          const href = linkFor(item);
          if (href) navigate(href);
        }
      }}
    />
  );
}
