import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';
import { useAppStore } from '../../lib/store';
import { fetchVoiceState, subscribeVoiceState, voiceAction, type VoiceState, type VoiceTurn } from '../../lib/voice-api';
import { ACTIVE, VoiceDrawerView, VoiceIndicatorView } from './VoiceIndicatorViews';

/** Mounted once in Layout, beside the approval bell. Hidden when the voice
 * worker isn't running. */
export function VoiceIndicator() {
  const [state, setState] = useState<VoiceState | null>(null);
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const createConversation = useAppStore((s) => s.createConversation);
  const addMessage = useAppStore((s) => s.addMessage);

  useEffect(() => {
    let unsubscribe = () => {};
    let cancelled = false;
    fetchVoiceState()
      .then((s) => {
        if (cancelled) return;
        setState(s);
        unsubscribe = subscribeVoiceState(setState);
      })
      .catch(() => setState(null));
    return () => {
      cancelled = true;
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

  if (!state) return null;
  const active = ACTIVE.has(state.state);
  return (
    <div className="fixed top-2 right-14 z-40">
      <VoiceIndicatorView
        state={state}
        onToggle={() => act(active ? 'stop' : 'start')}
        onMute={() => act(state.state === 'muted' ? 'unmute' : 'mute')}
        onOpen={() => setOpen((o) => !o)}
      />
      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <VoiceDrawerView state={state} onEnd={() => act('stop')} onOpenInChat={openInChat} onClose={() => setOpen(false)} />,
          document.body,
        )}
    </div>
  );
}
