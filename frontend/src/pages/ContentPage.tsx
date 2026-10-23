import { useEffect, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router';
import { ContentView } from '../components/Content/ContentView';
import { ALL_PROPERTIES } from '../components/Content/format';
import { useContentData } from '../hooks/useContentData';
import { scrollToWhenReady } from '../lib/waiting-api';

/** Hermes's content loop on one page: see components/Content. */
export function ContentPage() {
  const data = useContentData();
  const [property, setProperty] = useState(ALL_PROPERTIES);
  // ?focus=<id> from "Waiting on you": a proposal or a thesis prompt.
  const location = useLocation();
  const [params] = useSearchParams();
  const focus = params.get('focus');
  useEffect(() => {
    if (!focus) return undefined;
    setProperty(ALL_PROPERTIES);
    return scrollToWhenReady([`proposal-${focus}`, `prompt-${focus}`]);
  }, [focus, location.key]);

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
        notice={data.notice}
        onClearNotice={data.clearNotice}
      />
    </div>
  );
}
