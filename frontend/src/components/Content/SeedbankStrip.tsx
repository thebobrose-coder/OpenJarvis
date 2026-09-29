import { Sprout } from 'lucide-react';
import type { ContentSeedbank, Lane, SeedbankProperty } from '../../lib/content-api';
import { DashboardPanel } from '../Dashboard/DashboardPanel';
import { num } from '../shared/format';
import { Chip, Quiet, type Tone } from '../shared/ui';
import { laneLabel, matchesProperty } from './format';

export const LANE_STATUS: Record<string, { label: string; tone: Tone }> = {
  ok: { label: 'ok', tone: 'success' },
  low: { label: 'low', tone: 'warning' },
  empty: { label: 'empty', tone: 'error' },
  unknown: { label: 'unknown', tone: 'muted' },
  feed: { label: 'feed', tone: 'neutral' },
  'operator-only': { label: 'yours', tone: 'accent' },
  'not-seedable': { label: 'not seedable', tone: 'muted' },
};

/** The lane's one-line explanation, for the statuses that aren't counts. */
function laneNote(lane: Lane): string | null {
  if (lane.status === 'operator-only') return 'Yours: Hermes offers prompts only';
  if (lane.status === 'feed') return 'Automatic (RSS)';
  if (lane.status === 'unknown') return 'Waiting for Foundry’s snapshot';
  if (lane.status === 'not-seedable') return 'Not seeded by Hermes';
  return null;
}

const count = (n: number | null | undefined) => (n == null ? 'unknown' : num(n));

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span>
      <span style={{ color: 'var(--color-text-tertiary)' }}>{label} </span>
      <span className="tabular-nums" style={{ color: 'var(--color-text)' }}>
        {value}
      </span>
    </span>
  );
}

function LaneCard({ lane }: { lane: Lane }) {
  const status = LANE_STATUS[lane.status] ?? { label: lane.status, tone: 'neutral' as Tone };
  const note = laneNote(lane);
  return (
    <div
      className="flex flex-col gap-1.5 rounded-lg p-2.5 min-w-0"
      style={{ background: 'var(--color-bg-secondary)', borderLeft: `3px solid var(--color-${toneVar(status.tone)})` }}
      data-status={lane.status}
    >
      <div className="flex items-center justify-between gap-1.5">
        <span className="text-[12.5px] font-semibold truncate" style={{ color: 'var(--color-text)' }}>
          {laneLabel(lane.lane)}
        </span>
        <Chip tone={status.tone}>{status.label}</Chip>
      </div>
      <span className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
        {lane.content_type} · {lane.cadence_per_week == null ? '—' : `${num(lane.cadence_per_week, 1)}/week`}
      </span>
      {note ? (
        <span className="text-[11.5px]">{note}</span>
      ) : null}
      {lane.status !== 'feed' && (
        <div className="flex flex-wrap gap-x-2.5 gap-y-0.5 text-[11px]">
          <Stat label="Queued" value={count(lane.queued)} />
          <Stat label="In flight" value={count(lane.in_flight)} />
          <Stat label="Pending" value={count(lane.pending)} />
          <Stat label="Runway" value={lane.runway_days == null ? 'unknown' : `${num(lane.runway_days, 1)} d`} />
        </div>
      )}
    </div>
  );
}

/** Border colour for a tone; neutral and muted share the border token. */
function toneVar(tone: Tone): string {
  return tone === 'neutral' || tone === 'muted' ? 'border' : tone;
}

function PropertyRow({ property, showName }: { property: SeedbankProperty; showName: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      {showName && (
        <div className="flex items-center gap-2 text-[11px]">
          <span className="font-semibold uppercase tracking-wide" style={{ color: 'var(--color-text-secondary)' }}>
            {property.id}
          </span>
          {property.channels?.length ? <span style={{ color: 'var(--color-text-tertiary)' }}>{property.channels.join(' · ')}</span> : null}
        </div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
        {property.lanes.map((lane) => (
          <LaneCard key={lane.lane} lane={lane} />
        ))}
      </div>
    </div>
  );
}

export function SeedbankStrip({
  seedbank,
  selectedProperty,
  loading,
  error,
}: {
  seedbank: ContentSeedbank | null;
  selectedProperty: string;
  loading?: boolean;
  error?: string | null;
}) {
  const properties = (seedbank?.properties ?? []).filter((p) => matchesProperty(selectedProperty, p.id));
  return (
    <DashboardPanel
      icon={Sprout}
      title="Seedbank"
      tag={seedbank ? `Target ${num(seedbank.target_runway_days)}-day runway` : undefined}
      size="full"
      loading={loading}
      error={error}
    >
      {!seedbank ? (
        <Quiet>No seedbank yet -- Hermes writes it daily and after every decision.</Quiet>
      ) : properties.length === 0 ? (
        <Quiet>No lanes for this property.</Quiet>
      ) : (
        <div className="flex flex-col gap-4">
          {properties.map((p) => (
            <PropertyRow key={p.id} property={p} showName={properties.length > 1} />
          ))}
        </div>
      )}
    </DashboardPanel>
  );
}
