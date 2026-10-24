import { Clapperboard, Pause, Play, PlayCircle } from 'lucide-react';
import type { EpisodeSummary, StudioSpend, StudioStatus } from '../../lib/studio-api';
import { ago } from '../../lib/waiting-api';
import { DashboardPanel } from '../Dashboard/DashboardPanel';
import { Chip, Quiet, SmallButton } from '../shared/ui';
import { matchesProperty } from './format';
import { fmtMinutes, fmtUsd, stageInfo } from './episodes';

export type RunStatus = 'idle' | 'running' | 'started' | 'ran_recently' | 'error';

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <span>
      <span style={{ color: 'var(--color-text-tertiary)' }}>{label} </span>
      <span className="tabular-nums" style={{ color: warn ? 'var(--color-warning)' : 'var(--color-text)' }}>
        {value}
      </span>
    </span>
  );
}

function EpisodeRow({ ep, now, onOpen }: { ep: EpisodeSummary; now: number; onOpen: (id: string) => void }) {
  const stage = stageInfo(ep.stage);
  const atG0 = ep.stage === 'awaiting-g0';
  return (
    <li id={`episode-${ep.episodeId}`} className="flex flex-wrap items-center gap-1.5 rounded-md px-2 py-1.5 scroll-mt-4" style={{ background: 'var(--color-surface)' }}>
      <Chip tone={stage.tone}>{stage.label}</Chip>
      <span className="flex-1 min-w-[10rem] truncate" style={{ color: 'var(--color-text)' }} title={ep.topic ?? undefined}>
        {ep.title || ep.topic || ep.episodeId}
      </span>
      {ep.episodeClass && <Chip tone="muted">{ep.episodeClass}</Chip>}
      {ep.g0Pending && (
        <Chip tone="accent" title="The studio applies your decision on its next run">
          decision sent
        </Chip>
      )}
      {ep.youtubeVisibility && <Chip tone="muted">{ep.youtubeVisibility}</Chip>}
      <span className="text-[11px] tabular-nums" style={{ color: 'var(--color-text-tertiary)' }}>
        {ago(ep.since, now)}
      </span>
      <SmallButton tone={atG0 && !ep.g0Pending ? 'accent' : 'neutral'} onClick={() => onOpen(ep.episodeId)}>
        {atG0 && !ep.g0Pending ? 'Review G0' : 'Open'}
      </SmallButton>
      {ep.stoppedReason ? (
        <span className="basis-full text-[11px]" style={{ color: 'var(--color-error)' }}>
          {ep.stoppedReason}
        </span>
      ) : (
        ep.stageNote && (
          <span className="basis-full text-[11px]" style={{ color: /refused|fail|waiting|waits/i.test(ep.stageNote) ? 'var(--color-warning)' : 'var(--color-text-tertiary)' }}>
            {ep.stageNote}
          </span>
        )
      )}
    </li>
  );
}

/**
 * The studio's episode lane per channel (hq 0019 Part B): queued, in
 * production with a stage chip, published, the runway, and this month's
 * spend and GPU minutes against the caps, from `status.json`. Run studio now
 * and the per-channel pause are the only controls; there is no publish
 * button, because publishing is G1's approval.
 */
export function EpisodesPanel({
  status,
  episodes,
  selectedProperty,
  showProperty,
  loading,
  error,
  now,
  onOpen,
  onRun,
  runStatus = 'idle',
  runAvailableAt = null,
  runError = null,
  onPause,
  pausing = {},
}: {
  status: StudioStatus | null;
  episodes: EpisodeSummary[];
  selectedProperty: string;
  showProperty: boolean;
  loading: boolean;
  error: string | null;
  now: number;
  onOpen: (id: string) => void;
  onRun: () => void;
  runStatus?: RunStatus;
  runAvailableAt?: number | null;
  /** Why the last Run studio now failed, shown beside the button (e.g. the task isn't registered). */
  runError?: string | null;
  onPause: (propertyId: string, paused: boolean) => void;
  pausing?: Record<string, boolean>;
}) {
  if (!status && !loading && !error) return null; // no studio on this machine yet
  const lanes = (status?.lanes ?? []).filter((l) => matchesProperty(selectedProperty, l.propertyId));
  if (status && lanes.length === 0) return null;
  const coolingDown = runAvailableAt != null && runAvailableAt > now;
  const runLabel =
    runStatus === 'running' ? 'Starting…' : coolingDown ? `Ran ${runStatus === 'ran_recently' ? 'recently' : 'just now'}` : 'Run studio now';
  const last = status?.lastRun;

  return (
    <DashboardPanel
      icon={Clapperboard}
      title="Episodes"
      tag={status ? `studio ${ago(status.generatedAt, now)}` : undefined}
      size="full"
      loading={loading && !status}
      error={!status ? error : null}
      actions={
        <SmallButton
          onClick={onRun}
          disabled={runStatus === 'running' || coolingDown}
          title="Start the studio's task now (every 10 minutes otherwise): each run advances every episode in flight by one stage"
        >
          <PlayCircle size={11} /> {runLabel}
        </SmallButton>
      }
    >
      {status && (
        <div className="flex flex-col gap-3">
          {runError && runStatus === 'error' && (
            <p className="text-[11.5px]" role="alert" style={{ color: 'var(--color-error)' }}>
              Run studio now failed: {runError}
            </p>
          )}
          {(status.stale || last?.ok === false) && (
            <p className="text-[11.5px]" role="status" style={{ color: 'var(--color-warning)' }}>
              {last?.ok === false ? `The studio's last run failed${last.note ? `: ${last.note}` : ''}.` : 'The studio hasn’t written its status for over 30 minutes.'}
            </p>
          )}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {lanes.map((lane) => {
              const channel = status.channels[lane.propertyId];
              const spend = status.spend[lane.propertyId] as StudioSpend | undefined;
              const paused = !!status.paused[lane.propertyId];
              const rows = episodes.filter((e) => e.propertyId === lane.propertyId);
              const open = rows.filter((e) => !['published', 'rejected'].includes(e.stage));
              const done = rows.filter((e) => ['published', 'rejected'].includes(e.stage)).slice(0, 3);
              return (
                <section
                  key={lane.propertyId}
                  className="flex flex-col gap-2 rounded-lg p-3 min-w-0"
                  style={{ background: 'var(--color-bg-secondary)' }}
                  data-property={lane.propertyId}
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[13px] font-semibold" style={{ color: 'var(--color-text)' }}>
                      {channel?.channelName ?? lane.propertyId}
                    </span>
                    {(showProperty || channel?.channelName) && <Chip tone="accent">{lane.propertyId}</Chip>}
                    {paused && <Chip tone="warning">paused</Chip>}
                    <span className="flex-1" />
                    <SmallButton
                      onClick={() => onPause(lane.propertyId, !paused)}
                      disabled={!!pausing[lane.propertyId]}
                      title={paused ? 'Let this channel’s episodes advance again' : 'Hold this channel’s episodes where they are'}
                    >
                      {paused ? <Play size={11} /> : <Pause size={11} />} {paused ? 'Resume' : 'Pause'}
                    </SmallButton>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11.5px]">
                    <Stat label="queued" value={String(lane.queued)} />
                    <Stat label="in production" value={String(lane.inProduction)} />
                    <Stat label="published 30 d" value={String(lane.published30d)} />
                    <Stat label="runway" value={`${lane.runwayDays} d`} warn={lane.runwayDays <= 0} />
                  </div>
                  {spend && (
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11.5px]">
                      <Stat label={`spend ${status.spend.month}`} value={`${fmtUsd(spend.usd)} / ${fmtUsd(spend.capUsd)}`} warn={spend.usd >= spend.capUsd} />
                      <Stat
                        label="GPU"
                        value={fmtMinutes(spend.gpuMinutes)}
                      />
                      {channel?.gpuMinutesCap != null && <Stat label="per-episode GPU cap" value={fmtMinutes(channel.gpuMinutesCap)} />}
                      {channel?.cloudCapUsdPerEpisode != null && <Stat label="per-episode cap" value={fmtUsd(channel.cloudCapUsdPerEpisode)} />}
                    </div>
                  )}
                  {open.length + done.length === 0 ? (
                    <Quiet>No episodes yet. Seed one on the episode lane.</Quiet>
                  ) : (
                    <ul className="flex flex-col gap-1">
                      {[...open, ...done].map((ep) => (
                        <EpisodeRow key={ep.episodeId} ep={ep} now={now} onOpen={onOpen} />
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
          {last && (
            <span className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
              Last run {ago(last.at, now)}, advanced {last.advanced}
              {last.note && last.ok ? ` · ${last.note}` : ''}
            </span>
          )}
        </div>
      )}
    </DashboardPanel>
  );
}
