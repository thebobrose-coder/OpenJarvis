import { useEffect, useState, useCallback } from 'react';
import { RefreshCw, Newspaper } from 'lucide-react';
import {
  fetchDigest,
  fetchDigestHistory,
  regenerateDigest,
  resolveDigestAudioSrc,
} from '../lib/api';
import type { Digest, DigestHistoryEntry } from '../lib/api';
import { AudioPlayer } from '../components/Chat/AudioPlayer';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function BriefingPage() {
  const [digest, setDigest] = useState<Digest | null>(null);
  const [history, setHistory] = useState<DigestHistoryEntry[]>([]);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [regenerating, setRegenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [d, h] = await Promise.all([fetchDigest(), fetchDigestHistory().catch(() => [])]);
      setDigest(d);
      setHistory(h);
      setAudioUrl(d ? await resolveDigestAudioSrc(d).catch(() => null) : null);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load the briefing.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleRegenerate = async () => {
    setRegenerating(true);
    setError(null);
    try {
      await regenerateDigest();
      await load();
    } catch (e: any) {
      setError(e?.message ?? 'Failed to regenerate the briefing.');
    } finally {
      setRegenerating(false);
    }
  };

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
            {audioUrl && <AudioPlayer src={audioUrl} />}

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

        {history.length > 0 && (
          <div className="mt-8 shrink-0">
            <h2 className="text-xs font-semibold uppercase tracking-wide mb-3" style={{ color: 'var(--color-text-tertiary)' }}>
              Past briefings
            </h2>
            <div className="flex flex-col gap-2">
              {history.map((entry, i) => (
                <div
                  key={i}
                  className="rounded-lg p-3 text-xs"
                  style={{ background: 'var(--color-bg-secondary)', border: '1px solid var(--color-border)' }}
                >
                  <div className="font-medium mb-1" style={{ color: 'var(--color-text-secondary)' }}>
                    {formatDate(entry.generated_at)}
                  </div>
                  <div style={{ color: 'var(--color-text-tertiary)' }}>{entry.text}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
