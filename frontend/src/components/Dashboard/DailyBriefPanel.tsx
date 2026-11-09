import { ArrowRight, Newspaper, Pause, Play } from 'lucide-react';
import { Link } from 'react-router';
import { useDailyBriefAudio } from '../../lib/DailyBriefAudioContext';
import { DashboardPanel } from './DashboardPanel';
import { DAILY_LATE_AFTER_S } from './FeedFreshness';
import { FeedAge } from './FeedAge';

/**
 * Flagship general/market digest, brought onto the dashboard from the
 * standalone Briefing page -- player, current brief, regenerate. No
 * archive/history list (judged not useful at a glance; still browsable
 * via the standalone /briefing page if ever needed).
 *
 * Playback comes from the shared DailyBriefAudioContext (one real <audio>
 * element, owned at the Layout level) rather than its own AudioPlayer
 * instance -- this panel and the sidebar's pinned player are both mounted
 * whenever the Dashboard is open, and two independent players pointed at
 * the same physical file caused a WebView2 media pipeline decode error on
 * both. Simple inline control here instead of the richer seek-bar
 * AudioPlayer, matching the pattern already used by every other digest
 * panel (Culture & Sports, the sidebar dock).
 */
/** The digest text with its play control (widescreen plan, Phase 1: the Briefings
 * hub mounts this body under its Daily Brief tab). */
export function DailyBriefBody({
  digest,
  audioUrl,
  playing,
  toggleAudio,
}: Pick<ReturnType<typeof useDailyBriefAudio>, 'digest' | 'audioUrl' | 'playing' | 'toggleAudio'>) {
  if (!digest?.text) {
    return <p style={{ color: 'var(--color-text-tertiary)' }}>No briefing for today yet. Regenerate to get started.</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      <FeedAge label="Daily Brief" ageSeconds={digest.age_seconds} stale={digest.stale} staleAfterSeconds={DAILY_LATE_AFTER_S} />
      <div className="flex items-start gap-2">
        {audioUrl && (
          <button
            onClick={toggleAudio}
            className="flex items-center justify-center w-5 h-5 rounded-full shrink-0 cursor-pointer mt-0.5"
            style={{ background: 'var(--color-bg-secondary)', color: 'var(--color-text-secondary)' }}
            title={playing ? 'Pause' : 'Play Daily Brief'}
          >
            {playing ? <Pause size={10} /> : <Play size={10} />}
          </button>
        )}
        <p className="whitespace-pre-wrap flex-1">{digest.text}</p>
      </div>
      {(digest.auto_fixes?.length ?? 0) > 0 && (
        // Auto-applied fixes, with Revert, live on the Briefing page only (plan 5.5).
        <Link to="/briefing" className="inline-flex items-center gap-1 text-ui-11-5 hover:underline" style={{ color: 'var(--color-accent)' }} data-auto-fixes-link>
          {digest.auto_fixes!.length} fix{digest.auto_fixes!.length === 1 ? '' : 'es'} applied overnight: review or revert on the Briefing page <ArrowRight size={11} />
        </Link>
      )}
    </div>
  );
}

export function DailyBriefPanel() {
  const { digest, audioUrl, loading, error, regenerating, playing, regenerate, toggleAudio } =
    useDailyBriefAudio();

  return (
    <DashboardPanel
      icon={Newspaper}
      title="Daily Brief"
      tag="Flagship"
      size="half"
      priority
      loading={loading}
      error={error}
      onRegenerate={regenerate}
      regenerating={regenerating}
    >
      <DailyBriefBody digest={digest} audioUrl={audioUrl} playing={playing} toggleAudio={toggleAudio} />
    </DashboardPanel>
  );
}
