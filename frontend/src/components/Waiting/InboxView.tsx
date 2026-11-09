import { Inbox } from 'lucide-react';
import { DashboardPanel } from '../Dashboard/DashboardPanel';
import { SmallButton } from '../shared/ui';
import { WaitingTabsView } from './WaitingListView';
import { bellCount, fmtAge, laneCount, sourceAges, type Lane, type Waiting } from '../../lib/waiting-api';

/** Pure: the Inbox page for a given poll (see pages/InboxPage). Store-free, so tests
 * render it with the server renderer like the other Waiting views. */
export function InboxView({
  waiting,
  loading,
  error,
  now,
  tab,
  onTab,
  onDecisions,
  ...rest
}: {
  waiting: Waiting | null;
  loading: boolean;
  error: string | null;
  now: number;
  tab: Lane;
  onTab: (lane: Lane) => void;
  onDecisions: () => void;
} & Pick<Parameters<typeof WaitingTabsView>[0], 'onOpen' | 'onFiled' | 'actions'>) {
  const act = bellCount(waiting);
  const ages = sourceAges(waiting, now);
  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-ui-20 font-semibold" style={{ color: 'var(--color-text)' }}>
            Inbox
          </h1>
          <p className="text-ui-12-5" style={{ color: 'var(--color-text-secondary)' }}>
            Everything waiting on you, what you can dispatch, and what is filed. Rows open the page that holds the action.
          </p>
        </div>
        {waiting && (
          <p className="text-ui-11" style={{ color: 'var(--color-text-tertiary)' }} data-ages>
            {ages.map((s) => `${s.label} ${fmtAge(s.age)}`).join(' · ')}
          </p>
        )}
      </header>
      <div className="grid grid-cols-12 gap-4">
        <DashboardPanel
          icon={Inbox}
          title="Waiting on you"
          tag={waiting ? `${act} for you · ${laneCount(waiting, 'delegate')} to dispatch · ${laneCount(waiting, 'fyi')} filed` : undefined}
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
          <WaitingTabsView waiting={waiting} tab={tab} onTab={onTab} now={now} {...rest} />
        </DashboardPanel>
      </div>
    </div>
  );
}

