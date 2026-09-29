import { Telescope } from 'lucide-react';
import type { BdPipeline, BdProspects, StatsLine } from '../../lib/bizdev-api';
import { FeedFreshness } from '../Dashboard/FeedFreshness';
import { num } from '../shared/format';
import { Chip, Segmented, SmallButton } from '../shared/ui';

const WEEK = 7 * 24 * 3600;

/** Engine ids -> labels; the local model costs nothing. */
function engineLabel(engine: string, usd: number): string {
  if (engine.includes('qwen') || engine.endsWith('_local')) return `${engine.replace(/_local$/, '')}: free / local`;
  return `${engine}: $${usd.toFixed(2)}`;
}

export function BizDevHeader({
  lines,
  selectedLine,
  onSelectLine,
  pipeline,
  prospects,
  stats,
  researchStatus,
  onResearch,
}: {
  lines: { line: string; display_name: string }[];
  selectedLine: string;
  onSelectLine: (line: string) => void;
  pipeline: BdPipeline | null;
  prospects: BdProspects | null;
  stats: StatsLine | undefined;
  researchStatus: 'idle' | 'queued' | 'error';
  onResearch: () => void;
}) {
  return (
    <header className="flex flex-col gap-3 mb-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold" style={{ color: 'var(--color-text)' }}>
            Business Development
          </h1>
          <p className="text-sm mt-1" style={{ color: 'var(--color-text-secondary)' }}>
            Hermes researches and drafts; you review, send from your own mail, and record what happened.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <SmallButton
            onClick={onResearch}
            disabled={researchStatus === 'queued'}
            title="One extra research batch -- capped at 1 a week beyond the Monday run"
          >
            <Telescope size={11} /> Research more
          </SmallButton>
          <span className="text-[10.5px]" style={{ color: 'var(--color-text-tertiary)' }}>
            {researchStatus === 'queued'
              ? 'Queued -- the batch appears within a few minutes'
              : researchStatus === 'error'
                ? 'Not queued (this week’s extra batch may be used)'
                : '1 extra batch a week'}
          </span>
        </div>
      </div>

      {lines.length > 1 && (
        <Segmented
          ariaLabel="Business line"
          value={selectedLine}
          onChange={onSelectLine}
          options={lines.map((l) => ({ value: l.line, label: l.display_name }))}
        />
      )}
      {lines.length === 1 && (
        <div className="text-[12px] font-medium" style={{ color: 'var(--color-text-secondary)' }}>
          {lines[0].display_name}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {prospects && (
          <FeedFreshness label="This week’s batch" ageSeconds={prospects.age_seconds} stale={prospects.stale} staleAfterSeconds={8 * 24 * 3600} />
        )}
        {pipeline && <FeedFreshness label="Pipeline" ageSeconds={pipeline.age_seconds} stale={pipeline.stale} staleAfterSeconds={WEEK} />}
        {stats && (
          <span className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
            {num(stats.researched)} of {num(stats.universe)} researched ({num(stats.coverage_pct, 0)}%)
          </span>
        )}
        {stats && (
          <span className="flex flex-wrap items-center gap-1 text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
            This month ${stats.cost.month_usd.toFixed(2)}:
            {Object.entries(stats.cost.by_engine).map(([engine, usd]) => (
              <Chip key={engine} tone="muted">
                {engineLabel(engine, usd)}
              </Chip>
            ))}
          </span>
        )}
      </div>
    </header>
  );
}
