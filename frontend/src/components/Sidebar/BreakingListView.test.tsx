import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { BreakingNewsAlert } from '../../lib/api';
import { selectBreaking } from '../../lib/breaking-list';
import { StackHealthDrawer } from './StackHealthDrawer';
import { event, health } from './stackHealthFixtures';
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

describe('BreakingListView severity gate (hq 0017 A3)', () => {
  const nine = alert(30, { severity: 9, kind: 'aws', source: 'AWS Health', headline: 'Open issue' });
  const six = alert(5, { severity: 6, kind: 'aws', source: 'AWS Health', headline: 'Scheduled maintenance' });

  it('lists a newer 6 with its chip and a quiet marker', () => {
    const html = view([six, nine], { latestAt: nine.alerted_at });
    expect(html).toContain('Scheduled maintenance');
    expect(html).toContain('>aws<');
    expect(html).toContain('>quiet<');
    expect(html.indexOf('Scheduled maintenance')).toBeLessThan(html.indexOf('Open issue'));
  });

  it('keeps the player on the spoken 9 when a 6 leads, visible on short windows', () => {
    const html = view([six, nine], { latestAt: nine.alerted_at });
    expect(html.match(/Play breaking news summary/g)).toHaveLength(1);
    const playAt = html.indexOf('Play breaking news summary');
    expect(playAt).toBeGreaterThan(html.indexOf('Scheduled maintenance'));
    expect(playAt).toBeLessThan(html.indexOf('Open issue'));
    const nineRow = html.slice(html.lastIndexOf('<div', playAt), playAt);
    expect(nineRow).not.toContain('hidden');
  });

  it('the spoken state is the same with or without the 6', () => {
    const without = view([nine], { latestAt: nine.alerted_at });
    const withSix = view([six, nine], { latestAt: nine.alerted_at });
    expect(without.match(/Play breaking news summary/g)).toHaveLength(1);
    expect(withSix.match(/Play breaking news summary/g)).toHaveLength(1);
    expect(view([nine], { latestAt: nine.alerted_at })).not.toContain('>quiet<');
  });
});

describe('BreakingListView cloud notices (hq 0017 A3.1)', () => {
  const notice = alert(5, { severity: 6, kind: 'google', source: 'Google Cloud', headline: 'Sample Google notice' });
  const outage = alert(10, { severity: 9, kind: 'aws', source: 'AWS Health', headline: 'Sample AWS outage' });
  const release = alert(20, { severity: 7, kind: 'official', source: 'Sample Agency', headline: 'Sample release' });
  const listed = (rows: typeof notice[]) => view(selectBreaking(null, rows, NOW), { latestAt: null });

  it('hides a severity-6 google row that the stack health drawer still shows', () => {
    expect(listed([notice, outage])).not.toContain('Sample Google notice');
    const drawer = renderToStaticMarkup(
      <StackHealthDrawer
        health={health({ cloud_events: [event('accountNotification', { type: 'GOOGLE_NOTICE', description: 'Sample Google notice' })] })}
        now={NOW}
        run={{ state: 'idle', detail: null }}
        onRun={() => {}}
        onClose={() => {}}
      />,
    );
    expect(drawer).toContain('Sample Google notice');
    expect(drawer).toContain('>google<');
  });

  it('keeps a severity-9 aws row and a quiet official row with its marker', () => {
    const html = listed([notice, outage, release]);
    expect(html).toContain('Sample AWS outage');
    expect(html).toContain('Sample release');
    expect(html).toContain('>quiet<');
    expect(html.match(/>quiet</g)).toHaveLength(1);
  });

  it('shows the usual empty line when only cloud notices are recent', () => {
    expect(listed([notice, alert(8, { severity: 7, kind: 'aws' })])).toContain('No current breaking news');
  });
});
