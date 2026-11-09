import { ALL_CLEAR, NO_RUN, STALE_AFTER_S, clock, stripLines, type StackHealth, type StackLevel } from '../../lib/stack-api';
import { Chip, Quiet, SmallButton } from '../shared/ui';
import { FeedAge } from './FeedAge';

/** Pure: the Stack health panel body (see StackHealthPanel). Store-free for the tests. */
export function StackHealthPanelView({
  health,
  level,
  age,
  noticeOnly,
  missing,
  error,
  onOpen,
}: {
  health: StackHealth | null;
  level: StackLevel;
  age: number | null;
  noticeOnly: boolean;
  missing: boolean;
  error: string | null;
  onOpen: () => void;
}) {
  if (!health) {
    return <Quiet>{missing ? NO_RUN : error ?? 'Loading…'}</Quiet>;
  }
  const c = health.counts;
  const notices = health.cloud_events.length;
  const [first, second] = level === 'ok' || noticeOnly ? [ALL_CLEAR, ''] : stripLines(health, age);
  const tone = level === 'fail' ? 'error' : level === 'ok' && !noticeOnly ? 'success' : 'warning';
  return (
    <div className="flex flex-col gap-3" data-stack-level={level}>
      <div className="flex flex-wrap gap-1.5">
        {c.FAIL > 0 && <Chip tone="error">{c.FAIL} FAIL</Chip>}
        {c.WARN > 0 && <Chip tone="warning">{c.WARN} WARN</Chip>}
        <Chip tone="success">{c.OK} OK</Chip>
        {c.SKIP > 0 && <Chip tone="muted">{c.SKIP} skipped</Chip>}
        {notices > 0 && (
          <Chip tone="warning" title="Open cloud notices from AWS and Google">
            {notices} cloud notice{notices === 1 ? '' : 's'}
          </Chip>
        )}
      </div>
      <div className="flex flex-col gap-0.5">
        <span className="text-ui-12-5 font-medium" style={{ color: `var(--color-${tone})` }}>
          {first}
        </span>
        {second && (
          <span className="text-ui-11-5 truncate" style={{ color: 'var(--color-text-secondary)' }}>
            {second}
          </span>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 mt-auto">
        <span className="text-ui-11 tabular-nums" style={{ color: 'var(--color-text-tertiary)' }}>
          last run {clock(health.ran_at)}
        </span>
        <SmallButton onClick={onOpen} title="Every check, the cloud events and the company sites">
          Details
        </SmallButton>
      </div>
      <FeedAge label="Stack health" ageSeconds={age} stale={health.stale} staleAfterSeconds={STALE_AFTER_S} />
    </div>
  );
}

