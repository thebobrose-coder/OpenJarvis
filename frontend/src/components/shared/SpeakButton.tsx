import { Loader2, Pause, Volume2 } from 'lucide-react';
import { useVoicePlayer } from '../../lib/VoicePlayer';
import type { SpeechBlock, SpeechFeed } from '../../lib/voice-api';

/** Speaker icon for a panel header: plays the feed's current speech block
 * (the expressive render if it's ready, else a fast-lane render made now).
 * Renders nothing when the feed has no block. */
export function SpeakButton({ feed, block }: { feed: SpeechFeed; block: SpeechBlock | null }) {
  const { current, playing, preparing, toggle } = useVoicePlayer();
  if (!block) return null;
  const active = current === block.id && playing;
  const busy = preparing === block.id;
  const label = active ? `Pause: ${block.title}` : `Listen: ${block.title}`;
  return (
    <button
      type="button"
      onClick={() => toggle({ feed, id: block.id, title: block.title })}
      disabled={busy}
      aria-label={label}
      title={label}
      className="flex items-center justify-center w-6 h-6 rounded-md transition-colors cursor-pointer disabled:opacity-60"
      style={{
        color: active ? 'var(--color-accent)' : 'var(--color-text-secondary)',
        background: 'var(--color-bg-secondary)',
        border: 'none',
      }}
    >
      {busy ? <Loader2 size={11} className="animate-spin" /> : active ? <Pause size={11} /> : <Volume2 size={12} />}
    </button>
  );
}
