import { SpeakButton } from '../shared/SpeakButton';
import type { SpeechBlock, SpeechFeed } from '../../lib/voice-api';
import { useMemo, useState, type DragEvent } from 'react';
import { KanbanSquare } from 'lucide-react';
import { BOARD_STAGES, rankBreakdown, rankNumber, type BoardStage, type PipelineProspect } from '../../lib/bizdev-api';
import { DashboardPanel } from '../Dashboard/DashboardPanel';
import { num } from '../shared/format';
import { Chip, Quiet, Segmented, Select } from '../shared/ui';

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

export const DRAG_TYPE = 'application/x-bizdev-prospect';

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

/** List view: one table across stages, highest rank first, unranked last.
 * A stable sort, so ties keep Hermes's per-stage order. */
export function listOrder(items: PipelineProspect[]): PipelineProspect[] {
  return [...items].sort((a, b) => (b.rank?.score ?? -Infinity) - (a.rank?.score ?? -Infinity));
}

function values(all: PipelineProspect[], pick: (p: PipelineProspect) => string | null | undefined): string[] {
  return [...new Set(all.map(pick).filter(Boolean) as string[])].sort();
}

/** Nothing can be moved back to New (the stage route starts at "drafted");
 * every other column takes a drop, including an empty rail. */
export function acceptsDrop(stage: BoardStage, types: readonly string[]): boolean {
  return stage !== 'new' && types.includes(DRAG_TYPE);
}

function hasContacts(p: PipelineProspect): boolean {
  return (p.contacts ?? []).some((c) => c.email || c.phone);
}

function ProspectCard({ p, onOpen, onDragging }: { p: PipelineProspect; onOpen: () => void; onDragging: (on: boolean) => void }) {
  return (
    <button
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, String(p.id));
        e.dataTransfer.effectAllowed = 'move';
        onDragging(true);
      }}
      onDragEnd={() => onDragging(false)}
      onClick={onOpen}
      className="flex flex-col gap-1 w-full text-left rounded-lg p-2.5 cursor-grab active:cursor-grabbing"
      style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text-secondary)' }}
      title="Open, or drag to another stage"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-[12.5px] font-medium leading-snug line-clamp-2 min-w-0" style={{ color: 'var(--color-text)' }} title={p.name}>
          {p.name}
        </span>
        <span className="shrink-0">
          <RankChip p={p} />
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1 text-[11px]">
        <span>{[p.association, p.division, p.state].filter(Boolean).join(' · ')}</span>
        {p.affiliation && <Chip tone="muted">{p.affiliation}</Chip>}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {p.fit_score != null && (
          <Chip tone={p.fit_score >= 4 ? 'accent' : 'neutral'} title="Fit, 1-5">
            fit {p.fit_score}
          </Chip>
        )}
        {p.signals?.platform && <Chip tone="muted">{p.signals.platform}</Chip>}
        {!hasContacts(p) && <Chip tone="warning">no contacts</Chip>}
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

/** A column with cards gets a real card width; an empty one collapses to a
 * rail (wider while a card is being dragged, so it's an easy target). */
export function columnWidthClass(count: number, dragging: boolean): string {
  if (count > 0) return 'flex-[1_1_18rem] min-w-[16rem]';
  return dragging ? 'flex-none w-[12rem]' : 'flex-none w-[6rem]';
}

function Column({
  stage,
  items,
  dragging,
  onDragging,
  onOpen,
  onDropProspect,
}: {
  stage: BoardStage;
  items: PipelineProspect[];
  dragging: boolean;
  onDragging: (on: boolean) => void;
  onOpen: (p: PipelineProspect) => void;
  onDropProspect: (id: number, stage: BoardStage) => void;
}) {
  const [over, setOver] = useState(false);
  const onDragOver = (e: DragEvent) => {
    if (!acceptsDrop(stage, e.dataTransfer.types)) return;
    e.preventDefault();
    setOver(true);
  };
  const onDrop = (e: DragEvent) => {
    setOver(false);
    onDragging(false);
    const id = Number(e.dataTransfer.getData(DRAG_TYPE));
    if (acceptsDrop(stage, e.dataTransfer.types) && id) onDropProspect(id, stage);
  };

  return (
    <section
      aria-label={STAGE_LABELS[stage]}
      data-rail={items.length === 0 ? 'true' : undefined}
      onDragOver={onDragOver}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={`flex flex-col gap-2 rounded-lg p-2 transition-[width] ${columnWidthClass(items.length, dragging)}`}
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
      <div className="flex flex-col gap-1.5 max-h-[max(60vh,calc(100vh-18rem))] overflow-y-auto">
        {boardOrder(items).map((p) => (
          <ProspectCard key={p.id} p={p} onOpen={() => onOpen(p)} onDragging={onDragging} />
        ))}
      </div>
    </section>
  );
}

/** Compact table of the same filtered prospects, in board (rank) order. */
function ProspectList({ items, onOpen }: { items: PipelineProspect[]; onOpen: (p: PipelineProspect) => void }) {
  if (!items.length) return <Quiet>No prospects match these filters.</Quiet>;
  const th = 'text-left font-medium px-2 py-1.5 whitespace-nowrap';
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px]" style={{ color: 'var(--color-text-secondary)' }}>
        <thead style={{ color: 'var(--color-text-tertiary)' }}>
          <tr>
            {['Rank', 'School', 'Affiliation', 'Platform', 'Fit', 'Stage', 'Days', 'Contacts'].map((h) => (
              <th key={h} className={th}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((p) => (
            <tr
              key={p.id}
              onClick={() => onOpen(p)}
              className="cursor-pointer"
              style={{ borderTop: '1px solid var(--color-border)' }}
            >
              <td className="px-2 py-1.5"><RankChip p={p} /></td>
              <td className="px-2 py-1.5" style={{ color: 'var(--color-text)' }}>{p.name}</td>
              <td className="px-2 py-1.5">{p.affiliation ?? ''}</td>
              <td className="px-2 py-1.5">{p.signals?.platform ?? ''}</td>
              <td className="px-2 py-1.5 tabular-nums">{p.fit_score ?? ''}</td>
              <td className="px-2 py-1.5 whitespace-nowrap">{STAGE_LABELS[p.stage] ?? p.stage}</td>
              <td className="px-2 py-1.5 tabular-nums">{p.days_in_stage != null ? num(p.days_in_stage) : ''}</td>
              <td className="px-2 py-1.5 tabular-nums">{(p.contacts ?? []).length}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type BoardView = 'board' | 'list';
const VIEWS: { value: BoardView; label: string }[] = [
  { value: 'board', label: 'Board' },
  { value: 'list', label: 'List' },
];

export function PipelineBoard({
  stages,
  suppressed,
  onOpen,
  onMove,
  loading,
  error,
  empty,
  speech,
}: {
  stages: Record<BoardStage, PipelineProspect[]>;
  suppressed: number;
  onOpen: (p: PipelineProspect) => void;
  onMove: (id: number, stage: BoardStage) => void;
  loading?: boolean;
  error?: string | null;
  empty: boolean;
  /** The block the speaker button plays: follow-ups due, else the latest research run. */
  speech?: { feed: SpeechFeed; block: SpeechBlock | null };
}) {
  const [filters, setFilters] = useState<BoardFilters>(NO_FILTERS);
  const [view, setView] = useState<BoardView>('board');
  const [dragging, setDragging] = useState(false);
  const all = useMemo(() => BOARD_STAGES.flatMap((s) => stages[s]), [stages]);
  const set = <K extends keyof BoardFilters>(k: K) => (v: BoardFilters[K]) => setFilters((f) => ({ ...f, [k]: v }));
  const opts = (vals: string[]) => [{ value: '', label: 'All' }, ...vals.map((v) => ({ value: v, label: v }))];
  const filtered = all.filter((p) => matches(p, filters));
  const shown = filtered.length;

  return (
    <DashboardPanel
      icon={KanbanSquare}
      title="Pipeline"
      tag={empty ? undefined : `${shown} shown · ${num(suppressed)} suppressed`}
      size="full"
      priority
      loading={loading}
      error={error}
      actions={speech ? <SpeakButton feed={speech.feed} block={speech.block} /> : undefined}
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
            <div className="ml-auto">
              <Segmented ariaLabel="Pipeline view" value={view} onChange={setView} options={VIEWS} />
            </div>
          </div>
          {view === 'list' ? (
            <ProspectList items={listOrder(filtered)} onOpen={onOpen} />
          ) : (
            <div className="flex gap-2 overflow-x-auto pb-1">
              {BOARD_STAGES.map((stage) => (
                <Column
                  key={stage}
                  stage={stage}
                  items={stages[stage].filter((p) => matches(p, filters))}
                  dragging={dragging}
                  onDragging={setDragging}
                  onOpen={onOpen}
                  onDropProspect={onMove}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </DashboardPanel>
  );
}
