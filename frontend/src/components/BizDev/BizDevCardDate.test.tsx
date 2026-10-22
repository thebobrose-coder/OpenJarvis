import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BOARD_STAGES, type BoardStage, type PipelineProspect } from '../../lib/bizdev-api';
import { MeetingChip, PipelineBoard, StageAge, stageSince } from './PipelineBoard';

// The date a card entered its stage, beside its "N d" counter. Neutral
// fixtures only: this repo is public.
const NOW = Date.parse('2026-10-22T18:00:00Z');
const AT = '2026-10-19T12:39:19Z';
const day = (iso: string, year = false) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(year ? { year: 'numeric' } : {}) });

const card: PipelineProspect = { id: 7, name: 'Example College', stage: 'drafted', stage_changed_at: AT, days_in_stage: 3 };

describe('stage date on the card', () => {
  it('reads the stage change as a short local date, with the year only when it differs', () => {
    expect(stageSince(AT, NOW)).toBe(day(AT));
    expect(stageSince('2025-12-30T12:00:00Z', NOW)).toBe(day('2025-12-30T12:00:00Z', true));
    expect(stageSince(null, NOW)).toBeNull();
    expect(stageSince('not a date', NOW)).toBeNull();
  });

  it('sits beside the counter, with the stage and full time on hover', () => {
    const html = renderToStaticMarkup(<StageAge p={card} />);
    expect(html).toContain(`>${day(AT)} · 3 d<`);
    expect(html).toMatch(/title="In Drafted since [^"]+"/);
    expect(renderToStaticMarkup(<StageAge p={{ ...card, stage_changed_at: undefined }} />)).toContain('>3 d<');
    expect(renderToStaticMarkup(<StageAge p={{ ...card, stage_changed_at: undefined, days_in_stage: undefined }} />)).toBe('');
  });

  it('the card face shortens the meeting chip; the hover keeps the full line', () => {
    const replied: PipelineProspect = {
      ...card,
      stage: 'replied',
      proposed_stage: 'meeting',
      engagement: { meeting_detected: { event_start: '2026-10-28T16:00:00Z', domain: 'example.edu' } },
    };
    const short = renderToStaticMarkup(<MeetingChip p={replied} compact />);
    expect(short).toContain('>Meeting? Wed, Oct 28<');
    expect(short).toContain('title="Meeting on the calendar? Wed, Oct 28 · example.edu. ');
    expect(renderToStaticMarkup(<MeetingChip p={replied} />)).toContain('>Meeting on the calendar? Wed, Oct 28 · example.edu<');
  });

  it('shows on the board card', () => {
    const stages = Object.fromEntries(BOARD_STAGES.map((s) => [s, s === 'drafted' ? [card] : []])) as Record<BoardStage, PipelineProspect[]>;
    const html = renderToStaticMarkup(<PipelineBoard stages={stages} suppressed={0} onOpen={() => {}} onMove={() => {}} empty={false} />);
    expect(html).toContain(`data-stage-since="${AT}"`);
    expect(html).toContain(`${day(AT)} · 3 d`);
  });
});
