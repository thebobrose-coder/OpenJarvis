import { useNavigate } from 'react-router';
import { Inbox } from 'lucide-react';
import { DashboardPanel } from './DashboardPanel';
import { SmallButton } from '../shared/ui';
import { WaitingListView } from '../Waiting/WaitingListView';
import { useWaiting } from '../../lib/WaitingContext';
import { fmtAge, groupItems, linkFor, sourceAges, staleSources, type Waiting, type WaitingItem } from '../../lib/waiting-api';

/** Pure: the panel's body for a given poll (see WaitingPanel). */
export function WaitingPanelView({
  waiting,
  loading,
  error,
  now,
  onOpen,
  onDecisions,
}: {
  waiting: Waiting | null;
  loading: boolean;
  error: string | null;
  now: number;
  onOpen: (item: WaitingItem) => void;
  onDecisions: () => void;
}) {
  const total = waiting?.counts.total ?? 0;
  return (
    <DashboardPanel
      icon={Inbox}
      title="Waiting on you"
      tag={waiting ? `${total} waiting` : undefined}
      size="full"
      priority={total > 0}
      loading={loading && !waiting}
      error={!waiting ? error : null}
      actions={
        <SmallButton onClick={onDecisions} title="The open decision boxes in the inbox briefs">
          Decisions
        </SmallButton>
      }
    >
      <div className="max-h-[26rem] overflow-y-auto pr-1">
        <WaitingListView groups={groupItems(waiting)} stale={staleSources(waiting)} now={now} perGroup={8} onOpen={onOpen} />
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
 * The Dashboard's "Waiting on you" panel (hq 0020 P1): the bell's list,
 * grouped, with ages and due dates. Each row opens the page that holds its
 * action; the panel itself never acts.
 */
export function WaitingPanel() {
  const { waiting, loading, error, setDecisionsOpen, setG1Open } = useWaiting();
  const navigate = useNavigate();
  return (
    <WaitingPanelView
      waiting={waiting}
      loading={loading}
      error={error}
      now={Date.now()}
      onDecisions={() => setDecisionsOpen(true)}
      onOpen={(item) => {
        if (item.opens === 'decisions') setDecisionsOpen(true);
        else if (item.opens === 'g1') setG1Open(String(item.id));
        else {
          const href = linkFor(item);
          if (href) navigate(href);
        }
      }}
    />
  );
}
