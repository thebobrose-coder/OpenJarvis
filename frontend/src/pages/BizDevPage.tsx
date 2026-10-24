import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { useAppStore } from '../lib/store';
import { contextBlock } from '../lib/desks-api';
import type { PipelineProspect } from '../lib/bizdev-api';

/** What "Ask the desk" sends as a prospect's context: the card as the page
 * shows it, without its contacts or draft. */
export function prospectContext(p: PipelineProspect): { block: string; label: string } {
  const keys = [
    'id', 'line', 'name', 'stage', 'days_in_stage', 'stage_changed_at', 'association', 'division', 'conference', 'state', 'affiliation', 'fit_score',
    'fit_rationale', 'rank', 'proposed_stage', 'signal_notes',
  ] as const;
  const item: Record<string, unknown> = { page: '/bizdev', kind: 'prospect' };
  for (const k of keys) {
    const v = (p as unknown as Record<string, unknown>)[k];
    if (v != null && v !== '') item[k] = v;
  }
  const name = p.name || `prospect ${p.id}`;
  return { block: contextBlock(item), label: name.length > 40 ? `${name.slice(0, 40)}…` : name };
}
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

  // Desks (hq 0020 P2): "Ask the desk" on the open prospect, and an `open`
  // card's draft placed in the drawer's message field. Send stays the
  // drawer's own button.
  const navigate = useNavigate();
  const openDeskThread = useAppStore((s) => s.openDeskThread);
  const handoff = useAppStore((s) => s.deskHandoff);
  const setDeskHandoff = useAppStore((s) => s.setDeskHandoff);
  const draft = handoff?.kind === 'draft' && handoff.page === '/bizdev' && Number(handoff.focus) === openId ? handoff.draft : null;

  return (
    <div className="flex-1 overflow-y-auto px-6 py-10">
      <BizDevView
        feeds={data.feeds}
        pending={data.pending}
        selectedLine={line}
        onSelectLine={setLine}
        openProspectId={openId}
        onOpenProspect={(id) => {
          // A desk draft is for one opening of the drawer.
          if (id == null && handoff?.kind === 'draft') setDeskHandoff(null);
          setOpenId(id);
        }}
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
        deskDraft={draft}
        onAskDesk={(p) => {
          openDeskThread('bd', prospectContext(p));
          navigate('/');
        }}
      />
    </div>
  );
}
