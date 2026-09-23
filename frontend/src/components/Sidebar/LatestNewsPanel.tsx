import { useEffect } from 'react';
import { Pause, Play } from 'lucide-react';
import { isTauri } from '../../lib/api';
import { useBreakingNews } from '../../hooks/useBreakingNews';
import { useDailyBriefAudio } from '../../lib/DailyBriefAudioContext';
import { listConnectors } from '../../lib/connectors-api';
import { useAppStore } from '../../lib/store';

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
 * open. Breaking news up top (from the breaking_news_monitor operator --
 * NOT the Culture & Sports digest, a separate 15-minute-interval operator
 * with a deliberately high alert bar; most cycles produce nothing, so this
 * renders "No current breaking news" rather than substituting something
 * else), the flagship Daily Brief player beneath it as a persistent
 * anchor, connector status underneath.
 */
export function LatestNewsPanel() {
  const breaking = useBreakingNews();
  const brief = useDailyBriefAudio();
  const cachedConnectors = useAppStore((s) => s.cachedConnectors);
  const setCachedConnectors = useAppStore((s) => s.setCachedConnectors);

  useEffect(() => {
    if (cachedConnectors) return;
    listConnectors()
      .then((list) =>
        setCachedConnectors(
          list.map((c) => ({
            connector_id: c.connector_id,
            display_name: c.display_name,
            connected: c.connected,
            chunks: c.chunks ?? 0,
            auth_type: c.auth_type,
          })),
        ),
      )
      .catch(() => {
        // Sidebar status dots are a nice-to-have -- a failed fetch just
        // leaves the row empty, not an error state worth surfacing.
      });
  }, [cachedConnectors, setCachedConnectors]);

  if (!brief.digest?.text && !cachedConnectors?.length) return null;

  return (
    <div
      className="mx-3 mb-2 flex flex-col gap-2 px-3 py-2 rounded-lg"
      style={{ background: 'var(--color-bg-secondary)', border: '1px solid var(--color-border)' }}
    >
      <div className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--color-text-tertiary)' }}>
        Latest News
      </div>

      <div className="flex items-start gap-2">
        {breaking.alert && breaking.audioUrl && (
          <button
            onClick={breaking.toggleAudio}
            className="flex items-center justify-center w-5 h-5 rounded-full shrink-0 cursor-pointer mt-0.5"
            style={{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text-secondary)' }}
            title={breaking.playing ? 'Pause breaking news summary' : 'Play breaking news summary'}
          >
            {breaking.playing ? <Pause size={10} /> : <Play size={10} />}
          </button>
        )}
        <div className="min-w-0 flex-1">
          <div
            className="text-[9px] font-semibold uppercase tracking-wide mb-0.5"
            style={{ color: breaking.alert ? 'var(--color-accent)' : 'var(--color-text-tertiary)' }}
          >
            Breaking
          </div>
          {breaking.alert ? (
            <button
              onClick={() => openExternal(breaking.alert!.url)}
              className="text-left text-xs cursor-pointer hover:underline"
              style={{ background: 'transparent', border: 'none', padding: 0, color: 'var(--color-text)' }}
              title="Open source"
            >
              {breaking.alert.headline}
            </button>
          ) : (
            <span className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
              No current breaking news
            </span>
          )}
        </div>
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

      <div className="flex items-center gap-2 pt-2" style={{ borderTop: '1px solid var(--color-border)' }}>
        {brief.audioUrl && (
          <button
            onClick={brief.toggleAudio}
            className="flex items-center justify-center w-6 h-6 rounded-full shrink-0 cursor-pointer"
            style={{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text-secondary)' }}
            title={brief.playing ? 'Pause' : 'Play Daily Brief'}
          >
            {brief.playing ? <Pause size={11} /> : <Play size={11} />}
          </button>
        )}
        <span className="text-xs truncate" style={{ color: 'var(--color-text-secondary)' }}>
          Latest Daily Brief
        </span>
      </div>

      {cachedConnectors && cachedConnectors.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap pt-1">
          {cachedConnectors.slice(0, 10).map((c) => (
            <span
              key={c.connector_id}
              className="w-1.5 h-1.5 rounded-full shrink-0"
              style={{ background: c.connected ? 'var(--color-success)' : 'var(--color-text-tertiary)' }}
              title={`${c.display_name}: ${c.connected ? 'connected' : 'not connected'}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}
