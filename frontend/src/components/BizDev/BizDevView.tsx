import { firstBlock, type SpeechBlock, type SpeechFeed } from '../../lib/voice-api';
import { X } from 'lucide-react';
import {
  BOARD_STAGES,
  type ContactAdd,
  type PipelineProspect,
  type SendConfig,
  type SendRequest,
  type SendResult,
  type StageAction,
  type TemplateSave,
} from '../../lib/bizdev-api';
import { applyMoves, type BizDevFeedStates, type PendingMove } from '../../hooks/useBizDevData';
import { BizDevHeader } from './BizDevHeader';
import { FollowUpsStrip } from './FollowUpsStrip';
import { InsightsPanel, ResearchLog } from './InsightsPanel';
import { PipelineBoard } from './PipelineBoard';
import { ProspectDrawer, type ContactNote } from './ProspectDrawer';
import { TemplatesPanel } from './Templates';
import { Segmented } from '../shared/ui';

export type BizDevTab = 'pipeline' | 'templates';

export interface BizDevViewProps {
  feeds: BizDevFeedStates;
  pending: Record<number, PendingMove>;
  selectedLine: string | null;
  onSelectLine: (line: string) => void;
  openProspectId: number | null;
  onOpenProspect: (id: number | null) => void;
  onMove: (id: number, stage: StageAction, note?: string, touch?: number) => void;
  onRecheck: (id: number) => void;
  recheckDisabled: boolean;
  rechecksToday: number;
  recheckCap: number;
  onResearch: () => void;
  researchStatus: 'idle' | 'queued' | 'error';
  notice?: string | null;
  onClearNotice?: () => void;
  /** Send through Forward Email (hq 0018); null keeps the mail link path. */
  sendConfig?: SendConfig | null;
  onSend?: (id: number, req: SendRequest) => Promise<SendResult>;
  /** Templates (Part C): the Templates tab and "Save as template…". */
  tab?: BizDevTab;
  onTab?: (tab: BizDevTab) => void;
  onSaveTemplate?: (t: TemplateSave) => Promise<void>;
  onArchiveTemplate?: (id: number) => Promise<void>;
  /** "Add recipient" (A3) and what became of each add, by prospect id. */
  onAddContact?: (id: number, c: ContactAdd) => Promise<void>;
  contactNotes?: Record<number, ContactNote>;
  /** Part D: Confirm on "Meeting on the calendar?". */
  onConfirmMeeting?: (id: number) => Promise<void>;
  /** Desks (hq 0020 P2): a BD desk card's draft for the open prospect, put in
   * the drawer's message field (never sent), and "Ask the desk". */
  deskDraft?: string | null;
  onAskDesk?: (prospect: PipelineProspect) => void;
}

/**
 * The Business Development page: header, follow-ups due, the pipeline board
 * (with the prospect drawer), insights and the research log. Generic by
 * business line. Pure: everything comes in through props (see BizDevPage).
 */
/** Follow-ups due (bd_pipeline) first, else the latest research run (bd_prospects). */
export function bdSpeech(
  pipeline: { speech?: SpeechBlock[] } | null | undefined,
  prospects: { speech?: SpeechBlock[] } | null | undefined,
): { feed: SpeechFeed; block: SpeechBlock | null } {
  const follow = firstBlock(pipeline?.speech);
  if (follow) return { feed: 'bd_pipeline', block: follow };
  return { feed: 'bd_prospects', block: firstBlock(prospects?.speech) };
}

export function BizDevView(props: BizDevViewProps) {
  const { feeds, pending } = props;
  const pipeline = feeds.bd_pipeline.data;
  const lines = (pipeline?.lines ?? []).map((l) => ({ line: l.line, display_name: l.display_name }));
  const lineId = props.selectedLine ?? lines[0]?.line ?? null;
  const line = pipeline?.lines.find((l) => l.line === lineId);
  const stats = feeds.bd_stats.data?.lines.find((l) => l.line === lineId) ?? (lines.length ? undefined : feeds.bd_stats.data?.lines[0]);
  const { stages, suppressed, followUps } = applyMoves(line, pending);

  const byId = new Map<number, PipelineProspect>();
  for (const s of BOARD_STAGES) for (const p of stages[s]) byId.set(p.id, p);
  const open = props.openProspectId != null ? byId.get(props.openProspectId) : undefined;
  const compose = line ? { line: line.line, screen: line.screen, templates: line.templates } : null;
  const templates = line?.templates ?? [];
  const tab = props.tab ?? 'pipeline';
  const liveTemplates = templates.filter((t) => !t.archived_at).length;

  return (
    <div className="max-w-[1800px] mx-auto">
      <BizDevHeader
        lines={lines}
        selectedLine={lineId ?? ''}
        onSelectLine={props.onSelectLine}
        pipeline={pipeline}
        prospects={feeds.bd_prospects.data}
        stats={stats}
        researchStatus={props.researchStatus}
        onResearch={props.onResearch}
        sendEnabled={!!props.sendConfig?.enabled}
      />

      {props.notice && (
        <div
          className="flex items-center justify-between gap-2 rounded-lg px-3 py-2 mb-4 text-[12px]"
          style={{ border: '1px solid var(--color-warning)', color: 'var(--color-text-secondary)' }}
          role="status"
        >
          <span>{props.notice}</span>
          {props.onClearNotice && (
            <button onClick={props.onClearNotice} aria-label="Dismiss" className="cursor-pointer" style={{ background: 'transparent', border: 'none', color: 'inherit' }}>
              <X size={12} />
            </button>
          )}
        </div>
      )}

      {props.onTab && (
        <div className="mb-4">
          <Segmented<BizDevTab>
            ariaLabel="Business Development view"
            value={tab}
            onChange={props.onTab}
            options={[
              { value: 'pipeline', label: 'Pipeline' },
              { value: 'templates', label: `Templates${liveTemplates ? ` (${liveTemplates})` : ''}` },
            ]}
          />
        </div>
      )}

      {tab === 'templates' ? (
        <div className="grid grid-cols-12 gap-4 mb-10">
          <TemplatesPanel
            line={line?.line ?? null}
            templates={templates}
            onSave={props.onSaveTemplate ?? (() => Promise.reject(new Error('Templates are read-only here')))}
            onArchive={props.onArchiveTemplate ?? (() => Promise.reject(new Error('Templates are read-only here')))}
          />
        </div>
      ) : (
        <>
          {followUps.length > 0 && (
            <div className="grid grid-cols-12 gap-4 mb-4">
              <FollowUpsStrip
                followUps={followUps}
                prospectsById={byId}
                onMarkSent={(id, touch) => props.onMove(id, 'sent', '', touch)}
                sendConfig={props.sendConfig}
                onSend={props.onSend}
                line={compose}
                onSaveTemplate={props.onSaveTemplate}
              />
            </div>
          )}

          <div className="grid grid-cols-12 gap-4 mb-4">
            <PipelineBoard
              stages={stages}
              suppressed={suppressed}
              empty={!line}
              onOpen={(p) => props.onOpenProspect(p.id)}
              onMove={(id, stage) => stage !== 'new' && props.onMove(id, stage)}
              loading={feeds.bd_pipeline.loading}
              error={feeds.bd_pipeline.error}
              speech={bdSpeech(pipeline, feeds.bd_prospects.data)}
            />
          </div>

          <div className="grid grid-cols-12 gap-4 mb-10">
            <InsightsPanel stats={stats} loading={feeds.bd_stats.loading} error={feeds.bd_stats.error} templates={templates} />
            <ResearchLog prospects={feeds.bd_prospects.data} loading={feeds.bd_prospects.loading} error={feeds.bd_prospects.error} />
          </div>
        </>
      )}

      {open && (
        <ProspectDrawer
          prospect={open}
          onClose={() => props.onOpenProspect(null)}
          onMove={(stage, note) => props.onMove(open.id, stage, note)}
          onRecheck={() => props.onRecheck(open.id)}
          recheckDisabled={props.recheckDisabled}
          rechecksToday={props.rechecksToday}
          recheckCap={props.recheckCap}
          sendConfig={props.sendConfig}
          onSend={props.onSend ? (req) => props.onSend!(open.id, req) : undefined}
          line={compose}
          onSaveTemplate={props.onSaveTemplate}
          onAddContact={props.onAddContact ? (c) => props.onAddContact!(open.id, c) : undefined}
          contactNote={props.contactNotes?.[open.id] ?? null}
          onConfirmMeeting={props.onConfirmMeeting ? () => props.onConfirmMeeting!(open.id) : undefined}
          followUp={followUps.find((f) => f.prospect_id === open.id) ?? null}
          onMarkFollowUpSent={(touch) => props.onMove(open.id, 'sent', '', touch)}
          deskDraft={props.deskDraft ?? null}
          onAskDesk={props.onAskDesk ? () => props.onAskDesk!(open) : undefined}
        />
      )}
    </div>
  );
}
