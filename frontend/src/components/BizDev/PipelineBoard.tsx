import { useMemo, useState, type DragEvent } from 'react';
import { KanbanSquare } from 'lucide-react';
import { BOARD_STAGES, rankBreakdown, rankNumber, type BoardStage, type PipelineProspect } from '../../lib/bizdev-api';
import { DashboardPanel } from '../Dashboard/DashboardPanel';
import { num } from '../shared/format';
import { Chip, Quiet, Select } from '../shared/ui';

export const STAGE_LABELS: Record<string, string> = {
  new: 'New',
  drafted: 'Drafted',
  sent: 'Sent',
  replied: 'Replied',
  meeting: 'Meeting',
  won: 'Won',
  lost: 'Lost',
  not_interested: 'Not interested',
  do_not_contact: 'Do not contact',
  bounced: 'Bounced',
};

const DRAG_TYPE = 'application/x-bizdev-prospect';

export interface BoardFilters {
  association: string;
  division: string;
  state: string;
  platform: string;
  affiliation: string;
  minFit: number;
  /** 0 = any; above 0, unranked cards are hidden. */
  minRank: number;
}

export const NO_FILTERS: BoardFilters = {
  association: '',
  division: '',
  state: '',
  platform: '',
  affiliation: '',
  minFit: 0,
  minRank: 0,
};

export const MIN_RANK_OPTIONS = [0, 0.5, 1, 2, 3, 4, 5];
const RANK_ACCENT = 3;

export function matches(p: PipelineProspect, f: BoardFilters): boolean {
  return (
    (!f.association || p.association === f.association) &&
    (!f.division || p.division === f.division) &&
    (!f.state || p.state === f.state) &&
    (!f.platform || (p.signals?.platform ?? '') === f.platform) &&
    (!f.affiliation || p.affiliation === f.affiliation) &&
    (p.fit_score ?? 0) >= f.minFit &&
    (!f.minRank || (p.rank?.score ?? -1) >= f.minRank)
  );
}

/** Hermes sends each stage sorted by rank; keep that order, with any
 * unranked (older) cards after the ranked ones. Never re-sorts by score. */
export function boardOrder(items: PipelineProspect[]): PipelineProspect[] {
  return [...items.filter((p) => p.rank), ...items.filter((p) => !p.rank)];
}

export function RankChip({ p }: { p: PipelineProspect }) {
  if (!p.rank) return null;
  return (
    <Chip tone={p.rank.score >= RANK_ACCENT ? 'accent' : 'neutral'} title={rankBreakdown(p) ?? undefined}>
      rank {rankNumber(p.rank.score)}
    </Chip>
  );
}

function values(all: PipelineProspect[], pick: (p: PipelineProspect) => string | null | undefined): string[] {
  return [...new Set(all.map(pick).filter(Boolean) as string[])].sort();
}

function ProspectCard({ p, onOpen }: { p: PipelineProspect; onOpen: () => void }) {
  const noContacts = !(p.contacts ?? []).some((c) => c.email || c.phone);
  return (
    <button
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, String(p.id));
        e.dataTransfer.effectAllowed = 'move';
      }}
      onClick={onOpen}
      className="flex flex-col gap-1 w-full text-left rounded-lg p-2.5 cursor-grab active:cursor-grabbing"
      style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text-secondary)' }}
      title="Open, or drag to another stage"
    >
      <span className="text-[12.5px] font-medium leading-snug" style={{ color: 'var(--color-text)' }}>
        {p.name}
      </span>
      <span className="text-[11px]">
        {[p.association, p.division, p.state].filter(Boolean).join(' · ')}
      </span>
      <div className="flex flex-wrap items-center gap-1">
        <RankChip p={p} />
        {p.fit_score != null && (
          <Chip tone={p.fit_score >= 4 ? 'accent' : 'neutral'} title="Fit, 1-5">
            fit {p.fit_score}
          </Chip>
        )}
        {p.affiliation && <Chip tone="muted">{p.affiliation}</Chip>}
        {p.signals?.platform && <Chip tone="muted">{p.signals.platform}</Chip>}
        {noContacts && <Chip tone="warning">no contacts</Chip>}
        {p.recheck?.kept_previous && (
          <Chip tone="muted" title="A re-check came back worse; the earlier research was kept">
            re-checked
          </Chip>
        )}
        {p.days_in_stage != null && (
          <span className="text-[10.5px] ml-auto" style={{ color: 'var(--color-text-tertiary)' }}>
            {num(p.days_in_stage)} d
          </span>
        )}
      </div>
    </button>
  );
}

function Column({
  stage,
  items,
  onOpen,
  onDropProspect,
}: {
  stage: BoardStage;
  items: PipelineProspect[];
  onOpen: (p: PipelineProspect) => void;
  onDropProspect: (id: number, stage: BoardStage) => void;
}) {
  const [over, setOver] = useState(false);
  // Nothing can be moved back to New: the stage route starts at "drafted".
  const accepts = stage !== 'new';
  const onDragOver = (e: DragEvent) => {
    if (!accepts || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    setOver(true);
  };
  const onDrop = (e: DragEvent) => {
    setOver(false);
    const id = Number(e.dataTransfer.getData(DRAG_TYPE));
    if (accepts && id) onDropProspect(id, stage);
  };

  return (
    <section
      aria-label={STAGE_LABELS[stage]}
      onDragOver={onDragOver}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className="flex flex-col gap-2 rounded-lg p-2 flex-1 min-w-[8.75rem]"
      style={{
        background: 'var(--color-bg-secondary)',
        border: `1px dashed ${over ? 'var(--color-accent)' : 'transparent'}`,
      }}
    >
      <header className="flex items-center justify-between px-1">
        <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--color-text-tertiary)' }}>
          {STAGE_LABELS[stage]}
        </span>
        <span className="text-[11px] tabular-nums" style={{ color: 'var(--color-text-tertiary)' }}>
          {items.length}
        </span>
      </header>
      <div className="flex flex-col gap-1.5 max-h-[60vh] overflow-y-auto">
        {boardOrder(items).map((p) => (
          <ProspectCard key={p.id} p={p} onOpen={() => onOpen(p)} />
        ))}
      </div>
    </section>
  );
}

export function PipelineBoard({
  stages,
  suppressed,
  onOpen,
  onMove,
  loading,
  error,
  empty,
}: {
  stages: Record<BoardStage, PipelineProspect[]>;
  suppressed: number;
  onOpen: (p: PipelineProspect) => void;
  onMove: (id: number, stage: BoardStage) => void;
  loading?: boolean;
  error?: string | null;
  empty: boolean;
}) {
  const [filters, setFilters] = useState<BoardFilters>(NO_FILTERS);
  const all = useMemo(() => BOARD_STAGES.flatMap((s) => stages[s]), [stages]);
  const set = <K extends keyof BoardFilters>(k: K) => (v: BoardFilters[K]) => setFilters((f) => ({ ...f, [k]: v }));
  const opts = (vals: string[]) => [{ value: '', label: 'All' }, ...vals.map((v) => ({ value: v, label: v }))];
  const shown = all.filter((p) => matches(p, filters)).length;

  return (
    <DashboardPanel
      icon={KanbanSquare}
      title="Pipeline"
      tag={empty ? undefined : `${shown} shown · ${num(suppressed)} suppressed`}
      size="full"
      priority
      loading={loading}
      error={error}
    >
      {empty ? (
        <Quiet>No pipeline yet -- Hermes publishes it after the first research batch.</Quiet>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <Select label="Association" value={filters.association} onChange={set('association')} options={opts(values(all, (p) => p.association))} />
            <Select label="Division" value={filters.division} onChange={set('division')} options={opts(values(all, (p) => p.division))} />
            <Select label="State" value={filters.state} onChange={set('state')} options={opts(values(all, (p) => p.state))} />
            <Select label="Platform" value={filters.platform} onChange={set('platform')} options={opts(values(all, (p) => p.signals?.platform))} />
            <Select label="Affiliation" value={filters.affiliation} onChange={set('affiliation')} options={opts(values(all, (p) => p.affiliation))} />
            <Select
              label="Fit ≥"
              value={String(filters.minFit)}
              onChange={(v) => set('minFit')(Number(v))}
              options={[0, 1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: n ? String(n) : 'Any' }))}
            />
            <Select
              label="Rank ≥"
              value={String(filters.minRank)}
              onChange={(v) => set('minRank')(Number(v))}
              options={MIN_RANK_OPTIONS.map((n) => ({ value: String(n), label: n ? String(n) : 'Any' }))}
            />
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {BOARD_STAGES.map((stage) => (
              <Column
                key={stage}
                stage={stage}
                items={stages[stage].filter((p) => matches(p, filters))}
                onOpen={onOpen}
                onDropProspect={onMove}
              />
            ))}
          </div>
        </div>
      )}
    </DashboardPanel>
  );
}
