import { Pause, Play, RefreshCw, Newspaper } from 'lucide-react';
import { useDailyBriefAudio } from '../lib/DailyBriefAudioContext';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

// Playback comes from the shared DailyBriefAudioContext (one real <audio>
// element, owned at the Layout level) rather than this page's own fetch +
// AudioPlayer instance -- the sidebar's pinned player is always mounted
// alongside this page, and two independent players pointed at the same
// physical file caused a WebView2 media pipeline decode error on both.
export function BriefingPage() {
  const { digest, audioUrl, loading, error, regenerating, playing, regenerate, toggleAudio } =
    useDailyBriefAudio();
  const handleRegenerate = regenerate;

  return (
    <div className="flex-1 flex flex-col overflow-hidden px-6 py-10">
      <div className="max-w-3xl mx-auto w-full flex flex-col flex-1 overflow-y-auto">
        <header className="mb-6 shrink-0">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Newspaper size={18} style={{ color: 'var(--color-accent)' }} />
              <h1 className="text-lg font-semibold" style={{ color: 'var(--color-text)' }}>
                Briefing
              </h1>
            </div>
            <button
              onClick={handleRegenerate}
              disabled={regenerating}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer disabled:opacity-50"
              style={{
                background: 'var(--color-bg-secondary)',
                color: 'var(--color-text-secondary)',
                border: '1px solid var(--color-border)',
              }}
            >
              <RefreshCw size={12} className={regenerating ? 'animate-spin' : ''} />
              {regenerating ? 'Regenerating...' : 'Regenerate'}
            </button>
          </div>
          {digest && (
            <p className="text-sm mt-2" style={{ color: 'var(--color-text-secondary)' }}>
              {formatDate(digest.generated_at)}
              {digest.sources_used.length > 0 && ` · ${digest.sources_used.join(', ')}`}
            </p>
          )}
        </header>

        {loading ? (
          <div className="text-center py-12" style={{ color: 'var(--color-text-tertiary)' }}>
            Loading...
          </div>
        ) : error ? (
          <div className="text-center py-12" style={{ color: 'var(--color-error)' }}>
            {error}
          </div>
        ) : !digest ? (
          <div className="text-center py-12" style={{ color: 'var(--color-text-tertiary)' }}>
            No briefing for today yet. Generate one to get started.
          </div>
        ) : (
          <>
            {audioUrl && (
              <div
                className="flex items-center gap-3 px-4 py-3 rounded-xl mb-3"
                style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
              >
                <button
                  onClick={toggleAudio}
                  className="flex items-center justify-center w-9 h-9 rounded-full transition-colors shrink-0 cursor-pointer"
                  style={{ background: 'var(--color-accent)', color: 'var(--color-on-accent)' }}
                >
                  {playing ? <Pause size={16} /> : <Play size={16} className="ml-0.5" />}
                </button>
                <span className="text-sm font-medium" style={{ color: 'var(--color-text-secondary)' }}>
                  {playing ? 'Playing Daily Brief' : 'Play Daily Brief'}
                </span>
              </div>
            )}

            <div
              className="rounded-xl p-4 text-sm leading-relaxed whitespace-pre-wrap"
              style={{
                background: 'var(--color-surface)',
                border: '1px solid var(--color-border)',
                color: 'var(--color-text)',
              }}
            >
              {digest.text}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
