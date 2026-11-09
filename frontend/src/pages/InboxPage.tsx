import { useState } from 'react';
import { PageFrame } from '../components/shared/PageFrame';
import { InboxView } from '../components/Waiting/InboxView';
import { useOpenWaitingItem, useWaiting } from '../lib/WaitingContext';
import type { Lane } from '../lib/waiting-api';

/** /inbox (widescreen plan, Phase 1): the Waiting lanes as a page. The bell's badge
 * opens it; the Dashboard's act band shows the For you lane and links here. */
export function InboxPage() {
  const { waiting, loading, error, setDecisionsOpen, rowActions } = useWaiting();
  const { openItem, openFiled } = useOpenWaitingItem();
  const [tab, setTab] = useState<Lane>('act');
  return (
    <PageFrame>
      <InboxView
        waiting={waiting}
        loading={loading}
        error={error}
        now={Date.now()}
        tab={tab}
        onTab={setTab}
        onDecisions={() => setDecisionsOpen(true)}
        onOpen={openItem}
        onFiled={openFiled}
        actions={rowActions}
      />
    </PageFrame>
  );
}
