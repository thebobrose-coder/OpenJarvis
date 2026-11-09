import { Pause, Play } from 'lucide-react';
import { isTauri } from '../../lib/api';
import { selectBreaking } from '../../lib/breaking-list';
import { useBreakingNews } from '../../hooks/useBreakingNews';
import { BreakingListView } from './BreakingListView';
import { useDailyBriefAudio } from '../../lib/DailyBriefAudioContext';

async function openExternal(url: string) {
  if (!url) return;
  if (isTauri()) {
    const { open } = await import('@tauri-apps/plugin-shell');
    await open(url);
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

/**
 * "Latest News" dock -- sits at the bottom of the sidebar's content well,
 * just above the nav menu, always visible regardless of which page is
 * open. Breaking news up top (Hermes's alert feed since 2026-09-25, proxied
 * by /api/breaking-news -- NOT the Culture & Sports digest; alerts have a
 * deliberately high bar and most cycles produce nothing, so this
 * renders "No current breaking news" rather than substituting something
 * else), with the flagship Daily Brief's play button beside the dock title.
 * The connector dots and the brief's text row moved to the Ops page and the
 * Dashboard (widescreen plan 5.5).
 *
 * Since contract v1.7 the breaking section lists the last 24 h (at most 3
 * rows, headlines clamped to two lines so the nav menu keeps its room): the
 * newest alert with its player and tickers, then up to two more (hidden on
 * short windows). The dock may shrink and scroll (min-h-0) so it never
 * pushes the nav menu below the window, down to the 600 px minimum.
 */
export function LatestNewsPanel() {
  const breaking = useBreakingNews();
  const brief = useDailyBriefAudio();
  const rows = selectBreaking(breaking.alert, breaking.recent, breaking.now);
  if (!brief.audioUrl && rows.length === 0) return null;

  return (
    <div
      className="mx-3 mb-2 flex flex-col gap-2 px-3 py-2 rounded-lg min-h-0 overflow-y-auto"
      style={{ background: 'var(--color-bg-secondary)', border: '1px solid var(--color-border)' }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-ui-10 uppercase tracking-wide" style={{ color: 'var(--color-text-tertiary)' }}>
          Latest News
        </span>
        {brief.audioUrl && (
          <button
            onClick={brief.toggleAudio}
            className="flex items-center justify-center w-6 h-6 rounded-full shrink-0 cursor-pointer"
            style={{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text-secondary)', border: 'none' }}
            title={brief.playing ? 'Pause the Daily Brief' : 'Play the Daily Brief'}
            aria-label={brief.playing ? 'Pause the Daily Brief' : 'Play the Daily Brief'}
            data-brief-play
          >
            {brief.playing ? <Pause size={11} /> : <Play size={11} />}
          </button>
        )}
      </div>

      <BreakingListView
        rows={rows}
        latestAt={breaking.alert?.alerted_at ?? null}
        canPlay={!!breaking.audioUrl}
        playing={breaking.playing}
        stale={!!breaking.alert?.stale || breaking.recentStale}
        now={breaking.now}
        onToggle={breaking.toggleAudio}
        onOpen={openExternal}
      />
      {breaking.alert?.audio_available && (
        <audio
          ref={breaking.audioRef}
          src={breaking.audioUrl ?? undefined}
          onEnded={() => breaking.setPlaying(false)}
          onPause={() => breaking.setPlaying(false)}
          style={{ display: 'none' }}
        />
      )}

    </div>
  );
}
