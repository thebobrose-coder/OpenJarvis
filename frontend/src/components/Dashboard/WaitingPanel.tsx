import { useNavigate } from 'react-router';
import { ArrowRight, Inbox } from 'lucide-react';
import { DashboardPanel } from './DashboardPanel';
import { SmallButton } from '../shared/ui';
import { WaitingListView, type RowActions } from '../Waiting/WaitingListView';
import { useOpenWaitingItem, useWaiting } from '../../lib/WaitingContext';
import { bellCount, fmtAge, groupItems, sourceAges, staleSources, type Waiting, type WaitingItem } from '../../lib/waiting-api';

/** The Dashboard's act band shows this many "For you" rows before "Show all". */
export const PANEL_ROWS = 16;

/** Pure: the panel's body for a given poll (see WaitingPanel). */
export function WaitingPanelView({
  waiting,
  loading,
  error,
  now,
  onOpen,
  onDecisions,
  onMore,
  onInbox,
  actions,
}: {
  waiting: Waiting | null;
  loading: boolean;
  error: string | null;
  now: number;
  onOpen: (item: WaitingItem) => void;
  onDecisions: () => void;
  /** "N more" goes here; without it "Show all" expands in place. */
  onMore?: () => void;
  /** The Inbox page: every lane at full width. */
  onInbox?: () => void;
  actions?: RowActions;
}) {
  const act = bellCount(waiting);
  return (
    <DashboardPanel
      icon={Inbox}
      title="Waiting on you"
      tag={waiting ? `${act} for you` : undefined}
      size="full"
      band="short"
      priority={act > 0}
      loading={loading && !waiting}
      error={!waiting ? error : null}
      actions={
        <>
          <SmallButton onClick={onDecisions} title="The open decision boxes in the inbox briefs">
            Decisions
          </SmallButton>
          {onInbox && (
            <SmallButton onClick={onInbox} title="Every lane: For you, Dispatch, Filed">
              Inbox <ArrowRight size={11} />
            </SmallButton>
          )}
        </>
      }
    >
      <div>
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
        <p className="text-ui-10-5" style={{ color: 'var(--color-text-tertiary)' }} data-ages>
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
 * lane only, 16 rows then "Show all" in place, with the Inbox page a click away.
 * Each row opens the page that holds its action; a rec can be snoozed or
 * fixed here, and a work-order row dismissed.
 */
export function WaitingPanel() {
  const { waiting, loading, error, setDecisionsOpen, rowActions } = useWaiting();
  const { openItem } = useOpenWaitingItem();
  const navigate = useNavigate();
  return (
    <WaitingPanelView
      waiting={waiting}
      loading={loading}
      error={error}
      now={Date.now()}
      onDecisions={() => setDecisionsOpen(true)}
      onInbox={() => navigate('/inbox')}
      actions={rowActions}
      onOpen={openItem}
    />
  );
}
