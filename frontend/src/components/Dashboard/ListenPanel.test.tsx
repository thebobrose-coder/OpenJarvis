import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ListenList, ListenPanel } from './ListenPanel';
import { SpeakButton } from '../shared/SpeakButton';
import { bdSpeech } from '../BizDev/BizDevView';
import { CompliancePanel } from '../Commerce/CompliancePanel';
import { firstBlock, laneBadge, type SpeechBlock, type VoiceQueue, type VoiceQueueItem } from '../../lib/voice-api';

// Neutral fixtures only: real speech blocks carry live feed content.
const block = (id: string, title = 'Sample block'): SpeechBlock => ({
  id,
  title,
  mood: 'neutral',
  priority: 'briefing',
  lane: 'expressive',
  created_at: '2026-09-30T06:00:00Z',
});

const item = (id: string, order: number, audio: VoiceQueueItem['audio'], title = `Sample ${order}`): VoiceQueueItem => ({
  ...block(id, title),
  source_feed: order === 1 ? 'ecom_briefing' : 'content_proposals',
  order,
  audio,
  audio_path: audio === 'missing' ? null : `C:/sample/${id}.wav`,
  audio_url: audio === 'missing' ? null : `/api/voice/audio/${id}`,
  audio_version: audio === 'missing' ? null : '2026-09-30T06:10:00Z',
  duration: audio === 'missing' ? null : 28.6,
});

const QUEUE: VoiceQueue = {
  run_at: '2026-09-30T06:05:00Z',
  generated_at: '2026-09-30T06:05:00Z',
  worker: true,
  items: [
    item('00000000000000aa', 1, 'expressive', 'Sample briefing'),
    item('00000000000000bb', 2, 'fast', 'Sample proposals'),
    item('00000000000000cc', 3, 'missing', 'Sample queued'),
  ],
};

describe('Listen panel', () => {
  it('lists the queue in order with source, mood and lane badges', () => {
    const html = renderToStaticMarkup(<ListenList queue={QUEUE} />);
    const at = (s: string) => html.indexOf(s);
    expect(at('Sample briefing')).toBeLessThan(at('Sample proposals'));
    expect(at('Sample proposals')).toBeLessThan(at('Sample queued'));
    expect(html).toContain('Commerce · neutral · 29 s');
    expect(html).toContain('Content · neutral');
    expect(html).toContain('>Erebus<');
    expect(html).toContain('>fast<');
    expect(html).toContain('>queued<');
    expect(html).toContain('Play all');
    expect(html).toContain('aria-label="Play Sample briefing"');
  });

  it('never auto-plays: no autoplay attribute anywhere', () => {
    const html = renderToStaticMarkup(<ListenPanel initial={QUEUE} />);
    expect(html).toContain('Listen');
    expect(html).not.toMatch(/autoplay/i);
  });

  it('says so when the worker is offline or the queue is empty', () => {
    expect(renderToStaticMarkup(<ListenList queue={{ ...QUEUE, worker: false }} />)).toContain('voice worker offline');
    expect(renderToStaticMarkup(<ListenList queue={{ ...QUEUE, items: [] }} />)).toContain('Nothing to listen to');
  });
});

describe('speaker button', () => {
  it('renders for a feed with a block, and not without one', () => {
    const html = renderToStaticMarkup(<SpeakButton feed="ecom_briefing" block={block('00000000000000aa', 'Store briefing')} />);
    expect(html).toContain('aria-label="Listen: Store briefing"');
    expect(renderToStaticMarkup(<SpeakButton feed="ecom_briefing" block={null} />)).toBe('');
  });

  it('picks the first valid block, and follow-ups before the research run on BD', () => {
    expect(firstBlock([{ ...block('BAD') }, block('00000000000000aa')])?.id).toBe('00000000000000aa');
    expect(firstBlock(undefined)).toBeNull();
    const follow = block('00000000000000ff', 'Follow-ups');
    const research = block('00000000000000ee', 'Research');
    expect(bdSpeech({ speech: [follow] }, { speech: [research] })).toEqual({ feed: 'bd_pipeline', block: follow });
    expect(bdSpeech({ speech: [] }, { speech: [research] })).toEqual({ feed: 'bd_prospects', block: research });
    expect(bdSpeech(null, null).block).toBeNull();
  });

  it('sits in a panel header when the feed carries speech', () => {
    const findings = {
      generated_at: '2026-09-30T10:45:00Z',
      age_seconds: 60,
      stale: false,
      counts: { open: 2, new: 1, open_by_property: { 'property-a': 2 } },
      speech: [block('00000000000000dd', 'Compliance update')],
    } as any;
    const html = renderToStaticMarkup(<CompliancePanel findings={findings} />);
    expect(html).toContain('aria-label="Listen: Compliance update"');
    expect(renderToStaticMarkup(<CompliancePanel findings={{ ...findings, speech: [] }} />)).not.toContain('Listen:');
  });

  it('badges the lanes', () => {
    expect(laneBadge('expressive')).toBe('Erebus');
    expect(laneBadge('fast')).toBe('fast');
    expect(laneBadge('missing')).toBeNull();
  });
});
