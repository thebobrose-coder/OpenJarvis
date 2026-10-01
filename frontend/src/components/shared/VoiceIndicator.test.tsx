import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { VoiceDrawerView, VoiceIndicatorView } from './VoiceIndicatorViews';
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

  it('listening pulses and offers to end; the label opens the drawer', () => {
    const html = indicator({ state: 'listening', conversation_id: 'c-1' });
    expect(html).toContain('animate-pulse');
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

  it('renders nothing without a worker', () => {
    expect(renderToStaticMarkup(<VoiceIndicatorView state={null} onToggle={noop} onMute={noop} onOpen={noop} />)).toBe('');
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
