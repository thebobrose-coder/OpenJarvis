import { X } from 'lucide-react';
import { BOARD_STAGES, type PipelineProspect, type StageAction } from '../../lib/bizdev-api';
import { applyMoves, type BizDevFeedStates, type PendingMove } from '../../hooks/useBizDevData';
import { BizDevHeader } from './BizDevHeader';
import { FollowUpsStrip } from './FollowUpsStrip';
import { InsightsPanel, ResearchLog } from './InsightsPanel';
import { PipelineBoard } from './PipelineBoard';
import { ProspectDrawer } from './ProspectDrawer';

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
}

/**
 * The Business Development page: header, follow-ups due, the pipeline board
 * (with the prospect drawer), insights and the research log. Generic by
 * business line. Pure: everything comes in through props (see BizDevPage).
 */
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

      {followUps.length > 0 && (
        <div className="grid grid-cols-12 gap-4 mb-4">
          <FollowUpsStrip
            followUps={followUps}
            prospectsById={byId}
            onMarkSent={(id, touch) => props.onMove(id, 'sent', '', touch)}
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
        />
      </div>

      <div className="grid grid-cols-12 gap-4 mb-10">
        <InsightsPanel stats={stats} loading={feeds.bd_stats.loading} error={feeds.bd_stats.error} />
        <ResearchLog prospects={feeds.bd_prospects.data} loading={feeds.bd_prospects.loading} error={feeds.bd_prospects.error} />
      </div>

      {open && (
        <ProspectDrawer
          prospect={open}
          onClose={() => props.onOpenProspect(null)}
          onMove={(stage, note) => props.onMove(open.id, stage, note)}
          onRecheck={() => props.onRecheck(open.id)}
          recheckDisabled={props.recheckDisabled}
          rechecksToday={props.rechecksToday}
          recheckCap={props.recheckCap}
        />
      )}
    </div>
  );
}
