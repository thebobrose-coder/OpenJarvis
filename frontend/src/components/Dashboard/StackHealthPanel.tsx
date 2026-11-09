import { Activity } from 'lucide-react';
import { useStackHealth } from '../../hooks/useStackHealth';
import { useAppStore } from '../../lib/store';
import type { StackLevel } from '../../lib/stack-api';
import { DashboardPanel } from './DashboardPanel';
import { StackHealthPanelView } from './StackHealthPanelView';

const LEVEL_TAG: Record<StackLevel, string> = {
  ok: 'all clear',
  warn: 'warnings',
  fail: 'failing',
  stale: 'stale run',
  unavailable: 'unavailable',
};

/** The stack-health run as a Dashboard panel (widescreen plan, Phase 1): the counts
 * and the headline the sidebar dock shows, with the drawer one click away. */
export function StackHealthPanel() {
  const s = useStackHealth();
  const setOpen = useAppStore((st) => st.setStackDrawerOpen);
  return (
    <DashboardPanel
      icon={Activity}
      title="Stack health"
      tag={s.health ? LEVEL_TAG[s.level] : undefined}
      size="quarter"
      band="short"
      priority={s.level === 'fail'}
      loading={!s.health && !s.missing && !s.error}
      error={null}
    >
      <StackHealthPanelView
        health={s.health}
        level={s.level}
        age={s.age}
        noticeOnly={s.noticeOnly}
        missing={s.missing}
        error={s.error}
        onOpen={() => setOpen(true)}
      />
    </DashboardPanel>
  );
}
