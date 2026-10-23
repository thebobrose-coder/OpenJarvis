import { Play, Sprout, Telescope } from 'lucide-react';
import type { ContentProposals, ContentSeedbank } from '../../lib/content-api';
import { FeedFreshness } from '../Dashboard/FeedFreshness';
import { engineLabel, shortDateTime } from '../shared/format';
import { Chip, Segmented, SmallButton } from '../shared/ui';
import { ALL_PROPERTIES } from './format';

const DAY = 24 * 3600;

const shortTime = (ms: number | null) =>
  ms == null ? '' : new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export function ContentHeader({
  properties,
  selectedProperty,
  onSelectProperty,
  seedbank,
  proposals,
  researchStatus,
  researchAvailableAt,
  now,
  onResearch,
  onNewSeed,
  onRunIntake,
  intakeStatus = 'idle',
  intakeAvailableAt = null,
}: {
  properties: string[];
  selectedProperty: string;
  onSelectProperty: (id: string) => void;
  seedbank: ContentSeedbank | null;
  proposals: ContentProposals | null;
  researchStatus: 'idle' | 'queued' | 'error';
  /** Epoch ms when "Research more" unlocks again; null when it's available. */
  researchAvailableAt: number | null;
  now: number;
  onResearch: () => void;
  /** v1.16: open the seed composer empty. */
  onNewSeed?: () => void;
  /** v1.16: start Foundry's intake now instead of at :20. */
  onRunIntake?: () => void;
  intakeStatus?: 'idle' | 'running' | 'started' | 'ran_recently' | 'error';
  /** Epoch ms when "Run intake now" unlocks again (2-minute cooldown). */
  intakeAvailableAt?: number | null;
}) {
  const locked = researchAvailableAt != null && researchAvailableAt > now;
  const intakeLocked = intakeAvailableAt != null && intakeAvailableAt > now;
  const snapshot = seedbank?.snapshot;
  const bundle = seedbank?.bundle;
  const cost = proposals?.cost;

  return (
    <header className="flex flex-col gap-3 mb-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold" style={{ color: 'var(--color-text)' }}>
            Content
          </h1>
          <p className="text-sm mt-1" style={{ color: 'var(--color-text-secondary)' }}>
            Hermes proposes seed topics and measures what posted; you decide what reaches Foundry’s intake.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <div className="flex flex-wrap justify-end gap-1.5">
            {onNewSeed && (
              <SmallButton tone="accent" onClick={onNewSeed} title="Write your own seed for any property and lane">
                <Sprout size={11} /> New seed
              </SmallButton>
            )}
            {onRunIntake && (
              <SmallButton
                onClick={onRunIntake}
                disabled={intakeStatus === 'running' || intakeLocked}
                title="Run Foundry's proposal intake now instead of at :20 (at most once every 2 minutes)"
              >
                <Play size={11} /> Run intake now
              </SmallButton>
            )}
            <SmallButton
              onClick={onResearch}
              disabled={researchStatus === 'queued' || locked}
              title="One extra ideation run -- capped at 1 a day"
            >
              <Telescope size={11} /> Research more
            </SmallButton>
          </div>
          {onRunIntake && intakeStatus !== 'idle' && (
            <span className="text-[10.5px]" style={{ color: intakeStatus === 'error' ? 'var(--color-error)' : 'var(--color-text-tertiary)' }}>
              {intakeStatus === 'running'
                ? 'Starting the intake…'
                : intakeStatus === 'error'
                  ? 'Intake not started; try again later'
                  : `${intakeStatus === 'ran_recently' ? 'Intake ran under 2 minutes ago' : 'Intake started'}; results show after Hermes’s next sync${
                      intakeLocked ? ` (again from ${shortTime(intakeAvailableAt)})` : ''
                    }`}
            </span>
          )}
          <span className="text-[10.5px]" style={{ color: 'var(--color-text-tertiary)' }}>
            {researchStatus === 'queued'
              ? 'Queued -- new proposals appear within a few minutes'
              : locked
                ? `Used today; available again ${shortDateTime(new Date(researchAvailableAt).toISOString())}`
                : researchStatus === 'error'
                  ? 'Not queued; try again later'
                  : 'Capped at 1 extra run a day'}
          </span>
        </div>
      </div>

      {properties.length > 0 && (
        <Segmented
          ariaLabel="Property"
          value={selectedProperty}
          onChange={onSelectProperty}
          options={[{ value: ALL_PROPERTIES, label: 'All' }, ...properties.map((p) => ({ value: p, label: p }))]}
        />
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {snapshot?.present && snapshot.age_hours != null ? (
          <FeedFreshness label="Foundry snapshot" ageSeconds={snapshot.age_hours * 3600} staleAfterSeconds={26 * 3600} />
        ) : (
          seedbank && (
            <span className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
              Foundry snapshot · not received yet
            </span>
          )
        )}
        {bundle?.age_days != null && (
          <FeedFreshness
            label="Bundle"
            ageSeconds={bundle.age_days * DAY}
            stale={bundle.stale}
            staleTitle="Foundry’s brand bundle is older than Hermes expects -- proposals may miss recent changes."
          />
        )}
        {proposals && (
          <FeedFreshness label="Proposals" ageSeconds={proposals.age_seconds} stale={proposals.stale} staleAfterSeconds={26 * 3600} />
        )}
        {cost && (
          <span className="flex flex-wrap items-center gap-1 text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
            This month ${cost.month_usd.toFixed(2)}:
            {Object.entries(cost.by_engine).map(([engine, usd]) => (
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
