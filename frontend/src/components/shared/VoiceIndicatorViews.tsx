import { Mic, MicOff, X } from 'lucide-react';
import { Orb, type OrbMood } from './Orb';
import type { VoiceState, VoiceStateName, VoiceTurn } from '../../lib/voice-api';

export const LABELS: Record<VoiceStateName, string> = {
  idle: 'Voice: idle',
  listening: 'Listening',
  transcribing: 'Transcribing',
  thinking: 'Thinking',
  speaking: 'Speaking',
  muted: 'Mic muted',
};

export const ACTIVE = new Set<VoiceStateName>(['listening', 'transcribing', 'thinking', 'speaking']);

export const OFFLINE_TITLE = 'Voice worker not running';

/** The orb's mood. A voice state above idle always wins; then a streaming
 * chat turn (thinking); then a render holding the GPU lease. */
export function orbMood(state: VoiceState | null, streaming = false): OrbMood {
  if (!state) return 'offline';
  if (state.state !== 'idle') return state.state;
  if (streaming) return 'thinking';
  if (state.lease_held) return 'rendering';
  return 'idle';
}

/** The header's voice indicator: the orb (state at a glance; click to start
 * or end a conversation), a mute toggle, and a button that opens the drawer.
 * Without a worker, a dim orb and nothing else. */
export function VoiceIndicatorView({
  state,
  streaming = false,
  onToggle,
  onMute,
  onOpen,
}: {
  state: VoiceState | null;
  /** A chat turn is streaming. */
  streaming?: boolean;
  onToggle: () => void;
  onMute: () => void;
  onOpen: () => void;
}) {
  const mood = orbMood(state, streaming);
  if (!state) {
    return (
      <div className="flex items-center gap-1" data-voice-state="offline">
        <button
          type="button"
          disabled
          aria-label={OFFLINE_TITLE}
          title={OFFLINE_TITLE}
          className="relative flex items-center justify-center w-8 h-8 rounded-full"
          style={{ background: 'transparent', border: 'none', padding: 0 }}
        >
          <Orb mood={mood} />
        </button>
      </div>
    );
  }
  const s = state.state;
  const active = ACTIVE.has(s);
  return (
    <div className="flex items-center gap-1" data-voice-state={s}>
      <button
        type="button"
        onClick={onToggle}
        disabled={s === 'muted'}
        aria-label={active ? 'End the voice conversation' : 'Start a voice conversation'}
        title={`${LABELS[s]}${state.duplex === 'half' ? ' (half-duplex)' : ''}`}
        className="relative flex items-center justify-center w-8 h-8 rounded-full cursor-pointer disabled:cursor-default"
        style={{ background: 'transparent', border: 'none', padding: 0 }}
      >
        <Orb mood={mood} />
      </button>
      <button
        type="button"
        onClick={onMute}
        aria-label={s === 'muted' ? 'Unmute the microphone' : 'Mute the microphone'}
        title={s === 'muted' ? 'Unmute' : 'Mute'}
        className="flex items-center justify-center w-6 h-6 rounded-md cursor-pointer"
        style={{ background: 'transparent', border: 'none', color: 'var(--color-text-tertiary)' }}
      >
        {s === 'muted' ? <Mic size={12} /> : <MicOff size={12} />}
      </button>
      {(active || state.turns.length > 0) && (
        <button
          type="button"
          onClick={onOpen}
          className="text-[11px] px-1.5 py-0.5 rounded-md cursor-pointer"
          style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text-secondary)' }}
        >
          {LABELS[s]}
        </button>
      )}
    </div>
  );
}

/** The current conversation's turns, live. When it has ended, "Open in chat"
 * copies the turns (text only) into a normal chat thread. */
export function VoiceDrawerView({
  state,
  onEnd,
  onOpenInChat,
  onClose,
}: {
  state: VoiceState;
  onEnd: () => void;
  onOpenInChat: (turns: VoiceTurn[]) => void;
  onClose: () => void;
}) {
  const active = ACTIVE.has(state.state);
  return (
    <aside
      role="dialog"
      aria-label="Voice conversation"
      className="fixed top-12 right-3 z-50 w-[22rem] max-h-[70vh] flex flex-col rounded-xl shadow-2xl"
      style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
    >
      <header className="flex items-center justify-between px-3 py-2" style={{ borderBottom: '1px solid var(--color-border)' }}>
        <span className="text-[13px] font-semibold" style={{ color: 'var(--color-text)' }}>
          {active ? LABELS[state.state] : 'Last voice conversation'}
        </span>
        <button type="button" onClick={onClose} aria-label="Close" className="cursor-pointer" style={{ background: 'transparent', border: 'none', color: 'var(--color-text-tertiary)' }}>
          <X size={14} />
        </button>
      </header>
      <ol className="flex-1 overflow-y-auto px-3 py-2 flex flex-col gap-2 text-[12.5px]">
        {state.turns.length === 0 && <li style={{ color: 'var(--color-text-tertiary)' }}>Say something…</li>}
        {state.turns.map((t, i) => (
          <li key={i} className={t.role === 'user' ? 'self-end text-right' : ''} style={{ color: t.role === 'user' ? 'var(--color-text)' : 'var(--color-text-secondary)' }}>
            <span className="block text-[10px] uppercase tracking-wide" style={{ color: 'var(--color-text-tertiary)' }}>
              {t.role === 'user' ? 'You' : 'Assistant'}
            </span>
            {t.text}
          </li>
        ))}
      </ol>
      <footer className="flex justify-end gap-2 px-3 py-2" style={{ borderTop: '1px solid var(--color-border)' }}>
        {active ? (
          <button type="button" onClick={onEnd} className="text-[12px] px-2.5 py-1 rounded-md cursor-pointer" style={{ background: 'var(--color-bg-secondary)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}>
            That's all
          </button>
        ) : (
          state.turns.length > 0 && (
            <button type="button" onClick={() => onOpenInChat(state.turns)} className="text-[12px] px-2.5 py-1 rounded-md cursor-pointer" style={{ background: 'var(--color-bg-secondary)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}>
              Open in chat
            </button>
          )
        )}
      </footer>
    </aside>
  );
}

