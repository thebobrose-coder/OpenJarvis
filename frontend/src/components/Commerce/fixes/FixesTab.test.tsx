import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  FIX_STATUSES,
  actionsFor,
  approveClassRequest,
  fixRequest,
  judgeOnlyInvalid,
  specDrops,
  type CatalogFixes,
  type FixStatus,
  type Patch,
} from '../../../lib/fixes-api';
import { CHANGED_MESSAGE, reconcileFixes, runDecision } from '../../../hooks/useCatalogFixes';
import type { FeedStates } from '../../../hooks/useCommerceData';
import { CommerceView, type FixesProps } from '../CommerceView';
import { ALL_STORES } from '../format';
import { DiffBody } from './FieldDiff';
import {
  BULK_NO_STREAK,
  FixesTab,
  P1_BANNER,
  STREAK_EXPLAINED,
  classApprovable,
  classConfirmText,
  classReviewOnly,
  groupPatches,
  refusalText,
  sortPatches,
} from './FixesTab';
import { PatchCard, REVIEW_ONLY_TITLE, type CardPanel } from './PatchCard';
import { diffWords, droppedNumbers, htmlToText } from './diff';

// Neutral fixtures only: this repo is public.
const BEFORE = '<p>A sample light with 1000 lm output.</p>';
const AFTER = '<p>A sample light rated at 1000 lm.</p>';

function patch(id: string, status: FixStatus, over: Partial<Patch> = {}): Patch {
  return {
    id,
    patch_sha256: id.padEnd(64, '0'),
    store: 'alpha',
    product_id: '1001',
    product_title: 'Sample Light',
    admin_url: 'https://admin.example.test/products/1001',
    fix_class: { store: 'alpha', rule: '4', field: 'descriptionHtml' },
    addresses: { finding_ids: ['f'.repeat(32)], rec_ids: [] },
    changes: [
      { field: 'descriptionHtml', before: BEFORE, before_sha256: 'b'.repeat(64), after: AFTER, rationale: 'Drops the unverified claim.' },
    ],
    validator: {
      passed: status !== 'invalid',
      checks: [
        { name: 'specs', passed: true, detail: 'all figures kept' },
        { name: 'judge', passed: status !== 'invalid', detail: status === 'invalid' ? 'claim remains' : '' },
      ],
    },
    judge: { model: 'judge-model', judge_version: '1', verdict: status === 'invalid' ? 'finding' : 'clear', quote: '', reason: '' },
    status,
    edited: false,
    created_at: '2026-10-02T06:00:00Z',
    decided_at: ['proposed', 'invalid'].includes(status) ? null : '2026-10-02T07:00:00Z',
    note: null,
    history: [{ status: 'proposed', at: '2026-10-02T06:00:00Z' }],
    applied: null,
    verified: null,
    ...over,
  };
}

const ids = (n: number) => n.toString(16).padStart(12, '0');

function feed(patches: Patch[], over: Partial<CatalogFixes> = {}): CatalogFixes {
  const counts: Partial<Record<FixStatus, number>> = {};
  for (const p of patches) counts[p.status] = (counts[p.status] ?? 0) + 1;
  return {
    generated_at: '2026-10-02T07:00:00Z',
    age_seconds: 120,
    stale: false,
    run_at: '2026-10-02T06:00:00Z',
    paused: false,
    writer: { live: false, writes_today: 0, writes_cap: null, auto_today: 0, auto_cap: null },
    counts,
    patches,
    classes: [],
    speech: [],
    ...over,
  };
}

// An invalid patch that also failed a deterministic check.
const specsFailed = (p: Patch): Patch => ({
  ...p,
  validator: {
    passed: false,
    checks: [{ name: 'specs', passed: false, detail: 'dropped: 1000 lm' }, ...p.validator.checks.slice(1)],
  },
});

const flagged = {
  model: 'judge-model',
  judge_version: '1',
  verdict: 'finding' as const,
  quote: 'rated at 1000 lm',
  reason: 'rule 4: unverified rating',
};

function card(p: Patch, panel: CardPanel = null) {
  return renderToStaticMarkup(
    <PatchCard
      patch={p}
      storeName="Alpha"
      focused={false}
      panel={panel}
      onPanel={() => {}}
      onFocus={() => {}}
      onDecide={() => {}}
      recTitles={{}}
    />,
  );
}

function tab(f: CatalogFixes | null) {
  return renderToStaticMarkup(
    <FixesTab
      feed={f}
      pending={{}}
      cardNotes={{}}
      paused={f?.paused ?? false}
      pausePending={false}
      selectedStore={ALL_STORES}
      storeNames={{ alpha: 'Alpha' }}
      recTitles={{}}
      onDecide={async () => true}
      onApproveClass={async () => null}
      onPause={() => {}}
    />,
  );
}

describe('diff', () => {
  it('turns HTML into visible text without keeping any markup', () => {
    const html = '<p>One &amp; two</p><script>alert(1)</script><img src=x onerror="alert(2)"><ul><li>1000&nbsp;lm</li></ul>';
    const text = htmlToText(html);
    expect(text).toBe('One & two\n\n• 1000 lm');
    expect(text).not.toMatch(/alert|onerror|</);
  });

  it('diffs by word and keeps unchanged text', () => {
    const ops = diffWords(htmlToText(BEFORE), htmlToText(AFTER));
    expect(ops.filter((o) => o.type === 'del').map((o) => o.text.trim())).toEqual(['with', 'output']);
    expect(ops.filter((o) => o.type === 'ins').map((o) => o.text.trim())).toEqual(['rated at']);
    expect(ops.some((o) => o.type === 'eq' && o.text.includes('1000 lm'))).toBe(true);
    expect(ops.map((o) => (o.type === 'del' ? '' : o.text)).join('')).toBe('A sample light rated at 1000 lm.');
    expect(ops.map((o) => (o.type === 'ins' ? '' : o.text)).join('')).toBe('A sample light with 1000 lm output.');
  });

  it('calls out a dropped figure', () => {
    expect(droppedNumbers('Rated at 1,000 lm for 90 min.', 'Rated at 1000 lm.')).toEqual(['90']);
    expect(droppedNumbers('A sample light with 1000 lm output.', 'A sample light rated at 1000 lm.')).toEqual([]);
  });
});

describe('PatchCard', () => {
  it.each(FIX_STATUSES)('renders a %s patch with its chip and only its actions', (status) => {
    const html = card(patch(ids(1), status));
    expect(html).toContain(`data-status="${status}"`);
    expect(html).toContain(`>${status}<`);
    const actions = actionsFor(status);
    if (actions.length) expect(html).toContain(`data-actions="${actions.join(' ')}"`);
    else expect(html).not.toContain('data-actions');
    expect(html).toContain('Sample Light');
  });

  it('offers only Edit on an invalid patch that failed a deterministic check, and shows why', () => {
    const html = card(specsFailed(patch(ids(1), 'invalid')));
    expect(html).toContain('data-actions="edit"');
    expect(html).not.toContain('Approve');
    expect(html).not.toContain('Reject');
    expect(html).toContain('claim remains');
    expect(html).toContain('dropped: 1000 lm');
  });

  it('offers "Approve over judge" only on judge-only invalid patches, with the flag beside it', () => {
    const judgeOnly = patch(ids(1), 'invalid', { judge: flagged });
    expect(judgeOnlyInvalid(judgeOnly)).toBe(true);
    const html = card(judgeOnly);
    expect(html).toContain('Approve over judge');
    expect(html).toContain('Edit');
    expect(html).toContain('data-judge-flag');
    expect(html).toContain('“rated at 1000 lm”');
    expect(html).toContain('rule 4: unverified rating');
    for (const p of [
      specsFailed(judgeOnly),
      patch(ids(2), 'proposed', { judge: flagged }),
      patch(ids(3), 'approved', { judge: flagged }),
    ]) {
      expect(judgeOnlyInvalid(p)).toBe(false);
      expect(card(p)).not.toContain('Approve over judge');
    }
  });

  it('confirms an approval over the judge inline, showing the flag', () => {
    const html = card(patch(ids(1), 'invalid', { judge: flagged }), 'over-judge');
    expect(html).toContain('Confirm: approve over judge');
    expect(html).toContain('“rated at 1000 lm”');
    expect(html).not.toContain('data-actions');
  });

  it('shows "approved over judge" and "review only" as chips, not errors', () => {
    const over = card(
      patch(ids(1), 'approved', {
        judge: flagged,
        judge_overridden: true,
        edited: true,
        validator: {
          passed: false,
          checks: [
            { name: 'specs', passed: true },
            { name: 'judge', passed: false, detail: 'claim remains' },
          ],
        },
      }),
    );
    expect(over).toContain('approved over judge');
    expect(over).not.toContain('claim remains</li>');
    const review = card(patch(ids(2), 'proposed', { review_only: true }));
    expect(review).toContain('review only: never auto-applied');
    expect(review).toContain(REVIEW_ONLY_TITLE);
    expect(card(patch(ids(3), 'proposed'))).not.toContain('review only');
  });

  it('boxes figures dropped under a judge flag in the diff', () => {
    const p = patch(ids(1), 'proposed', {
      review_only: true,
      changes: [
        {
          field: 'descriptionHtml',
          before: '<p>Rated 99% and 1000 lm.</p>',
          before_sha256: 'b'.repeat(64),
          after: '<p>Rated 1000 lm.</p>',
        },
      ],
      validator: {
        passed: true,
        checks: [
          { name: 'specs', passed: true, detail: `ok: dropped under finding ${'f'.repeat(32)}: 5 W; dropped under judge flag: 99%` },
        ],
      },
    });
    expect(specDrops(p)).toEqual({ finding: ['5 W'], judge: ['99%'], unexempt: [] });
    expect(specDrops(specsFailed(p))).toEqual({ finding: [], judge: [], unexempt: ['1000 lm'] });
    const html = card(p);
    expect(html).toMatch(/data-drop="judge"[^>]*>99%</);
    expect(html).toContain('dashed');
  });

  it('boxes a dropped range when the specs check lists its ends', () => {
    const p = patch(ids(1), 'proposed', {
      changes: [
        { field: 'descriptionHtml', before: '<p>Rated (98-99%) and 1000 lm.</p>', before_sha256: 'b'.repeat(64), after: '<p>Rated 1000 lm.</p>' },
      ],
      validator: { passed: true, checks: [{ name: 'specs', passed: true, detail: 'ok: dropped under judge flag: 98%, 99%' }] },
    });
    expect(card(p)).toMatch(/data-drop="judge"[^>]*>\(98-99%\)</);
  });

  it('offers Revert only for applied, verified and failed-verify', () => {
    for (const s of FIX_STATUSES) {
      expect(card(patch(ids(1), s)).includes('Revert')).toBe(['applied', 'verified', 'failed-verify'].includes(s));
    }
  });

  it('shows the word diff, rationale, checks and judge', () => {
    const html = card(patch(ids(1), 'proposed'));
    expect(html).toContain('Drops the unverified claim.');
    expect(html).toContain('✓ specs');
    expect(html).toContain('judge: clear');
    expect(html).toContain('line-through');
    expect(html).toContain('finding ffffffff');
  });

  it('renders <script> and <img onerror> in the store HTML as inert text', () => {
    const hostile = '<p>Sample</p><script>alert(1)</script><img src=x onerror="alert(2)"><iframe src="https://example.test"></iframe>';
    const p = patch(ids(1), 'proposed', {
      changes: [{ field: 'descriptionHtml', before: hostile, before_sha256: 'b'.repeat(64), after: AFTER }],
    });
    for (const html of [card(p), renderToStaticMarkup(<DiffBody before={hostile} after={AFTER} mode="html" />)]) {
      expect(html).not.toMatch(/<script|<img|<iframe|\sonerror=/i);
    }
    expect(renderToStaticMarkup(<DiffBody before={hostile} after={AFTER} mode="html" />)).toContain('&lt;script&gt;');
  });

  it('marks a decision that is still being recorded and hides the actions', () => {
    const p = patch(ids(1), 'proposed');
    const html = renderToStaticMarkup(
      <PatchCard
        patch={p}
        storeName="Alpha"
        pending={{ action: 'approve', at: 0, fromStatus: 'proposed', fromSha: p.patch_sha256 }}
        cardNote={CHANGED_MESSAGE}
        focused
        panel={null}
        onPanel={() => {}}
        onFocus={() => {}}
        onDecide={() => {}}
        recTitles={{}}
      />,
    );
    expect(html).toContain('approved · recording…');
    expect(html).not.toContain('data-actions');
    expect(html).toContain(CHANGED_MESSAGE);
  });
});

describe('decisions', () => {
  it('approve sends the hash of the patch as displayed', () => {
    const p = patch(ids(7), 'proposed');
    expect(fixRequest('approve', p, { note: '  ok  ' })).toEqual({
      path: `/api/commerce/fixes/${p.id}/approve`,
      body: { patch_sha256: p.patch_sha256, note: 'ok' },
    });
    expect(fixRequest('edit', p, { changes: [{ field: 'descriptionHtml', after: AFTER }] }).body).toEqual({
      patch_sha256: p.patch_sha256,
      changes: [{ field: 'descriptionHtml', after: AFTER }],
    });
    expect(fixRequest('reject', p).body).toEqual({});
  });

  it('"Approve over judge" sends over_judge: true with the displayed hash', () => {
    const p = patch(ids(7), 'invalid', { judge: flagged });
    expect(fixRequest('approve', p, { overJudge: true }).body).toEqual({ patch_sha256: p.patch_sha256, over_judge: true });
    expect(fixRequest('approve', p).body).not.toHaveProperty('over_judge');
  });

  it('a class approval leaves review-only fixes out and says how many', () => {
    const g = groupPatches(
      sortPatches([
        patch(ids(1), 'proposed'),
        patch(ids(2), 'proposed', { review_only: true }),
        patch(ids(3), 'proposed', { review_only: true }),
      ]),
    )[0];
    expect(classApprovable(g, {}).map((p) => p.id)).toEqual([ids(1)]);
    expect(classReviewOnly(g, {})).toBe(2);
    expect(classConfirmText(2)).toBe(`${BULK_NO_STREAK} 2 review-only fixes need a single approval.`);
    expect(classConfirmText(1)).toContain('1 review-only fix needs a single approval.');
    expect(classConfirmText(0)).toBe('These approvals won’t count toward auto-apply.');
    expect(tab(feed(g.patches))).toContain('Approve these 1');
  });

  it('shows a review_only refusal like the other refusal reasons', () => {
    expect(refusalText({ id: ids(2), reason: 'review_only' })).toBe('000000 (review only: approve it on its own)');
    expect(refusalText({ id: ids(2), reason: 'changed' })).toBe('000000 (changed since shown)');
    expect(refusalText({ id: ids(2), reason: 'new_reason' })).toBe('000000 (new_reason)');
  });

  it('a class approval lists exactly the visible proposed patches with their hashes', () => {
    const g = groupPatches(sortPatches([patch(ids(1), 'proposed'), patch(ids(2), 'invalid'), patch(ids(3), 'proposed')]))[0];
    const list = classApprovable(g, { [ids(3)]: { action: 'approve', at: 0, fromStatus: 'proposed', fromSha: '' } });
    expect(approveClassRequest(g.cls, list).body).toEqual({
      store: 'alpha',
      rule: '4',
      field: 'descriptionHtml',
      patches: [{ id: ids(1), patch_sha256: ids(1).padEnd(64, '0') }],
    });
  });

  it('a 409 "changed" reloads the feed and says the fix changed', async () => {
    const reload = vi.fn(async () => {});
    const post = vi.fn(async () => ({ status: 409, body: { reason: 'changed' } }));
    const out = await runDecision(fixRequest('approve', patch(ids(1), 'proposed')), post, reload);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ ok: false, message: CHANGED_MESSAGE, reloaded: true });
  });

  it('a 202 is queued without a reload; a 401 is reported', async () => {
    const reload = vi.fn(async () => {});
    const ok = await runDecision({ path: '/x' }, async () => ({ status: 202, body: { queued: true } }), reload);
    expect(ok.ok).toBe(true);
    const denied = await runDecision({ path: '/x' }, async () => ({ status: 401, body: {} }), reload);
    expect(denied).toMatchObject({ ok: false, reloaded: false });
    expect(reload).not.toHaveBeenCalled();
  });

  it('a pending decision clears once the feed shows a new status or hash', () => {
    const p = patch(ids(1), 'proposed');
    const pending = { [p.id]: { action: 'approve' as const, at: 1000, fromStatus: 'proposed' as const, fromSha: p.patch_sha256 } };
    expect(reconcileFixes(feed([p]), pending, 2000).pending).toEqual(pending);
    expect(reconcileFixes(feed([{ ...p, status: 'approved' }]), pending, 2000).pending).toEqual({});
    expect(reconcileFixes(feed([p]), pending, 1000 + 11 * 60 * 1000)).toEqual({ pending: {}, lost: 1 });
  });
});

describe('FixesTab', () => {
  it('sorts proposed, then invalid, then the rest by decided_at', () => {
    const sorted = sortPatches([
      patch(ids(1), 'rejected', { decided_at: '2026-10-02T07:00:00Z' }),
      patch(ids(2), 'invalid'),
      patch(ids(3), 'approved', { decided_at: '2026-10-02T08:00:00Z' }),
      patch(ids(4), 'proposed'),
    ]);
    expect(sorted.map((p) => p.status)).toEqual(['proposed', 'invalid', 'approved', 'rejected']);
  });

  it('puts waiting review-only fixes first within their class', () => {
    const sorted = sortPatches([
      patch(ids(1), 'proposed'),
      patch(ids(2), 'approved', { review_only: true }),
      patch(ids(3), 'invalid', { review_only: true }),
      patch(ids(4), 'proposed', { review_only: true }),
    ]);
    expect(sorted.map((p) => p.id)).toEqual([ids(3), ids(4), ids(1), ids(2)]);
  });

  it('shows the P1 banner, the writer state and a class group with its count', () => {
    const html = tab(feed([patch(ids(1), 'proposed'), patch(ids(2), 'proposed'), patch(ids(3), 'invalid')]));
    expect(html).toContain(P1_BANNER);
    expect(html).toContain('Writes today: not live');
    expect(html).toContain('Pause writer');
    expect(html).toContain('Alpha · rule 4 · descriptionHtml');
    expect(html).toContain('Approve these 2');
  });

  it('hides the banner once the writer is live and shows a paused switch', () => {
    const live = feed([patch(ids(1), 'proposed')], {
      paused: true,
      writer: { live: true, writes_today: 3, writes_cap: 40, auto_today: 0, auto_cap: 0 },
    });
    const html = tab(live);
    expect(html).not.toContain(P1_BANNER);
    expect(html).toContain('Paused · Resume');
    expect(html).toContain('3 / 40');
  });

  it('class panel is read-only and explains eligibility, with no tier control', () => {
    const html = tab(
      feed([patch(ids(1), 'approved')], {
        classes: [
          { store: 'alpha', rule: '4', field: 'descriptionHtml', streak: 20, approvals: 20, edits: 0, rejects: 0, reverts: 0, tier: 0, eligible: true },
        ],
      }),
    );
    expect(html).toContain('Eligible for auto-apply. That switch is an operator config change, not available here.');
    expect(html).toContain(STREAK_EXPLAINED);
    expect(html).toContain('>Bulk<');
    expect(html).not.toMatch(/set tier|promote|tier 1/i);
  });

  it('says so before the fixer has run', () => {
    expect(tab(null)).toContain('No fixer run yet.');
  });

  it('puts a Fixes tab with the waiting count beside the overview', () => {
    const empty = { data: null, loading: false, error: null };
    const feeds = Object.fromEntries(
      ['ecom_daily', 'ecom_products', 'ecom_seo_health', 'ecom_briefing', 'ecom_recommendations', 'compliance_findings'].map((f) => [f, empty]),
    ) as unknown as FeedStates;
    const fixes: FixesProps = {
      data: feed([patch(ids(1), 'proposed'), patch(ids(2), 'invalid'), patch(ids(3), 'rejected')]),
      loading: false,
      error: null,
      pending: {},
      cardNotes: {},
      paused: false,
      pausePending: false,
      decide: async () => true,
      approveClass: async () => null,
      setPaused: async () => {},
      notice: null,
      clearNotice: () => {},
    };
    const props = {
      feeds,
      pending: {},
      refreshStatus: {},
      selectedStore: ALL_STORES,
      onSelectStore: () => {},
      onRefresh: () => {},
      onDecide: () => {},
      fixes,
    };
    const overview = renderToStaticMarkup(<CommerceView {...props} />);
    expect(overview).toContain('Fixes (2)');
    expect(overview).not.toContain(P1_BANNER);
    expect(renderToStaticMarkup(<CommerceView {...props} initialTab="fixes" />)).toContain(P1_BANNER);
  });
});

describe('operator token', () => {
  it('is never referenced by frontend code', () => {
    const sources = import.meta.glob(['/src/**/*.{ts,tsx}', '!/src/**/*.test.{ts,tsx}'], {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>;
    expect(Object.keys(sources).length).toBeGreaterThan(50);
    for (const [file, src] of Object.entries(sources)) {
      expect(src, file).not.toMatch(/X-Operator-Token|fix-operator-token|HERMES_FIX_TOKEN/i);
    }
  });
});
