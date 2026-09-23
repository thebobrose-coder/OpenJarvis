import { useNavigate } from 'react-router';
import { Clapperboard, Flag, Goal, MessageSquare, Newspaper, Pause, Play } from 'lucide-react';
import { isTauri } from '../../lib/api';
import type { DigestArticle } from '../../lib/api';
import { useAppStore } from '../../lib/store';
import { useCultureAudio } from '../../lib/CultureAudioContext';
import { DashboardPanel } from './DashboardPanel';

const CATEGORY_ICON: Record<string, typeof Goal> = {
  soccer: Goal,
  motorsport: Flag,
  entertainment: Clapperboard,
};

function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffMs = Date.now() - then;
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

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
 * Consolidated cultural news panel -- replaces the three separate
 * soccer/motorsport/entertainment narration panels with one dense, linkable
 * list: the top 12 ranked articles (see agents/culture_scoring.py) plus a
 * short spoken summary of the list, not per-category narration.
 */
export function CultureNewsPanel() {
  const navigate = useNavigate();
  const setPendingChatPrompt = useAppStore((s) => s.setPendingChatPrompt);
  const { digest, audioUrl, loading, error, regenerating, playing, regenerate, toggleAudio } = useCultureAudio();

  const articles = (digest?.articles ?? []).slice(0, 12);

  const handleAsk = (article: DigestArticle) => {
    setPendingChatPrompt(`Tell me more about "${article.title}" (${article.url})`);
    navigate('/');
  };

  return (
    <DashboardPanel
      icon={Newspaper}
      title="Culture & Sports"
      tag="1 hr"
      size="half"
      loading={loading}
      error={error}
      onRegenerate={regenerate}
      regenerating={regenerating}
    >
      {!digest?.text && articles.length === 0 ? (
        <p style={{ color: 'var(--color-text-tertiary)' }}>No briefing yet -- regenerate to get started.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {digest?.text && (
            <div className="flex items-start gap-2 pb-2" style={{ borderBottom: '1px solid var(--color-border)' }}>
              {audioUrl && (
                <button
                  onClick={toggleAudio}
                  className="flex items-center justify-center w-5 h-5 rounded-full shrink-0 cursor-pointer mt-0.5"
                  style={{ background: 'var(--color-bg-secondary)', color: 'var(--color-text-secondary)' }}
                  title={playing ? 'Pause' : 'Play summary'}
                >
                  {playing ? <Pause size={10} /> : <Play size={10} />}
                </button>
              )}
              <p className="whitespace-pre-wrap">{digest.text}</p>
            </div>
          )}

          <ul className="flex flex-col gap-2">
            {articles.map((article, i) => {
              const Icon = CATEGORY_ICON[article.category] ?? Newspaper;
              return (
                <li key={`${article.url}-${i}`} className="flex items-start gap-2">
                  <Icon size={13} style={{ color: 'var(--color-accent)', flexShrink: 0, marginTop: 2 }} />
                  <div className="min-w-0 flex-1">
                    <button
                      onClick={() => openExternal(article.url)}
                      className="text-left cursor-pointer hover:underline"
                      style={{ background: 'transparent', border: 'none', padding: 0, color: 'var(--color-text)' }}
                      title="Open article"
                    >
                      {article.title}
                    </button>
                    <div className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
                      {article.source}
                      {article.published_at ? ` · ${formatRelativeTime(article.published_at)}` : ''}
                    </div>
                  </div>
                  <button
                    onClick={() => handleAsk(article)}
                    className="flex items-center justify-center w-5 h-5 rounded-md shrink-0 cursor-pointer"
                    style={{ background: 'var(--color-bg-secondary)', color: 'var(--color-text-secondary)' }}
                    title="Ask about this in chat"
                  >
                    <MessageSquare size={11} />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </DashboardPanel>
  );
}
