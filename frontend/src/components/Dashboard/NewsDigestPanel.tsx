import { useCallback, useEffect, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import { Pause, Play } from 'lucide-react';
import {
  fetchDigest,
  regenerateDigest,
  resolveDigestAudioSrc,
} from '../../lib/api';
import type { Digest } from '../../lib/api';
import { DashboardPanel } from './DashboardPanel';

interface NewsDigestPanelProps {
  icon: ComponentType<{ size?: number; style?: React.CSSProperties }>;
  title: string;
  tag: string;
  /** e.g. "/api/digest/soccer" -- matches create_digest_router's prefix. */
  prefix: string;
}

/**
 * Narration-only briefing panel -- shared shape for soccer/motorsport/
 * entertainment: the latest cached digest text plus a regen button and an
 * inline audio play control, mirroring the original Briefing page's
 * construct at panel scale. No live graphical data (unlike Weather/Day
 * Ahead) -- these categories are general RSS coverage, not structured feeds.
 */
export function NewsDigestPanel({ icon, title, tag, prefix }: NewsDigestPanelProps) {
  const [digest, setDigest] = useState<Digest | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await fetchDigest(prefix);
      setDigest(d);
      setAudioUrl(d ? await resolveDigestAudioSrc(d, prefix).catch(() => null) : null);
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load.');
    } finally {
      setLoading(false);
    }
  }, [prefix]);

  useEffect(() => {
    load();
  }, [load]);

  const handleRegenerate = async () => {
    setRegenerating(true);
    try {
      await regenerateDigest(prefix);
      await load();
    } catch (e: any) {
      setError(e?.message ?? 'Failed to regenerate.');
    } finally {
      setRegenerating(false);
    }
  };

  const toggleAudio = () => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) {
      el.pause();
      setPlaying(false);
    } else {
      el.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    }
  };

  return (
    <DashboardPanel
      icon={icon}
      title={title}
      tag={tag}
      size="third"
      loading={loading}
      error={error}
      onRegenerate={handleRegenerate}
      regenerating={regenerating}
    >
      {!digest?.text ? (
        <p style={{ color: 'var(--color-text-tertiary)' }}>No briefing yet -- regenerate to get started.</p>
      ) : (
        <div className="flex items-start gap-2">
          {audioUrl && (
            <button
              onClick={toggleAudio}
              className="flex items-center justify-center w-5 h-5 rounded-full shrink-0 cursor-pointer mt-0.5"
              style={{ background: 'var(--color-bg-secondary)', color: 'var(--color-text-secondary)' }}
              title={playing ? 'Pause' : 'Play narration'}
            >
              {playing ? <Pause size={10} /> : <Play size={10} />}
            </button>
          )}
          <p className="whitespace-pre-wrap">{digest.text}</p>
          {audioUrl && (
            <audio
              ref={audioRef}
              src={audioUrl}
              onEnded={() => setPlaying(false)}
              onPause={() => setPlaying(false)}
              style={{ display: 'none' }}
            />
          )}
        </div>
      )}
    </DashboardPanel>
  );
}
