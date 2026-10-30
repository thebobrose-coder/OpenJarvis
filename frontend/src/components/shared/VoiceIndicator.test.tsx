import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OFFLINE_TITLE, orbMood, VoiceDrawerView, VoiceIndicatorView } from './VoiceIndicatorViews';
import type { VoiceState } from '../../lib/voice-api';

// Neutral fixtures only: real turns are the operator's speech.
const base: VoiceState = {
  state: 'idle',
  conversation_id: null,
  duplex: 'full',
  device: 'Sample Headset',
  turns: [],
};
const turns = [
  { role: 'user' as const, text: 'Sample question?', at: '2026-10-01T09:00:00Z' },
  { role: 'assistant' as const, text: 'Sample answer.', at: '2026-10-01T09:00:03Z' },
];
const noop = () => {};

const indicator = (s: Partial<VoiceState>) =>
  renderToStaticMarkup(<VoiceIndicatorView state={{ ...base, ...s }} onToggle={noop} onMute={noop} onOpen={noop} />);

describe('voice indicator', () => {
  it('idle: a start button and a mute toggle, no drawer button', () => {
    const html = indicator({});
    expect(html).toContain('data-voice-state="idle"');
    expect(html).toContain('aria-label="Start a voice conversation"');
    expect(html).toContain('aria-label="Mute the microphone"');
    expect(html).not.toContain('>Listening<');
  });

  it('listening offers to end; the label opens the drawer; the orb carries the motion', () => {
    const html = indicator({ state: 'listening', conversation_id: 'c-1' });
    expect(html).toContain('data-orb-mood="listening"');
    expect(html).not.toContain('animate-pulse');
    expect(html).toContain('aria-label="End the voice conversation"');
    expect(html).toContain('>Listening<');
  });

  it('thinking and speaking show their state', () => {
    expect(indicator({ state: 'thinking', conversation_id: 'c-1' })).toContain('>Thinking<');
    expect(indicator({ state: 'speaking', conversation_id: 'c-1' })).toContain('>Speaking<');
  });

  it('muted disables starting and offers unmute', () => {
    const html = indicator({ state: 'muted' });
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-label="Unmute the microphone"');
  });

  it('notes half-duplex in the tooltip', () => {
    expect(indicator({ duplex: 'half' })).toContain('(half-duplex)');
  });

  it('keeps data-voice-state and draws the orb for every state', () => {
    for (const st of ['idle', 'listening', 'transcribing', 'thinking', 'speaking', 'muted'] as const) {
      const html = indicator({ state: st });
      expect(html).toContain(`data-voice-state="${st}"`);
      expect(html).toContain(`data-orb-mood="${st}"`);
      expect(html).toContain('<canvas');
    }
  });

  it('without a worker (a 503): a dim offline orb, disabled, and no other controls', () => {
    const html = renderToStaticMarkup(<VoiceIndicatorView state={null} onToggle={noop} onMute={noop} onOpen={noop} />);
    expect(html).toContain('data-voice-state="offline"');
    expect(html).toContain('data-orb-mood="offline"');
    expect(html).toContain(`title="${OFFLINE_TITLE}"`);
    expect(html).toContain('disabled=""');
    expect(html).not.toContain('Mute the microphone');
    expect(html).not.toContain('Unmute');
  });

  it('a streaming chat turn with an idle voice shows thinking', () => {
    const html = renderToStaticMarkup(
      <VoiceIndicatorView state={base} streaming onToggle={noop} onMute={noop} onOpen={noop} />,
    );
    expect(html).toContain('data-orb-mood="thinking"');
    expect(html).toContain('data-voice-state="idle"');
  });

  it('picks the mood: voice above idle, then streaming, then the GPU lease', () => {
    expect(orbMood(null)).toBe('offline');
    expect(orbMood(base)).toBe('idle');
    expect(orbMood({ ...base, lease_held: true })).toBe('rendering');
    expect(orbMood({ ...base, state: 'listening', lease_held: true })).toBe('listening');
    expect(orbMood({ ...base, state: 'speaking' }, true)).toBe('speaking');
    expect(orbMood({ ...base, lease_held: true }, true)).toBe('thinking');
    expect(orbMood({ ...base, state: 'muted', lease_held: true })).toBe('muted');
    expect(orbMood({ ...base, lease_held: undefined })).toBe('idle'); // an older worker
  });
});

describe('voice drawer', () => {
  it('shows the live turns and a "That\'s all" button while active', () => {
    const html = renderToStaticMarkup(
      <VoiceDrawerView state={{ ...base, state: 'listening', conversation_id: 'c-1', turns }} onEnd={noop} onOpenInChat={noop} onClose={noop} />,
    );
    expect(html).toContain('Sample question?');
    expect(html).toContain('Sample answer.');
    expect(html).toContain('That&#x27;s all');
    expect(html).not.toContain('Open in chat');
  });

  it('offers "Open in chat" once the conversation has ended', () => {
    const html = renderToStaticMarkup(<VoiceDrawerView state={{ ...base, turns }} onEnd={noop} onOpenInChat={noop} onClose={noop} />);
    expect(html).toContain('Open in chat');
    expect(html).toContain('Last voice conversation');
  });
});
