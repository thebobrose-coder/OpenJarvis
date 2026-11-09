import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Activity } from 'lucide-react';
import { Drawer } from './Drawer';
import { PageFrame } from './PageFrame';
import { DashboardPanel } from '../Dashboard/DashboardPanel';
import { FeedFreshnessLineView } from '../Dashboard/FeedFreshnessLine';

// The widescreen shell (plan 2026-11-09, Phase 0): the primitives every page shares.
describe('PageFrame', () => {
  it('is the page scroll column at the wide content width', () => {
    const html = renderToStaticMarkup(<PageFrame>x</PageFrame>);
    expect(html).toContain('overflow-y-auto px-6 py-6');
    expect(html).toContain('max-w-[2240px]');
  });
  it('narrow keeps a prose measure for reading pages', () => {
    expect(renderToStaticMarkup(<PageFrame narrow>x</PageFrame>)).toContain('max-w-3xl');
  });
});

describe('Drawer', () => {
  it('renders nothing while closed', () => {
    expect(renderToStaticMarkup(<Drawer open={false} onClose={() => undefined} label="Test">x</Drawer>)).toBe('');
  });
  it('is a labelled dialog at the narrow width by default', () => {
    const html = renderToStaticMarkup(<Drawer open onClose={() => undefined} label="Decisions">body</Drawer>);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-label="Decisions"');
    expect(html).toContain('max-w-[36rem]');
    expect(html).toContain('>body<');
  });
  it('wide is 64 rem', () => {
    expect(renderToStaticMarkup(<Drawer open onClose={() => undefined} label="Episode" width="wide">x</Drawer>)).toContain('max-w-[64rem]');
  });
});

describe('DashboardPanel', () => {
  const panel = (props: Partial<Parameters<typeof DashboardPanel>[0]>) =>
    renderToStaticMarkup(
      <DashboardPanel icon={Activity} title="T" {...props}>
        body
      </DashboardPanel>,
    );
  it('spans by size, with the 3xl tier where it differs', () => {
    expect(panel({ size: 'hero' })).toContain('lg:col-span-5 3xl:col-span-4');
    expect(panel({ size: 'sixth' })).toContain('lg:col-span-3 3xl:col-span-2');
    expect(panel({ size: 'third' })).not.toContain('3xl:');
  });
  it('a banded panel has a fixed height and scrolls inside', () => {
    const html = panel({ band: 'short' });
    expect(html).toContain('lg:h-[420px]');
    expect(html).toContain('overflow-y-auto');
    expect(panel({ band: 'tall' })).toContain('lg:h-[860px]');
    expect(panel({})).not.toContain('overflow-y-auto');
  });
  it('headerExtra sits between the header and the body', () => {
    const html = panel({ headerExtra: <span>tabs</span> });
    expect(html.indexOf('tabs')).toBeLessThan(html.indexOf('body'));
  });
  it('tells a Hermes regenerate from a local reload', () => {
    expect(panel({ onRegenerate: () => undefined })).toContain('title="Regenerate"');
    expect(panel({ onRegenerate: () => undefined, regenerateKind: 'reload' })).toContain('title="Reload"');
  });
  it('clamps a long error', () => {
    expect(panel({ error: 'x'.repeat(500) })).toContain('line-clamp-3');
  });
});

describe('FeedFreshnessLineView', () => {
  it('reads the newest age and counts stale and late feeds', () => {
    const html = renderToStaticMarkup(
      <FeedFreshnessLineView
        feeds={[
          { label: 'A', age: 120 },
          { label: 'B', age: 7200, stale: true },
          { label: 'C', age: 100_000, staleAfterSeconds: 26 * 3600 },
        ]}
      />,
    );
    expect(html).toContain('Updated 2 min ago');
    expect(html).toContain('oldest 27 h');
    expect(html).toContain('1 stale');
    expect(html).toContain('1 late');
    expect(html).toContain('A: 2 min ago');
  });
  it('is quiet with one fresh feed', () => {
    const html = renderToStaticMarkup(<FeedFreshnessLineView feeds={[{ label: 'A', age: 30 }]} />);
    expect(html).toContain('Updated just now');
    expect(html).not.toContain('oldest');
    expect(html).not.toContain('stale');
  });
  it('renders nothing without ages', () => {
    expect(renderToStaticMarkup(<FeedFreshnessLineView feeds={[]} />)).toBe('');
  });
});
