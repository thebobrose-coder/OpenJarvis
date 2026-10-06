import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_BEFORE,
  charCount,
  foundryCopyLabel,
  patchSource,
  seoVerifyText,
  type CatalogFixes,
  type ClassStats,
  type FixStatus,
  type Patch,
} from '../../../lib/fixes-api';
import { ALL_STORES } from '../format';
import {
  ELIGIBILITY_RULE,
  FixesTab,
  eligibilityRule,
  panelRule,
  progressText,
  runSummary,
  suggestAt,
  visiblePatches,
  type FixesTabProps,
} from './FixesTab';
import { FOUNDRY_REJECT_HINT, PatchCard, type CardPanel } from './PatchCard';

// Neutral fixtures only: this repo is public. Invented handles, no store copy.
function patch(id: string, status: FixStatus, over: Partial<Patch> = {}): Patch {
  return {
    id,
    patch_sha256: id.padEnd(64, '0'),
    store: 'alpha',
    product_id: '1001',
    product_title: `Sample Item ${id.slice(-2)}`,
    admin_url: 'https://admin.example.test/products/1001',
    fix_class: { store: 'alpha', rule: '4', field: 'descriptionHtml' },
    addresses: { finding_ids: ['f-1'], rec_ids: [] },
    changes: [{ field: 'descriptionHtml', before: '<p>Old text.</p>', before_sha256: 'b'.repeat(64), after: '<p>New text.</p>' }],
    validator: { passed: true, checks: [{ name: 'specs', passed: true }] },
    judge: { verdict: 'clear' },
    status,
    edited: false,
    created_at: '2026-10-06T06:00:00Z',
    decided_at: null,
    note: null,
    history: [{ status: 'proposed', at: '2026-10-06T06:00:00Z' }],
    applied: null,
    verified: null,
    ...over,
  };
}

const TITLE = 'Sample Widget Kit for the Home Workshop'; // 39 characters
const DESCRIPTION =
  'A sample widget kit for the home workshop, with a fitted case, two spare blades and a quick guide to get started.'; // 113 characters

/** A Foundry-copy seo patch: both fields, empty before, the seo profile. */
function seoPatch(id: string, status: FixStatus, over: Partial<Patch> = {}): Patch {
  return patch(id, status, {
    fix_class: { store: 'alpha', rule: 'seo:foundry', field: 'seo.description' },
    source: 'seo',
    checks_profile: 'seo',
    copy_source: { generated_at: '2026-10-06T06:18:13.351Z', source_commit: 'abc1234' },
    addresses: { finding_ids: [], rec_ids: [], seo_issues: ['missing_meta_description', 'title_length'] },
    changes: [
      { field: 'seo.description', before: '', before_sha256: 'b'.repeat(64), after: DESCRIPTION },
      { field: 'seo.title', before: '', before_sha256: 'b'.repeat(64), after: TITLE },
    ],
    validator: {
      passed: true,
      checks: [
        { name: 'length', passed: true, detail: 'seo.description: seo profile: 113 chars (70 to 160)' },
        { name: 'html', passed: true, detail: 'plain text' },
      ],
    },
    ...over,
  });
}

const cls = (over: Partial<ClassStats> = {}): ClassStats => ({
  store: 'alpha',
  rule: '4',
  field: 'descriptionHtml',
  streak: 0,
  approvals: 0,
  edits: 0,
  rejects: 0,
  reverts: 0,
  tier: 0,
  eligible: false,
  ...over,
});

function feed(patches: Patch[], over: Partial<CatalogFixes> = {}): CatalogFixes {
  return {
    generated_at: '2026-10-06T07:00:00Z',
    age_seconds: 60,
    stale: false,
    run_at: '2026-10-06T06:00:00Z',
    paused: false,
    writer: { live: true, writes_today: 3, writes_cap: 50, auto_today: 0, auto_cap: 20, live_since: '2026-10-02T19:00:00Z' },
    counts: {},
    patches,
    classes: [],
    ...over,
  };
}

function tab(f: CatalogFixes, extra: Partial<FixesTabProps> = {}) {
  return renderToStaticMarkup(
    <FixesTab
      feed={f}
      pending={{}}
      cardNotes={{}}
      paused={f.paused}
      pausePending={false}
      selectedStore={ALL_STORES}
      storeNames={{ alpha: 'Alpha', beta: 'Beta' }}
      recTitles={{}}
      onDecide={async () => true}
      onDecideClass={async () => null}
      onPause={() => {}}
      {...extra}
    />,
  );
}

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

describe('seo patches (v1.5, 0011 A16)', () => {
  it('renders seo fields as text with counts and the range; an empty before says so', () => {
    const html = card(seoPatch('a1', 'proposed'));
    expect(html).toContain('data-seo-field="seo.description"');
    expect(html).toContain('data-seo-field="seo.title"');
    expect(html).toContain('70 to 160 characters');
    expect(html).toContain('30 to 65 characters');
    expect(html).toContain(`data-chars="${charCount(DESCRIPTION)}"`);
    expect(html).toContain(`data-chars="${charCount(TITLE)}"`);
    expect(html).toContain(EMPTY_BEFORE);
    expect(html).toContain(TITLE);
    // Never the HTML diff: no Text / HTML source toggle, no inline diff of an empty before.
    expect(html).not.toContain('HTML source');
    expect(html).not.toContain('data-diff=');
  });

  it('shows the text as text, never as markup, and flags a count outside the range', () => {
    const html = card(
      seoPatch('a2', 'proposed', {
        changes: [{ field: 'seo.title', before: 'Old <b>title</b>', before_sha256: 'b'.repeat(64), after: 'Short <i>one</i>' }],
      }),
    );
    expect(html).toContain('Old &lt;b&gt;title&lt;/b&gt;');
    expect(html).not.toContain('<b>title</b>');
    expect(html).toContain('data-chars-off="short"');
    expect(html).toContain('too short');
    // A non-empty before also gets the inline word diff, in plain mode.
    expect(html).toContain('data-diff="plain"');
  });

  it('shows the source, profile, Foundry copy and audit-code chips', () => {
    const html = card(seoPatch('a3', 'proposed'));
    expect(html).toContain('data-source="seo"');
    expect(html).toContain('data-checks-profile="seo"');
    expect(html).toContain('checks: seo');
    expect(html).toContain('Foundry copy 2026-10-06, abc1234');
    expect(html).toContain('data-seo-issue="missing_meta_description"');
    expect(html).toContain('missing meta description');
    expect(html).toContain('title length');
  });

  it('leaves a sentinel patch as it was: HTML diff with the toggle, no counts, no seo chips', () => {
    const html = card(patch('b1', 'proposed', { checks_profile: 'standard' }));
    expect(html).toContain('HTML source');
    expect(html).toContain('data-diff="text"');
    expect(html).toContain('data-source="sentinel"');
    expect(html).not.toContain('data-seo-field');
    expect(html).not.toContain('data-chars');
    expect(html).not.toContain('data-checks-profile');
    expect(html).not.toContain('Foundry copy');
  });

  it('infers the source of an older patch: sentinel with a finding, else rec', () => {
    expect(patchSource({ addresses: { finding_ids: ['f'], rec_ids: [] } })).toBe('sentinel');
    expect(patchSource({ addresses: { finding_ids: [], rec_ids: ['r'] } })).toBe('rec');
    expect(patchSource({ source: 'seo', addresses: { finding_ids: ['f'], rec_ids: [] } })).toBe('seo');
    expect(foundryCopyLabel({ generated_at: '2026-10-06T06:18:13.351Z', source_commit: '2f1f143' })).toBe(
      'Foundry copy 2026-10-06, 2f1f143',
    );
  });

  it('shows the range only when the seo profile ran, counts always', () => {
    const html = card(seoPatch('a4', 'proposed', { checks_profile: 'standard' }));
    expect(html).toContain('data-chars=');
    expect(html).not.toContain('data-seo-range');
  });
});

describe('tier sentence (v1.5 suggest_at)', () => {
  const foundry = cls({ rule: 'seo:foundry', field: 'seo.description', streak: 1, verified: 1, suggest_at: 5 });
  const standard = cls({ streak: 3, verified: 4, suggest_at: 20 });

  it('reads suggest_at: 5 and 20, and falls back by rule for a feed without it', () => {
    expect(suggestAt(foundry)).toBe(5);
    expect(suggestAt(standard)).toBe(20);
    expect(suggestAt(cls({ rule: 'seo:foundry' }))).toBe(5);
    expect(suggestAt(cls({ rule: '7' }))).toBe(20);
    expect(eligibilityRule(5)).toContain('5 single approvals in a row, 5 fixes applied and verified');
    expect(ELIGIBILITY_RULE).toBe(eligibilityRule(20));
  });

  it('the class panel shows each class’s progress against its own threshold', () => {
    const html = tab(feed([], { classes: [foundry, standard] }));
    expect(progressText(foundry)).toBe('1 of 5 in a row · 1 of 5 verified');
    expect(html).toContain('1 of 5 in a row');
    expect(html).toContain('3 of 20 in a row · 4 of 20 verified');
    expect(html).toContain('data-progress="5"');
    expect(html).toContain('Toward auto-apply');
  });

  it('the panel sentence names the lower threshold by rule when classes differ', () => {
    expect(panelRule([standard])).toBe(eligibilityRule(20));
    expect(panelRule([foundry])).toBe(eligibilityRule(5));
    expect(panelRule([foundry, standard])).toBe(`${eligibilityRule(20)} The threshold is 5 for seo:foundry.`);
    expect(panelRule([])).toBe(eligibilityRule(20));
  });
});

describe('seo_verify (v1.5, A16 D2)', () => {
  const applied = { at: '2026-10-06T14:50:58Z', snapshot_id: '78', via: 'operator' as const };

  it('shows a verified reading under the patch, with when and by whom', () => {
    const html = card(
      seoPatch('c1', 'verified', {
        applied,
        verified: { at: '2026-10-06T14:54:50Z', by: 'audit' },
        seo_verify: {
          at: '2026-10-06T14:54:50Z',
          by: 'audit',
          result: 'verified',
          detail: 'seo.description: the page shows the written copy and the audit reports nothing',
          page_cleared: true,
        },
      }),
    );
    expect(html).toContain('data-seo-verify="verified"');
    expect(html).toContain('data-page-cleared="true"');
    expect(html).toContain('Verified by the SEO audit');
    expect(html).toContain('by audit');
  });

  it('says plainly when the page still reports title_length: the theme suffix case', () => {
    const v = {
      at: '2026-10-06T14:54:50Z',
      by: 'audit',
      result: 'still',
      detail:
        'seo.description: the page shows the written copy and the audit reports nothing; seo.title: the page shows the written copy but still reports title_length (page title 72 chars with the theme’s suffix)',
      page_cleared: false,
    };
    const text = seoVerifyText(v);
    expect(text).toContain('Still applied, not verified');
    expect(text).toContain('still reports title length');
    expect(text).toContain('theme adds a suffix');
    const html = card(seoPatch('c2', 'applied', { applied, seo_verify: v }));
    expect(html).toContain('data-seo-verify="still"');
    expect(html).toContain('data-page-cleared="false"');
    // A reading whose result is the status word still reads the detail.
    expect(seoVerifyText({ ...v, result: 'applied' })).toContain('still reports title length');
    expect(seoVerifyText({ at: v.at, result: 'cache' })).toContain('before the write');
    expect(seoVerifyText({ at: v.at, result: 'failed' })).toContain('Failed verification');
  });

  it('shows nothing on a patch that is not applied yet', () => {
    const html = card(seoPatch('c3', 'proposed', { seo_verify: { at: '2026-10-06T14:54:50Z', result: 'verified' } }));
    expect(html).not.toContain('data-seo-verify');
  });
});

describe('Reject on a Foundry-copy patch (v1.5)', () => {
  it('says the product is left skipped and offers Edit first', () => {
    const html = card(seoPatch('d1', 'proposed'), 'reject');
    expect(html).toContain('data-foundry-reject');
    expect(html).toContain(FOUNDRY_REJECT_HINT);
    expect(html).toContain('Edit instead');
    expect(html).toContain('Reject anyway (final)');
  });

  it('a model patch keeps the plain final reject', () => {
    const html = card(patch('d2', 'proposed'), 'reject');
    expect(html).not.toContain('data-foundry-reject');
    expect(html).toContain('Reject (final)');
  });

  it('the editor counts characters for a seo field and diffs it as plain text', () => {
    const html = card(seoPatch('d3', 'proposed'), 'edit');
    expect(html).toContain(`data-chars="${charCount(TITLE)}"`);
    expect(html).toContain('data-diff="plain"');
    expect(html).not.toContain('data-diff="html"');
  });
});

describe('source filter and run summary (v1.5)', () => {
  const patches = [
    patch('e1', 'proposed'),
    patch('e2', 'proposed', { addresses: { finding_ids: [], rec_ids: ['r-1'] } }),
    seoPatch('e3', 'proposed'),
    seoPatch('e4', 'verified'),
  ];
  const all = { store: ALL_STORES, cls: 'all', status: 'all' as const };

  it('filters by source alongside status and class', () => {
    expect(visiblePatches(patches, { ...all, source: 'seo' }).map((p) => p.id)).toEqual(['e3', 'e4']);
    expect(visiblePatches(patches, { ...all, source: 'sentinel' }).map((p) => p.id)).toEqual(['e1']);
    expect(visiblePatches(patches, { ...all, source: 'rec' }).map((p) => p.id)).toEqual(['e2']);
    expect(visiblePatches(patches, { ...all, source: 'seo', status: 'waiting' }).map((p) => p.id)).toEqual(['e3']);
    expect(visiblePatches(patches, { ...all, source: 'all' })).toHaveLength(4);
  });

  it('offers the sources present, with counts', () => {
    const html = tab(feed(patches));
    expect(html).toContain('Source');
    expect(html).toContain('>seo (2)<');
    expect(html).toContain('>sentinel (1)<');
    expect(html).toContain('>rec (1)<');
  });

  it('puts the SEO pass in the run line’s detail', () => {
    const run = {
      run_at: '2026-10-06T16:00:00Z',
      proposed: 7,
      invalid: 1,
      left_for_next_run: 40,
      seo: {
        compliance_first: 2,
        items: { alpha: { 'seo:foundry': 4 }, beta: { 'seo:foundry': 3 } },
        in_stock: 6,
        out_of_stock: 1,
        copy_files: {
          alpha: { generated_at: '2026-10-06T06:18:13.351Z', source_commit: 'abc1234', items: 120 },
          beta: { generated_at: '2026-10-06T06:18:07.427Z', source_commit: 'abc1234', items: 80 },
        },
        title_suffix: { alpha: ' | Alpha', beta: ' - Beta Shop' },
      },
    };
    expect(runSummary(run)).toContain('7 proposed, 1 invalid');
    expect(runSummary(run)).toContain('40 left for the next run');
    const html = tab(feed([], { last_fixer_run: run }));
    expect(html).toContain('data-run-line');
    expect(html).toContain('SEO: 7 items');
    expect(html).toContain('data-run-seo');
    expect(html).toContain('Alpha: 4 seo:foundry');
    expect(html).toContain('In stock 6 · out of stock 1');
    expect(html).toContain('Held behind a compliance finding: 2');
    expect(html).toContain('Alpha: Foundry copy 2026-10-06, abc1234 · 120 items');
    expect(html).toContain('Beta title suffix: “ - Beta Shop” (12 characters)');
  });

  it('shows a run without a seo block as one line', () => {
    const html = tab(feed([], { last_fixer_run: { run_at: '2026-10-06T16:00:00Z', proposed: 2 } }));
    expect(html).toContain('data-run-line');
    expect(html).not.toContain('data-run-seo');
  });
});
