import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { BreakingNewsAlert } from '../../lib/api';
import { BreakingListView, SHORT_WINDOW_HIDDEN } from './BreakingListView';

// Invented alerts only: this repo is public.
const NOW = Date.parse('2026-10-09T20:00:00Z');

function alert(minutesAgo: number, over: Partial<BreakingNewsAlert> = {}): BreakingNewsAlert {
  return {
    headline: `Headline ${minutesAgo}`,
    summary: '',
    url: 'https://example.com/a',
    alerted_at: new Date(NOW - minutesAgo * 60_000).toISOString(),
    audio_available: true,
    audio_path: null,
    ...over,
  };
}

function view(rows: BreakingNewsAlert[], over: Partial<Parameters<typeof BreakingListView>[0]> = {}) {
  return renderToStaticMarkup(
    <BreakingListView
      rows={rows}
      latestAt={rows[0]?.alerted_at ?? null}
      canPlay
      playing={false}
      stale={false}
      now={NOW}
      onToggle={() => {}}
      onOpen={() => {}}
      {...over}
    />,
  );
}

describe('BreakingListView', () => {
  it('shows "No current breaking news" only for an empty list', () => {
    expect(view([])).toContain('No current breaking news');
    expect(view([alert(5)])).not.toContain('No current breaking news');
  });

  it('renders the newest with its player, then the others with kind, level, source and age', () => {
    const html = view([
      alert(5, { kind: 'hazard', level: 'red', source: 'USGS', tickers: ['ABC'] }),
      alert(38, { kind: 'official', source: 'ECB' }),
      alert(120, { source: 'trading' }),
    ]);
    expect(html.match(/Play breaking news summary/g)).toHaveLength(1);
    expect(html).toContain('Headline 5');
    expect(html).toContain('ABC');
    expect(html).toContain('hazard');
    expect(html).toContain('var(--color-error)');
    expect(html).toContain('USGS · 5 min');
    expect(html).toContain('official');
    expect(html).toContain('ECB · 38 min');
    expect(html).toContain('trading');
    expect(html.match(/line-clamp-2/g)).toHaveLength(3);
    // Only the two extra rows give way on short windows.
    expect(html.split(SHORT_WINDOW_HIDDEN)).toHaveLength(3);
  });

  it('has no player when the newest row is not the spoken alert', () => {
    expect(view([alert(5)], { latestAt: null })).not.toContain('Play breaking news summary');
  });

  it('marks a stale copy', () => {
    expect(view([alert(5)], { stale: true })).toContain('stale');
    expect(view([alert(5)])).not.toContain('>stale<');
  });
});
