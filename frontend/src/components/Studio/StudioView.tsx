import { useState } from 'react';
import { Clapperboard, MonitorPlay, Pause, Play, PlayCircle } from 'lucide-react';
import type { EpisodeSummary, StudioSpend, StudioStatus } from '../../lib/studio-api';
import type { YouTubePerformance } from '../../lib/content-api';
import { ago } from '../../lib/waiting-api';
import { DashboardPanel } from '../Dashboard/DashboardPanel';
import { FeedFreshnessLine } from '../Dashboard/FeedFreshnessLine';
import { Chip, Quiet, Segmented, SmallButton } from '../shared/ui';
import { EpisodeRow, HeldSeeds, LaneQueue, Stat, type OpenEpisode, type RunStatus } from '../Content/EpisodesPanel';
import { ChannelCard } from '../Content/YouTubePanel';
import { ALL_PROPERTIES, matchesProperty } from '../Content/format';
import { fmtMinutes, fmtUsd, nextRunAt, untilRun } from '../Content/episodes';

/** The board's columns (widescreen plan 5.2): each episode stage falls into one. */
export const BOARD_COLUMNS: { key: string; label: string; stages: string[] }[] = [
  { key: 'g0', label: 'Awaiting G0', stages: ['awaiting-g0'] },
  { key: 'scripting', label: 'Scripting', stages: ['queued', 'scripting', 'scripted', 'rewrite-requested'] },
  { key: 'producing', label: 'Producing', stages: ['narrating', 'visualizing', 'assembling', 'scanning'] },
  { key: 'publishing', label: 'Publishing', stages: ['at-g1', 'publishing', 'submitted', 'upload-failed'] },
  { key: 'done', label: 'Done', stages: ['published', 'stopped', 'rejected'] },
];

/** The done column shows this many before "Show all". */
export const DONE_VISIBLE = 8;

export function columnOf(stage: string): string {
  return BOARD_COLUMNS.find((c) => c.stages.includes(stage))?.key ?? 'producing';
}

export interface StudioViewProps {
  status: StudioStatus | null;
  episodes: EpisodeSummary[];
  loading: boolean;
  error: string | null;
  now: number;
  selectedProperty: string;
  onSelectProperty: (id: string) => void;
  onOpen: OpenEpisode;
  onRun: () => void;
  runStatus?: RunStatus;
  runAvailableAt?: number | null;
  runError?: string | null;
  onPause: (propertyId: string, paused: boolean) => void;
  pausing?: Record<string, boolean>;
  /** youtube_performance (v1.29), read only: the channels' last 28 days. */
  youtube?: { feed: YouTubePerformance | null; loading?: boolean; error?: string | null };
  notice?: string | null;
  onClearNotice?: () => void;
}

/**
 * The Studio page (widescreen plan 5.2): the episode pipeline that lived as one panel
 * on Content. Header with Run studio now and the run clock; one card per channel lane
 * with its stats, spend, pause and queue; the episodes as a board by stage; the
 * channels' YouTube read beneath. Pure: everything comes in through props.
 */
export function StudioView(props: StudioViewProps) {
  const { status, episodes, now, selectedProperty: selected } = props;
  const lanes = (status?.lanes ?? []).filter((l) => matchesProperty(selected, l.propertyId));
  const properties = (status?.lanes ?? []).map((l) => l.propertyId);
  const rows = episodes.filter((e) => matchesProperty(selected, e.propertyId));
  const coolingDown = props.runAvailableAt != null && props.runAvailableAt > now;
  const runLabel =
    props.runStatus === 'running' ? 'Starting…' : coolingDown ? `Ran ${props.runStatus === 'ran_recently' ? 'recently' : 'just now'}` : 'Run studio now';
  const last = status?.lastRun;
  const next = nextRunAt(status);
  const [doneAll, setDoneAll] = useState(false);
  const channels = (props.youtube?.feed?.channels ?? []).filter((c) => matchesProperty(selected, c.property));
  const quota = props.youtube?.feed?.quota;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-ui-20 font-semibold" style={{ color: 'var(--color-text)' }}>
              Studio
            </h1>
            <p className="text-ui-12-5 mt-1" style={{ color: 'var(--color-text-secondary)' }}>
              Episodes by stage, each channel’s lane and spend, and the channels’ YouTube read. Publishing is G1’s approval.
            </p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <SmallButton
              tone="accent"
              onClick={props.onRun}
              disabled={props.runStatus === 'running' || coolingDown}
              title="Start the studio's task now (every 10 minutes otherwise): each run advances every episode in flight by one stage"
            >
              <PlayCircle size={11} /> {runLabel}
            </SmallButton>
            <span className="text-ui-10-5 tabular-nums" style={{ color: 'var(--color-text-tertiary)' }}>
              {last ? `Last run ${ago(last.at, now)}, advanced ${last.advanced}` : 'No run yet'}
              {next != null ? ` · next ${untilRun(next, now)}` : ''}
            </span>
            {props.runError && props.runStatus === 'error' && (
              <span className="text-ui-11" role="alert" style={{ color: 'var(--color-error)' }}>
                Run studio now failed: {props.runError}
              </span>
            )}
          </div>
        </div>
        {properties.length > 1 && (
          <Segmented
            ariaLabel="Channel"
            value={selected}
            onChange={props.onSelectProperty}
            options={[{ value: ALL_PROPERTIES, label: 'All' }, ...properties.map((p) => ({ value: p, label: p }))]}
          />
        )}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <FeedFreshnessLine
            feeds={[
              ...(status ? [{ label: 'Studio status', ageSeconds: status.age_seconds, stale: status.stale, staleAfterSeconds: 30 * 60 }] : []),
              ...(props.youtube?.feed ? [{ label: 'YouTube', ageSeconds: props.youtube.feed.age_seconds, stale: props.youtube.feed.stale, staleAfterSeconds: 26 * 3600 }] : []),
            ]}
          />
          {(status?.stale || last?.ok === false) && (
            <span className="text-ui-11-5" role="status" style={{ color: 'var(--color-warning)' }}>
              {last?.ok === false ? `The studio's last run failed${last.note ? `: ${last.note}` : ''}.` : 'The studio hasn’t written its status for over 30 minutes.'}
            </span>
          )}
        </div>
      </header>

      {props.notice && (
        <div className="flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-ui-12" style={{ border: '1px solid var(--color-warning)', color: 'var(--color-text-secondary)' }} role="status">
          <span>{props.notice}</span>
          {props.onClearNotice && (
            <button onClick={props.onClearNotice} aria-label="Dismiss" className="cursor-pointer" style={{ background: 'transparent', border: 'none', color: 'inherit' }}>
              ×
            </button>
          )}
        </div>
      )}

      {!status ? (
        <Quiet>{props.loading ? 'Loading the studio…' : props.error ?? 'No studio on this machine yet.'}</Quiet>
      ) : (
        <>
          <div className="grid grid-cols-12 gap-4" data-channels>
            {lanes.length === 0 ? (
              <div className="col-span-12">
                <Quiet>No channel lanes for this property.</Quiet>
              </div>
            ) : (
              lanes.map((lane) => {
                const channel = status.channels[lane.propertyId];
                const spend = status.spend[lane.propertyId] as StudioSpend | undefined;
                const paused = !!status.paused[lane.propertyId];
                return (
                  <DashboardPanel
                    key={lane.propertyId}
                    icon={Clapperboard}
                    title={channel?.channelName ?? lane.propertyId}
                    tag={paused ? 'paused' : undefined}
                    size="quarter"
                    band="short"
                    priority={lane.runwayDays <= 0}
                    actions={
                      <SmallButton
                        onClick={() => props.onPause(lane.propertyId, !paused)}
                        disabled={!!props.pausing?.[lane.propertyId]}
                        title={paused ? 'Let this channel’s episodes advance again' : 'Hold this channel’s episodes where they are'}
                      >
                        {paused ? <Play size={11} /> : <Pause size={11} />} {paused ? 'Resume' : 'Pause'}
                      </SmallButton>
                    }
                  >
                    <div className="flex flex-col gap-2" data-property={lane.propertyId}>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Chip tone="accent">{lane.propertyId}</Chip>
                        {paused && status.pauseReasons?.[lane.propertyId] && (
                          <span className="text-ui-11 truncate min-w-0" style={{ color: 'var(--color-warning)' }} title="The pause flag's first line" data-pause-reason>
                            {status.pauseReasons[lane.propertyId]}
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-ui-11-5">
                        <Stat label="queued" value={String(lane.queued)} />
                        <Stat label="in production" value={String(lane.inProduction)} />
                        <Stat label="published 30 d" value={String(lane.published30d)} />
                        <Stat label="runway" value={`${lane.runwayDays} d`} warn={lane.runwayDays <= 0} />
                      </div>
                      {spend && (
                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-ui-11-5">
                          <Stat label={`spend ${status.spend.month}`} value={`${fmtUsd(spend.usd)} / ${fmtUsd(spend.capUsd)}`} warn={spend.usd >= spend.capUsd} />
                          <Stat label="GPU" value={fmtMinutes(spend.gpuMinutes)} />
                          {channel?.cloudCapUsdPerEpisode != null && <Stat label="per episode" value={fmtUsd(channel.cloudCapUsdPerEpisode)} />}
                        </div>
                      )}
                      {(lane.queue ?? []).length > 0 && <LaneQueue queue={lane.queue ?? []} now={now} />}
                      {(lane.heldSeeds ?? []).length > 0 && <HeldSeeds seeds={lane.heldSeeds ?? []} onOpen={props.onOpen} />}
                    </div>
                  </DashboardPanel>
                );
              })
            )}
          </div>

          <div className="grid grid-cols-12 gap-4">
            <DashboardPanel icon={Clapperboard} title="Episodes" tag={`${rows.length}`} size="full" band="tall" priority>
              {rows.length === 0 ? (
                <Quiet>No episodes yet. Seed one on the episode lane.</Quiet>
              ) : (
                <div className="grid grid-cols-1 lg:grid-cols-5 gap-3" data-board>
                  {BOARD_COLUMNS.map((col) => {
                    const inCol = rows.filter((e) => columnOf(e.stage) === col.key);
                    const shown = col.key === 'done' && !doneAll ? inCol.slice(0, DONE_VISIBLE) : inCol;
                    return (
                      <section key={col.key} className="flex flex-col gap-1.5 min-w-0 rounded-lg p-2" style={{ background: 'var(--color-bg-secondary)' }} data-column={col.key}>
                        <h3 className="flex items-center justify-between text-ui-10-5 uppercase tracking-wide px-1" style={{ color: 'var(--color-text-tertiary)' }}>
                          <span>{col.label}</span>
                          <span data-count>{inCol.length}</span>
                        </h3>
                        {shown.length === 0 ? (
                          <Quiet>None.</Quiet>
                        ) : (
                          <ul className="flex flex-col gap-1">
                            {shown.map((ep) => (
                              <EpisodeRow key={ep.episodeId} ep={ep} now={now} onOpen={props.onOpen} />
                            ))}
                          </ul>
                        )}
                        {col.key === 'done' && inCol.length > DONE_VISIBLE && (
                          <div>
                            <SmallButton onClick={() => setDoneAll((a) => !a)} data-more>
                              {doneAll ? 'Show fewer' : `Show all ${inCol.length}`}
                            </SmallButton>
                          </div>
                        )}
                      </section>
                    );
                  })}
                </div>
              )}
            </DashboardPanel>
          </div>

          <div className="grid grid-cols-12 gap-4 mb-10" data-youtube>
            {!props.youtube?.feed ? (
              <DashboardPanel icon={MonitorPlay} title="YouTube, last 28 days" tag="read only" size="full" loading={props.youtube?.loading} error={props.youtube?.error}>
                <Quiet>No YouTube read yet.</Quiet>
              </DashboardPanel>
            ) : channels.length === 0 ? (
              <DashboardPanel icon={MonitorPlay} title="YouTube, last 28 days" tag="read only" size="full">
                <Quiet>No YouTube channel read for this property.</Quiet>
              </DashboardPanel>
            ) : (
              channels.map((c) => (
                <DashboardPanel key={c.property} icon={MonitorPlay} title={`YouTube · ${c.channel_title || c.property}`} tag="read only · 28 d" size="half" band="tall">
                  <ChannelCard ch={c} now={now} limit={10} />
                  {quota && (
                    <span className="block mt-2 text-ui-10-5 tabular-nums" style={{ color: quota.stopped ? 'var(--color-warning)' : 'var(--color-text-tertiary)' }} data-quota>
                      API quota today: {quota.used_today.toLocaleString()} / {quota.cap.toLocaleString()} units{quota.stopped ? ' (stopped for the rest of the Pacific day)' : ''}
                    </span>
                  )}
                </DashboardPanel>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
