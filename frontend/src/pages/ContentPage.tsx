import { useEffect, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router';
import { ContentView } from '../components/Content/ContentView';
import { isEpisodeId } from '../components/Content/episodes';
import { ALL_PROPERTIES } from '../components/Content/format';
import { useContentData } from '../hooks/useContentData';
import { useStudioData } from '../hooks/useStudioData';
import { scrollToWhenReady } from '../lib/waiting-api';

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
        onApprove={(id, edits) => void data.approve(id, edits)}
        onReject={(id, note) => void data.reject(id, note)}
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
