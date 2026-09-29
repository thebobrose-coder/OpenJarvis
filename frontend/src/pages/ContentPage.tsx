import { useState } from 'react';
import { ContentView } from '../components/Content/ContentView';
import { ALL_PROPERTIES } from '../components/Content/format';
import { useContentData } from '../hooks/useContentData';

/** Hermes's content loop on one page: see components/Content. */
export function ContentPage() {
  const data = useContentData();
  const [property, setProperty] = useState(ALL_PROPERTIES);

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
        notice={data.notice}
        onClearNotice={data.clearNotice}
      />
    </div>
  );
}
