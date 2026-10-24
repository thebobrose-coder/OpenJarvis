import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { ContentView } from '../components/Content/ContentView';
import { isEpisodeId } from '../components/Content/episodes';
import { ALL_PROPERTIES } from '../components/Content/format';
import { useContentData } from '../hooks/useContentData';
import { useStudioData } from '../hooks/useStudioData';
import { scrollToWhenReady } from '../lib/waiting-api';
import { useAppStore } from '../lib/store';
import { contextBlock } from '../lib/desks-api';
import type { Proposal } from '../lib/content-api';

/** What "Ask the desk" sends as a proposal's context: the card as the page shows it. */
export function proposalContext(p: Proposal): { block: string; label: string } {
  const keys = [
    'id', 'property_id', 'lane', 'content_type', 'topic', 'rationale', 'pillar_hint', 'product_handle',
    'target_queries', 'priority', 'status', 'note', 'source_links', 'created_at', 'motion', 'motion_brief',
    'episode_class', 'target_minutes',
  ] as const;
  const item: Record<string, unknown> = { page: '/content', kind: 'proposal' };
  for (const k of keys) {
    const v = (p as unknown as Record<string, unknown>)[k];
    if (v != null && v !== '') item[k] = v;
  }
  const topic = p.topic.length > 40 ? `${p.topic.slice(0, 40)}…` : p.topic;
  return { block: contextBlock(item), label: `proposal “${topic}”` };
}

/** Hermes's content loop on one page: see components/Content. */
export function ContentPage() {
  const data = useContentData();
  const studio = useStudioData();
  const [property, setProperty] = useState(ALL_PROPERTIES);
  // ?focus=<id> from "Waiting on you": a proposal, a thesis prompt, or a G0 episode.
  const location = useLocation();
  const [params] = useSearchParams();
  const focus = params.get('focus');
  const openEpisode = studio.open;

  // Desks (hq 0020 P2): "Ask the desk" on a proposal, and a desk's
  // proposal_decision card opening the editor filled in. The operator's own
  // submit sends it; the thread then gets the outcome line.
  const navigate = useNavigate();
  const openDeskThread = useAppStore((s) => s.openDeskThread);
  const handoff = useAppStore((s) => s.deskHandoff);
  const setDeskHandoff = useAppStore((s) => s.setDeskHandoff);
  const addOutcome = useAppStore((s) => s.addOutcome);
  const deskDecision = useMemo(
    () =>
      handoff?.kind === 'proposal_decision'
        ? { id: handoff.id, decision: handoff.decision, fields: handoff.fields, nonce: Date.now() }
        : null,
    [handoff],
  );
  const settle = (id: string, ok: boolean, what: 'approved' | 'rejected') => {
    if (ok && handoff?.kind === 'proposal_decision' && handoff.id === id) {
      addOutcome(handoff.thread, `Proposal ${what}`);
      setDeskHandoff(null);
    }
  };
  useEffect(() => {
    if (!focus) return undefined;
    setProperty(ALL_PROPERTIES);
    if (isEpisodeId(focus)) openEpisode(focus);
    return scrollToWhenReady([`proposal-${focus}`, `prompt-${focus}`, `episode-${focus}`]);
  }, [focus, location.key, openEpisode]);

  return (
    <div className="flex-1 overflow-y-auto px-6 py-10">
      <ContentView
        feeds={data.feeds}
        pending={data.pending}
        selectedProperty={property}
        onSelectProperty={setProperty}
        onApprove={(id, edits) => void data.approve(id, edits).then((ok) => settle(id, ok, 'approved'))}
        onReject={(id, note) => void data.reject(id, note).then((ok) => settle(id, ok, 'rejected'))}
        onAskDesk={(p) => {
          openDeskThread('content', proposalContext(p));
          navigate('/');
        }}
        deskDecision={deskDecision}
        onPrompt={(id, action) => void data.prompt(id, action)}
        onResearch={() => void data.research()}
        researchStatus={data.researchStatus}
        researchAvailableAt={data.researchAvailableAt}
        onQueueSeed={data.queueSeed}
        onVerifyProduct={data.verifyProduct}
        onRunIntake={() => void data.runIntake()}
        intakeStatus={data.intakeStatus}
        intakeAvailableAt={data.intakeAvailableAt}
        seededPrompts={data.seededPrompts}
        notice={data.notice ?? studio.notice}
        onClearNotice={data.notice ? data.clearNotice : studio.clearNotice}
        studio={{
          status: studio.status,
          episodes: studio.episodes,
          loading: studio.loading,
          error: studio.error,
          onOpen: studio.open,
          onRun: () => void studio.run(),
          runStatus: studio.runStatus,
          runAvailableAt: studio.runAvailableAt,
          runError: studio.runError,
          onPause: (id, paused) => void studio.pause(id, paused),
          pausing: studio.pausing,
          openId: studio.openId,
          detail: studio.detail,
          detailLoading: studio.detailLoading,
          detailError: studio.detailError,
          actions: studio.actions,
          onClose: studio.close,
        }}
      />
    </div>
  );
}
