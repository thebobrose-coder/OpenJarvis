import { useEffect, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router';
import { BizDevView, type BizDevTab } from '../components/BizDev/BizDevView';
import { RECHECK_DAILY_CAP, useBizDevData } from '../hooks/useBizDevData';

/** Hermes's bd-researcher pipeline on one page: see components/BizDev. */
export function BizDevPage() {
  const data = useBizDevData();
  const [line, setLine] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [tab, setTab] = useState<BizDevTab>('pipeline');
  // ?focus=<prospect id> from "Waiting on you": open that card's drawer.
  const location = useLocation();
  const [params] = useSearchParams();
  const focus = params.get('focus');
  useEffect(() => {
    const id = Number(focus);
    if (focus && Number.isInteger(id)) {
      setTab('pipeline');
      setOpenId(id);
    }
  }, [focus, location.key]);

  return (
    <div className="flex-1 overflow-y-auto px-6 py-10">
      <BizDevView
        feeds={data.feeds}
        pending={data.pending}
        selectedLine={line}
        onSelectLine={setLine}
        openProspectId={openId}
        onOpenProspect={setOpenId}
        onMove={(id, stage, note, touch) => void data.move(id, stage, note, touch)}
        onRecheck={(id) => void data.recheck(id)}
        recheckDisabled={data.recheckDisabled}
        rechecksToday={data.rechecksToday}
        recheckCap={RECHECK_DAILY_CAP}
        onResearch={() => void data.research()}
        researchStatus={data.researchStatus}
        notice={data.notice}
        onClearNotice={data.clearNotice}
        sendConfig={data.sendConfig}
        onSend={data.send}
        tab={tab}
        onTab={setTab}
        onSaveTemplate={data.saveTemplate}
        onArchiveTemplate={data.archiveTemplate}
        onAddContact={data.addRecipient}
        contactNotes={data.contactNotes}
        onConfirmMeeting={data.confirmMeeting}
      />
    </div>
  );
}
