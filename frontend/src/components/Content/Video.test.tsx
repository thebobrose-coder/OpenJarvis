import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type {
  ContentPerformance,
  ContentSeedbank,
  ContentWinners,
  Lane,
  Post,
  Proposal,
  PropertyMotion,
} from '../../lib/content-api';
import { applyDecisions } from '../../hooks/useContentData';
import { PerformancePanel } from './PerformancePanel';
import { ApproveEditor, DecidedItem, ProposalCard, approvalEdits } from './ProposalsQueue';
import { SeedComposer, seedBody, seedProblems, seedVideoAllowed, type SeedForm } from './SeedComposer';
import { assetKeyProblem, skippedLabel, videoAllowed } from './Video';
import { WinnersPanel, reelsLine } from './WinnersPanel';

// Neutral fixtures only: this repo is public, and real proposals name the
// operator's properties, products, pillars and topics.
const META = { generated_at: '2026-10-23T12:00:00Z', age_seconds: 60, stale: false };
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const MOTION: PropertyMotion = { lanes: ['short'], release: 'instagram' };
const KEY = 'assets/alpha/sample-clip.mp4';

function lane(over: Partial<Lane>): Lane {
  return {
    lane: 'short',
    content_type: 'short',
    cadence_per_week: 7,
    seedable: true,
    operator_only: false,
    feed_lane: false,
    queued: 3,
    in_flight: 0,
    pending: 0,
    runway_days: 3,
    status: 'ok',
    ...over,
  };
}

const SEEDBANK: ContentSeedbank = {
  ...META,
  run_at: '2026-10-23T05:30:00Z',
  target_runway_days: 7,
  properties: [
    {
      id: 'alpha',
      lanes: [lane({ lane: 'short' }), lane({ lane: 'long', content_type: 'thesis', operator_only: true })],
      motion: MOTION,
    },
    { id: 'beta', lanes: [lane({ lane: 'short' })], motion: null },
  ],
};

function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: ID(1),
    property_id: 'alpha',
    lane: 'short',
    content_type: 'short',
    status: 'pending',
    topic: 'Sample topic about budget rigs',
    pillar_hint: 'grit',
    created_at: '2026-10-23T08:00:00Z',
    motion: null,
    motion_brief: null,
    video_key: null,
    ...over,
  };
}

const editor = (p: Proposal, motion: PropertyMotion | null = MOTION) =>
  renderToStaticMarkup(<ApproveEditor proposal={p} pillars={['grit']} motion={motion} onApprove={vi.fn()} onCancel={vi.fn()} />);

describe('the Video control', () => {
  it('shows only on a lane the motion block lists, never long-form or the thesis', () => {
    expect(videoAllowed(MOTION, 'short', 'short')).toBe(true);
    expect(videoAllowed(null, 'short', 'short')).toBe(false);
    expect(videoAllowed(undefined, 'short', 'short')).toBe(false);
    expect(videoAllowed({ lanes: ['short', 'long'], release: 'g1' }, 'long', 'long')).toBe(false);
    expect(videoAllowed({ lanes: ['short', 'long'], release: 'g1' }, 'long', 'thesis')).toBe(false);
    expect(videoAllowed(MOTION, 'feed:sample', 'news')).toBe(false);
  });

  it('renders in the approve editor by lane', () => {
    const shown = editor(proposal());
    expect(shown).toContain('aria-label="Video"');
    expect(shown).toContain('Default (lane)');
    expect(shown).toContain('posts as a Reel');
    expect(shown).toContain('placeholder="what happens in the frame — not a caption"');
    expect(shown).toContain('Advanced');
    expect(editor(proposal(), null)).not.toContain('aria-label="Video"');
    expect(editor(proposal({ lane: 'long', content_type: 'thesis' }))).not.toContain('aria-label="Video"');
  });

  it('never prefills the asset key, and disables the beat on Never', () => {
    const html = editor(proposal({ motion: 'never', motion_brief: 'Sample beat', video_key: KEY }));
    expect(html).toMatch(/aria-label="Video asset key"[^>]*value=""|value=""[^>]*aria-label="Video asset key"/);
    expect(html).toContain(`Remove the current key (<code>${KEY}</code>)`);
    expect(html).toMatch(/<input[^>]*disabled=""[^>]*aria-label="Beat"|<input[^>]*aria-label="Beat"[^>]*disabled=""/);
    const always = editor(proposal({ motion: 'always', motion_brief: 'Sample beat' }));
    expect(always).toContain('value="Sample beat"');
    expect(always).not.toMatch(/<input[^>]*disabled=""[^>]*aria-label="Beat"/);
  });

  it('checks the asset key shape as Hermes does', () => {
    expect(assetKeyProblem('', 'alpha')).toBeNull();
    expect(assetKeyProblem(KEY, 'alpha')).toBeNull();
    expect(assetKeyProblem('assets/beta/clip.mp4', 'alpha')).toContain('assets/alpha/');
    expect(assetKeyProblem('assets/alpha/clip.mov', 'alpha')).not.toBeNull();
    expect(assetKeyProblem('assets/alpha/../x.mp4', 'alpha')).not.toBeNull();
  });
});

describe('the approve body', () => {
  const same = { topic: 'Sample topic about budget rigs', pillar: 'grit', product: '', note: '' };
  const video = { choice: 'default' as const, beat: '', assetKey: '' };

  it('leaves the motion fields out when nothing changed', () => {
    expect(approvalEdits(proposal(), { ...same, video })).toEqual({});
    expect(approvalEdits(proposal({ motion: 'always', motion_brief: 'Beat' }), { ...same, video: { ...video, choice: 'always', beat: 'Beat' } })).toEqual({});
  });

  it('carries the three fields', () => {
    expect(approvalEdits(proposal(), { ...same, video: { choice: 'always', beat: ' A rover tips over a dune ', assetKey: ` ${KEY} ` } })).toEqual({
      motion: 'always',
      motion_brief: 'A rover tips over a dune',
      video_asset_key: KEY,
    });
  });

  it('sends null to clear to the lane default and "" to remove the beat and the key', () => {
    const p = proposal({ motion: 'always', motion_brief: 'Beat', video_key: KEY });
    expect(approvalEdits(p, { ...same, video: { choice: 'default', beat: '', assetKey: '', removeKey: true } })).toEqual({
      motion: null,
      motion_brief: '',
      video_asset_key: '',
    });
  });

  it('sends Never without touching the beat', () => {
    const p = proposal({ motion_brief: 'Beat' });
    expect(approvalEdits(p, { ...same, video: { choice: 'never', beat: '', assetKey: '' } })).toEqual({ motion: 'never' });
  });

  it('leaves the motion fields out where the control is hidden', () => {
    expect(approvalEdits(proposal(), same)).toEqual({});
  });

  it('shows the edits in the optimistic move with the feed names', () => {
    const feed = { ...META, run_at: '', pending: [proposal()], recent_decided: [], thesis_prompts: [] };
    const { recent } = applyDecisions(feed, {
      [ID(1)]: { action: 'approve', at: Date.parse('2026-10-23T12:00:00Z'), edits: { motion: 'always', motion_brief: 'Beat', video_asset_key: KEY } },
    });
    expect(recent[0]).toMatchObject({ motion: 'always', motion_brief: 'Beat', video_key: KEY });
    expect(recent[0]).not.toHaveProperty('video_asset_key');
  });
});

describe('the chips', () => {
  const card = (p: Proposal) =>
    renderToStaticMarkup(<ProposalCard proposal={p} pillars={[]} showProperty={false} onApprove={vi.fn()} onReject={vi.fn()} />);

  it('says Video with the beat on hover, or No video', () => {
    const always = card(proposal({ motion: 'always', motion_brief: 'A rover tips over a dune' }));
    expect(always).toContain('title="Beat: A rover tips over a dune"');
    expect(always).toContain('Video</span>');
    expect(card(proposal({ motion: 'never' }))).toContain('No video');
    expect(card(proposal())).not.toMatch(/Video<\/span>|No video/);
    const decided = renderToStaticMarkup(<DecidedItem proposal={proposal({ status: 'queued', motion: 'always' })} showProperty={false} />);
    expect(decided).toContain('Video</span>');
  });

  it('renders an edit refusal note as it is today', () => {
    const html = card(proposal({ note: 'edit refused: motionBrief contains a URL' }));
    expect(html).toContain('edit refused: motionBrief contains a URL');
  });
});

describe('the seed composer', () => {
  const form: SeedForm = { property_id: 'alpha', text: 'Sample topic', pillar: '', product: '', url: '', queries: [], priority: 2 };
  const short = SEEDBANK.properties[0].lanes[0];

  it('shows the Video control by lane', () => {
    expect(seedVideoAllowed(SEEDBANK.properties[0], short)).toBe(true);
    expect(seedVideoAllowed(SEEDBANK.properties[0], SEEDBANK.properties[0].lanes[1])).toBe(false);
    expect(seedVideoAllowed(SEEDBANK.properties[1], SEEDBANK.properties[1].lanes[0])).toBe(false);
    const render = (property_id: string, laneKey: string) =>
      renderToStaticMarkup(
        <SeedComposer
          seedbank={SEEDBANK}
          draft={{ property_id, lane: laneKey, text: '', url: '' }}
          onQueue={vi.fn()}
          onVerify={vi.fn()}
          onClose={vi.fn()}
        />,
      );
    expect(render('alpha', 'short')).toContain('aria-label="Video"');
    expect(render('alpha', 'long')).not.toContain('aria-label="Video"');
    expect(render('beta', 'short')).not.toContain('aria-label="Video"');
  });

  it('passes the fields through, leaving out the defaults', () => {
    expect(seedBody({ ...form, video: { choice: 'always', beat: ' Beat ', assetKey: KEY } }, short)).toMatchObject({
      motion: 'always',
      motion_brief: 'Beat',
      video_asset_key: KEY,
    });
    const plain = seedBody({ ...form, video: { choice: 'default', beat: '', assetKey: '' } }, short);
    expect(plain).not.toHaveProperty('motion');
    expect(plain).not.toHaveProperty('motion_brief');
    expect(plain).not.toHaveProperty('video_asset_key');
    expect(seedBody({ ...form, video: { choice: 'never', beat: 'Beat', assetKey: '' } }, short)).toMatchObject({ motion: 'never' });
    expect(seedBody({ ...form, video: { choice: 'never', beat: 'Beat', assetKey: '' } }, short)).not.toHaveProperty('motion_brief');
  });

  it('blocks Queue on a bad asset key', () => {
    expect(seedProblems({ ...form, video: { choice: 'always', beat: '', assetKey: 'assets/beta/x.mp4' } }, short, null)).toEqual([
      'Asset key: an .mp4 under assets/alpha/.',
    ]);
  });
});

describe('measurement and winners', () => {
  const post = (n: number, over: Partial<Post> = {}): Post => ({
    post_id: `p${n}`,
    origin: 'hermes',
    content_type: 'short',
    excerpt: `Sample post ${n}`,
    distributed_at: `2026-10-2${n}T08:00:00Z`,
    ...over,
  });
  const PERFORMANCE: ContentPerformance = {
    ...META,
    run_at: '2026-10-23T05:00:00Z',
    properties: [
      {
        id: 'alpha',
        posts: [
          post(1, { video_key: 'sample-reel' }),
          post(2, { motion_skipped_reason: 'release-blocked' }),
          post(3, { motion_skipped_reason: 'reel-upload-failed' }),
          post(4, { motion_skipped_reason: 'Model returned 404: ' + 'x'.repeat(300) }),
          post(5),
        ],
      },
    ],
  };

  it('marks Reels and says why a clip was skipped, clipped', () => {
    const html = renderToStaticMarkup(<PerformancePanel performance={PERFORMANCE} selectedProperty="alpha" />);
    expect(html).toContain('Reel</span>');
    expect(html).toContain('clip held at G1');
    expect(html).toContain('posted as still');
    expect(html).not.toContain('x'.repeat(100) + '<');
    expect(skippedLabel('reel-post-failed')).toBe('posted as still');
    expect(skippedLabel('Model returned 404: ' + 'x'.repeat(300)).length).toBe(60);
  });

  const winners = (video: ContentWinners['properties'][number]['video']): ContentWinners => ({
    ...META,
    run_at: '2026-10-19T06:00:00Z',
    window_days: 28,
    properties: [{ id: 'alpha', top: [], bottom: [], long_form: 0, video }],
  });
  const panel = (w: ContentWinners) => renderToStaticMarkup(<WinnersPanel winners={w} selectedProperty="alpha" showProperty={false} />);

  it('lists Reels beside the stills once there is one', () => {
    expect(panel(winners(null))).not.toContain('aria-label="Reels"');
    const html = panel(
      winners({
        posts: 3,
        unmeasured: 3,
        top: [],
        bottom: [],
        by_pillar: [{ pillar: 'grit', posts: 3, avg_engagement: 12.5, sessions: null, purchases: null, site_clicks: null }],
      }),
    );
    expect(html).toContain('aria-label="Reels"');
    expect(html).toContain('3 Reels, 3 unmeasured');
    expect(html).toContain('grit: 3 Reels · avg eng. 12.5');
    expect(html).toContain('Reels aren’t ranked yet');
    expect(reelsLine({ posts: 1, unmeasured: 0, top: [], bottom: [], by_pillar: [] })).toBe('1 Reel');
  });

  it('shows the Reel lists when they fill', () => {
    const html = panel(
      winners({
        posts: 2,
        unmeasured: 0,
        top: [{ post_id: 'r1', excerpt: 'Sample top reel', score: 4.2, video_key: 'sample-reel' }],
        bottom: [{ post_id: 'r2', excerpt: 'Sample bottom reel', score: 1.1, video_key: 'sample-reel-2' }],
        by_pillar: [],
      }),
    );
    expect(html).toContain('Top Reels');
    expect(html).toContain('Sample top reel');
    expect(html).toContain('Sample bottom reel');
    expect(html).not.toContain('aren’t ranked yet');
  });
});
