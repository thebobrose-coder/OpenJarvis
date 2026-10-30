import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';
import { useAppStore } from '../../lib/store';
import { fetchVoiceState, subscribeVoiceState, voiceAction, type VoiceState, type VoiceTurn } from '../../lib/voice-api';
import { ACTIVE, VoiceDrawerView, VoiceIndicatorView } from './VoiceIndicatorViews';

/** While the worker is down, look for it this often (and on window focus). */
const RETRY_MS = 30_000;

/** Mounted once in Layout, beside the approval bell. When the voice worker
 * isn't running it shows a dim orb, and picks the worker up when it returns. */
export function VoiceIndicator() {
  const [state, setState] = useState<VoiceState | null>(null);
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const createConversation = useAppStore((s) => s.createConversation);
  const addMessage = useAppStore((s) => s.addMessage);
  const streaming = useAppStore((s) => s.streamState.isStreaming);

  useEffect(() => {
    let unsubscribe = () => {};
    let cancelled = false;
    let live = false;
    let connecting = false;
    const connect = () => {
      if (cancelled || live || connecting) return;
      connecting = true;
      fetchVoiceState()
        .then((s) => {
          if (cancelled) return;
          live = true;
          setState(s);
          unsubscribe = subscribeVoiceState(setState, (closed) => {
            // Offline until the stream's next state; a closed stream needs a new connect.
            setState(null);
            if (closed) {
              unsubscribe();
              live = false;
            }
          });
        })
        .catch(() => setState(null))
        .finally(() => {
          connecting = false;
        });
    };
    connect();
    window.addEventListener('focus', connect);
    const retry = window.setInterval(connect, RETRY_MS);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', connect);
      window.clearInterval(retry);
      unsubscribe();
    };
  }, []);

  const act = useCallback((a: 'start' | 'stop' | 'mute' | 'unmute') => {
    voiceAction(a).then(setState).catch(() => {});
  }, []);

  const openInChat = useCallback(
    (turns: VoiceTurn[]) => {
      const id = createConversation();
      for (const [i, t] of turns.entries()) {
        addMessage(id, { id: `${id}-voice-${i}`, role: t.role, content: t.text, timestamp: Date.parse(t.at) || Date.now() });
      }
      setOpen(false);
      navigate('/');
    },
    [addMessage, createConversation, navigate],
  );

  const active = state !== null && ACTIVE.has(state.state);
  return (
    <div className="fixed top-2 right-14 z-40">
      <VoiceIndicatorView
        state={state}
        streaming={streaming}
        onToggle={() => act(active ? 'stop' : 'start')}
        onMute={() => act(state?.state === 'muted' ? 'unmute' : 'mute')}
        onOpen={() => setOpen((o) => !o)}
      />
      {open &&
        state &&
        typeof document !== 'undefined' &&
        createPortal(
          <VoiceDrawerView state={state} onEnd={() => act('stop')} onOpenInChat={openInChat} onClose={() => setOpen(false)} />,
          document.body,
        )}
    </div>
  );
}
