import { useCallback, useEffect, useState } from 'react';
import { Check, Headphones, Loader2, Pause, Play } from 'lucide-react';
import { DashboardPanel } from './DashboardPanel';
import { useVoicePlayer, type PlayRequest } from '../../lib/VoicePlayer';
import { SOURCE_LABELS, fetchVoiceQueue, laneBadge, type VoiceQueue, type VoiceQueueItem } from '../../lib/voice-api';
import { Chip, Quiet, SmallButton } from '../shared/ui';

const REFRESH_MS = 60_000;

const asRequest = (i: VoiceQueueItem): PlayRequest => ({ feed: 'voice_queue', id: i.id, title: i.title });

export function ListenRow({ item }: { item: VoiceQueueItem }) {
  const { current, playing, preparing, played, toggle } = useVoicePlayer();
  const active = current === item.id && playing;
  const busy = preparing === item.id;
  const badge = laneBadge(item.audio);
  const done = played.has(item.id);
  return (
    <li
      className="flex items-center gap-2.5 py-1.5"
      style={{ borderTop: '1px solid var(--color-border)', opacity: done && !active ? 0.65 : 1 }}
    >
      <button
        type="button"
        onClick={() => toggle(asRequest(item))}
        disabled={busy}
        aria-label={active ? `Pause ${item.title}` : `Play ${item.title}`}
        className="flex items-center justify-center w-7 h-7 rounded-full shrink-0 cursor-pointer disabled:opacity-60"
        style={{ background: 'var(--color-bg-secondary)', color: active ? 'var(--color-accent)' : 'var(--color-text)', border: 'none' }}
      >
        {busy ? <Loader2 size={12} className="animate-spin" /> : active ? <Pause size={12} /> : <Play size={12} />}
      </button>
      <div className="flex flex-col min-w-0 flex-1">
        <span className="truncate text-[12.5px]" style={{ color: 'var(--color-text)' }}>
          {item.title}
        </span>
        <span className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
          {[SOURCE_LABELS[item.source_feed] ?? item.source_feed, item.mood, item.duration ? `${Math.round(item.duration)} s` : null]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </div>
      {done && <Check size={12} aria-label="Played" style={{ color: 'var(--color-text-tertiary)' }} />}
      {badge ? (
        <Chip tone={item.audio === 'expressive' ? 'accent' : 'muted'} title={item.audio === 'expressive' ? 'The Erebus voice' : 'Fast lane (Kokoro); upgrades when the Erebus render lands'}>
          {badge}
        </Chip>
      ) : (
        <Chip tone="neutral" title="Not rendered yet; playing it makes a fast-lane render now">
          queued
        </Chip>
      )}
    </li>
  );
}

export function ListenList({ queue }: { queue: VoiceQueue }) {
  const { playAll, stop, playing } = useVoicePlayer();
  if (!queue.items.length) return <Quiet>Nothing to listen to right now.</Quiet>;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
          {queue.items.length} item{queue.items.length === 1 ? '' : 's'}
          {queue.worker ? '' : ' · voice worker offline'}
        </span>
        {playing ? (
          <SmallButton onClick={stop}>Stop</SmallButton>
        ) : (
          <SmallButton onClick={() => playAll(queue.items.map(asRequest))}>Play all</SmallButton>
        )}
      </div>
      <ul className="flex flex-col">
        {queue.items.map((item) => (
          <ListenRow key={item.id} item={item} />
        ))}
      </ul>
    </div>
  );
}

/** The morning playlist: Hermes's voice_queue in order. Nothing auto-plays. */
export function ListenPanel({ initial }: { initial?: VoiceQueue }) {
  const [queue, setQueue] = useState<VoiceQueue | null>(initial ?? null);
  const [loading, setLoading] = useState(!initial);
  const [error, setError] = useState<string | null>(null);
  const { error: playError } = useVoicePlayer();

  const load = useCallback(async () => {
    try {
      setQueue(await fetchVoiceQueue());
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (initial) return;
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [initial, load]);

  return (
    <DashboardPanel icon={Headphones} title="Listen" tag="Erebus" size="full" loading={loading} error={error}>
      {queue && <ListenList queue={queue} />}
      {playError && (
        <p className="mt-2 text-[11px]" style={{ color: 'var(--color-warning)' }}>
          {playError}
        </p>
      )}
    </DashboardPanel>
  );
}
