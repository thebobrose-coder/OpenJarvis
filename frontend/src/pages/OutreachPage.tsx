import { useEffect, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router';
import { PageFrame } from '../components/shared/PageFrame';
import { OutreachView, type ListTab } from '../components/Outreach/OutreachView';
import { useOutreachData } from '../hooks/useOutreachData';
import { useWaiting } from '../lib/WaitingContext';
import { openExternal } from '../lib/open-external';

/** The target accounts for the operator's hand outreach (hq 0031 Part C): see
 * components/Outreach. */
export function OutreachPage() {
  // A Done or Skip can clear the brand's row on "Waiting on you".
  const { refresh } = useWaiting();
  const data = useOutreachData(() => void refresh());
  const [brand, setBrand] = useState<string | null>(null);
  const [openHandle, setOpenHandle] = useState<string | null>(null);
  const [tab, setTab] = useState<ListTab>('targets');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  // ?focus=<brand> from "Waiting on you": that brand's round.
  const location = useLocation();
  const [params] = useSearchParams();
  const focus = params.get('focus');
  useEffect(() => {
    if (focus) setBrand(focus);
  }, [focus, location.key]);

  return (
    <PageFrame>
      <OutreachView
        state={data.state}
        loading={data.loading}
        error={data.error}
        reach={data.reach}
        candidates={data.candidates}
        selectedBrand={brand}
        onSelectBrand={(b) => {
          setBrand(b);
          setOpenHandle(null);
        }}
        now={now}
        busy={data.busy}
        angles={data.angles}
        notice={data.notice}
        onClearNotice={data.clearNotice}
        onOpenProfile={(url) => void openExternal(url)}
        onAngles={data.askAngles}
        onCopyAngle={data.copyAngle}
        onMark={data.mark}
        onCheck={data.check}
        onAdd={data.add}
        onEdit={async (b, handle, edits) => {
          await data.edit(b, handle, edits);
          setOpenHandle(null);
        }}
        onCandidate={data.candidate}
        openHandle={openHandle}
        onOpenAccount={setOpenHandle}
        tab={tab}
        onTab={setTab}
      />
    </PageFrame>
  );
}
