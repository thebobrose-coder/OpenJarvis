import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  FIX_STATUSES,
  actionsFor,
  entryWhy,
  fixRequest,
  isWriterEntry,
  reasonText,
  statusReason,
  tierRequest,
  type AutoFix,
  type CatalogFixes,
  type ClassStats,
  type FixStatus,
  type Patch,
} from '../../../lib/fixes-api';
import type { ComplianceFindings } from '../../../lib/commerce-api';
import { tierOutcome } from '../../../hooks/useCatalogFixes';
import { CompliancePanel, readingsLabel } from '../CompliancePanel';
import { ALL_STORES } from '../format';
import { AutoFixesList, REVERTABLE } from './AutoFixes';
import {
  BLOCKERS_LEAD,
  ELIGIBILITY_RULE,
  FixesTab,
  NO_POLICY,
  TierControl,
  classConfirmNotes,
  demotedNote,
  groupPatches,
  keyAction,
  policyLine,
  sortPatches,
  spotBlockers,
  tierConfirmText,
  writerWarnings,
  type FixesTabProps,
} from './FixesTab';
import { PatchCard, WITHDRAW_QUESTION, type CardPanel } from './PatchCard';

// Neutral fixtures only: this repo is public.
const ids = (n: number) => n.toString(16).padStart(12, '0');
const RULES = 'c'.repeat(64);

function patch(id: string, status: FixStatus, over: Partial<Patch> = {}): Patch {
  return {
    id,
    patch_sha256: id.padEnd(64, '0'),
    store: 'alpha',
    product_id: '1001',
    product_title: `Sample Item ${id.slice(-2)}`,
    admin_url: 'https://admin.example.test/products/1001',
    fix_class: { store: 'alpha', rule: '4', field: 'descriptionHtml' },
    addresses: { finding_ids: [], rec_ids: [] },
    changes: [{ field: 'descriptionHtml', before: '<p>Old text.</p>', before_sha256: 'b'.repeat(64), after: '<p>New text.</p>' }],
    validator: { passed: true, checks: [{ name: 'specs', passed: true }] },
    judge: { verdict: 'clear' },
    status,
    edited: false,
    created_at: '2026-10-02T06:00:00Z',
    decided_at: null,
    note: null,
    history: [{ status: 'proposed', at: '2026-10-02T06:00:00Z' }],
    applied: null,
    verified: null,
    ...over,
  };
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

const liveWriter: CatalogFixes['writer'] = {
  live: true,
  writes_today: 3,
  writes_cap: 50,
  auto_today: 0,
  auto_cap: 20,
  live_since: '2026-10-02T19:00:00Z',
};

function feed(patches: Patch[], over: Partial<CatalogFixes> = {}): CatalogFixes {
  return {
    generated_at: '2026-10-02T07:00:00Z',
    age_seconds: 60,
    stale: false,
    run_at: '2026-10-02T06:00:00Z',
    paused: false,
    writer: liveWriter,
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
      storeNames={{ alpha: 'Alpha' }}
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

describe('writer header (v1.3.4)', () => {
  const now = Date.parse('2026-10-02T20:00:00Z');

  it('names a store whose credentials fail, in amber; ok stores say nothing', () => {
    const w = { ...liveWriter, credentials: { alpha: { ok: false, reason: 'token expired' }, beta: { ok: true } } };
    expect(writerWarnings(w, false, { alpha: 'Alpha' }, now)).toEqual(['Alpha: token expired']);
    const ok = { ...liveWriter, credentials: { alpha: { ok: true } } };
    expect(writerWarnings(ok, false, {}, now)).toEqual([]);
    const html = tab(feed([], { writer: w }));
    expect(html).toMatch(/data-writer-warning="true"[^>]*color:var\(--color-warning\)[^>]*>Alpha: token expired</);
  });

  it('says when the writer disagrees with the pause', () => {
    expect(writerWarnings({ ...liveWriter, paused_writer: true }, false, {}, now)).toEqual(['Writer still sees pause']);
    expect(writerWarnings({ ...liveWriter, paused_writer: false }, true, {}, now)).toEqual([
      'Writer hasn’t seen pause yet',
    ]);
    expect(writerWarnings({ ...liveWriter, paused_writer: true }, true, {}, now)).toEqual([]);
  });

  it('flags a writer status older than 10 minutes', () => {
    expect(writerWarnings({ ...liveWriter, status_at: '2026-10-02T19:45:00Z' }, false, {}, now)).toEqual([
      'writer status 15 min old',
    ]);
    expect(writerWarnings({ ...liveWriter, status_at: '2026-10-02T19:55:00Z' }, false, {}, now)).toEqual([]);
  });
});

describe('history reason (v1.3.4)', () => {
  it('reads reason before note, in words', () => {
    expect(entryWhy({ status: 'invalid', at: 'x', reason: 'stale', note: 'the writer refused it: stale' })).toBe(
      'the live copy changed since the fix was made',
    );
    expect(entryWhy({ status: 'approved', at: 'x', note: 'looks right' })).toBe('looks right');
  });

  it('shows checks_failed as the check names, and an unknown code as is', () => {
    expect(reasonText('checks_failed:specs,html')).toBe('checks failed: specs, HTML');
    expect(reasonText('checks_failed:fresh_before')).toBe('check failed: current copy');
    expect(reasonText('brand_new_code')).toBe('brand_new_code');
    expect(reasonText('auto_refused:checks_failed:specs')).toBe('auto-apply refused: check failed: specs');
  });

  it('an entry with reason is the writer’s and is what "Why invalid" shows', () => {
    const p = patch(ids(1), 'invalid', {
      history: [
        { status: 'approved', at: '2026-10-02T07:00:00Z' },
        { status: 'invalid', at: '2026-10-02T08:00:00Z', note: 'refused', reason: 'checks_failed:specs,html' },
      ],
    });
    expect(isWriterEntry(p.history[1])).toBe(true);
    expect(statusReason(p)).toBe('checks failed: specs, HTML');
    const html = card(p);
    expect(html).toContain('Why invalid: checks failed: specs, HTML');
    expect(html).toMatch(/data-writer-entry="true"[^>]*title="refused"/);
  });

  it('falls back to the "writer refused" note only for older entries', () => {
    expect(isWriterEntry({ status: 'invalid', at: 'x', note: 'the writer refused it: stale' })).toBe(true);
    expect(isWriterEntry({ status: 'approved', at: 'x', note: 'operator note' })).toBe(false);
  });
});

describe('spot-check blockers (v1.3.4)', () => {
  const patches = [
    patch(ids(1), 'confirm'),
    patch(ids(2), 'confirm', { drops_figure: true }),
    patch(ids(3), 'confirm'),
    patch(ids(4), 'proposed'),
  ];

  it('names the blockers as links to their cards, and sorts those cards first', () => {
    const stats = cls({ spot_check: { confirmed: 6, required: 5, passed: false, blockers: [ids(3)] } });
    const g = groupPatches(sortPatches(patches))[0];
    // The inference (ids(2) drops a figure) gives way to Hermes's list.
    expect(classConfirmNotes(g, {}, stats)).toEqual(['Spot-check: confirmed 6 of 5.']);
    expect(spotBlockers([stats], patches)).toEqual(new Set([ids(3)]));
    expect(sortPatches(patches, spotBlockers([stats], patches))[0].id).toBe(ids(3));
    const html = tab(feed(patches, { classes: [stats] }));
    expect(html).toContain(BLOCKERS_LEAD);
    expect(html).toMatch(new RegExp(`href="#fix-${ids(3)}" data-blocker="${ids(3)}"[^>]*>Sample Item 03<`));
    expect(html.indexOf(`id="fix-${ids(3)}"`)).toBeLessThan(html.indexOf(`id="fix-${ids(1)}"`));
  });

  it('an empty list with the count still short says only the count', () => {
    const stats = cls({ spot_check: { confirmed: 2, required: 5, passed: false, blockers: [] } });
    const g = groupPatches(sortPatches(patches))[0];
    expect(classConfirmNotes(g, {}, stats)).toEqual([
      'Spot-check: confirmed 2 of 5. Confirm one at a time until it passes.',
    ]);
    expect(tab(feed(patches, { classes: [stats] }))).not.toContain(BLOCKERS_LEAD);
  });

  it('infers figure-droppers only for a feed without the key', () => {
    const stats = cls({ spot_check: { confirmed: 2, required: 5, passed: false } });
    expect(spotBlockers([stats], patches)).toEqual(new Set([ids(2)]));
    const g = groupPatches(sortPatches(patches))[0];
    expect(classConfirmNotes(g, {}, stats)).toContain('1 figure-dropping fix is waiting; confirm those one at a time.');
  });
});

describe('Reject on confirm (v1.3.4)', () => {
  it('a confirm card offers Reject, worded as withdrawing the approval', () => {
    expect(actionsFor('confirm')).toEqual(['confirm', 'reject']);
    const html = card(patch(ids(1), 'confirm'), 'reject');
    expect(html).toContain(WITHDRAW_QUESTION);
    expect(html).toContain('data-withdraw');
    expect(card(patch(ids(2), 'proposed'), 'reject')).not.toContain(WITHDRAW_QUESTION);
  });

  it('uses the existing reject key and route', () => {
    expect(keyAction('r', 'confirm')).toBe('reject');
    for (const s of FIX_STATUSES) expect(keyAction('r', s)).toBe(s === 'proposed' || s === 'confirm' ? 'reject' : null);
    expect(fixRequest('reject', patch(ids(1), 'confirm'), { note: 'no' })).toEqual({
      path: `/api/commerce/fixes/${ids(1)}/reject`,
      body: { note: 'no' },
    });
  });
});

describe('chips (v1.4)', () => {
  it('marks auto-applied fixes and auto candidates', () => {
    const auto = card(patch(ids(1), 'applied', { applied: { at: 'x', snapshot_id: 's', via: 'auto' } }));
    expect(auto).toContain('>auto<');
    expect(card(patch(ids(2), 'proposed', { auto_candidate: true }))).toContain('>auto candidate<');
    const op = card(patch(ids(3), 'applied', { applied: { at: 'x', snapshot_id: 's', via: 'operator' } }));
    expect(op).not.toContain('>auto<');
  });
});

describe('advisory findings (v1.4, A12)', () => {
  const finding = { property: 'prop-a', location: 'Sample Item', field: 'descriptionHtml', quote: 'Rated 5 W' };
  const doc: ComplianceFindings = {
    generated_at: '2026-10-02T07:00:00Z',
    age_seconds: 60,
    stale: false,
    run_at: '2026-10-02T07:00:00Z',
    counts: { open: 3, advisory: 2, open_by_property: { 'prop-a': 3 } },
    open_findings: [{ id: 'a'.repeat(32), ...finding, readings: { flagged: 2, of: 3 } }],
    advisory_findings: [
      { id: 'b'.repeat(32), ...finding, advisory_reason: 'spec_carried_over', patch_id: ids(7) },
      { id: 'c'.repeat(32), ...finding, advisory_reason: 'other_reason' },
    ],
  };

  it('lists them collapsed, with the chip and a link to the patch, outside the open count', () => {
    const html = renderToStaticMarkup(<CompliancePanel findings={doc} onOpenFix={() => {}} />);
    expect(html).toMatch(/<details[^>]*data-advisory="true"/);
    expect(html).not.toMatch(/<details open=""[^>]*data-advisory/);
    expect(html).toContain('Advisory (2)');
    expect(html).toContain('advisory: spec carried over');
    expect(html).toContain('advisory: other_reason');
    expect(html).toContain(`data-open-fix="${ids(7)}"`);
    // The open count stays the feed's own (advisory adds nothing to it).
    expect(html).toMatch(/data-open-count="true"[^>]*>3 open findings</);
  });

  it('shows majority readings as "2 of 3 readings"', () => {
    expect(readingsLabel({ flagged: 2, of: 3 })).toBe('2 of 3 readings');
    expect(renderToStaticMarkup(<CompliancePanel findings={doc} />)).toContain('2 of 3 readings');
  });
});

describe('tier control (v1.4, A13/A14)', () => {
  const eligible = cls({ eligible: true, streak: 22, verified: 21, rules_sha256: RULES, streak_since: '2026-10-02T08:00:00Z' });
  const policy = { exists: true, updated_at: '2026-10-02T12:00:00Z', classes: [] };
  const allow = (html: string) => html.match(/data-tier-allow="(\w+)"><button([^>]*)>/);

  it('the panel shows the A14 sentence, the streak start, and the tier columns', () => {
    expect(ELIGIBILITY_RULE).toBe(
      'Suggest auto-apply when: 20 single approvals in a row, 20 fixes applied and verified, and no revert or failed verification since the streak began.',
    );
    const html = tab(feed([], { classes: [{ ...eligible, auto_applied: 4 }] }), { policy, onSetTier: async () => true });
    expect(html).toContain(ELIGIBILITY_RULE);
    expect(html).toContain('streak since ');
    for (const h of ['Tier', 'Policy tier', 'Auto applied', 'Reverted', 'Failed verify']) expect(html).toContain(`>${h}<`);
    expect(html).toMatch(/data-tier="0"/);
    expect(html).toMatch(/data-policy-tier="0"/);
  });

  it('Allow auto-apply is enabled only while the class is eligible', () => {
    const on = tab(feed([], { classes: [eligible] }), { policy, onSetTier: async () => true });
    expect(allow(on)?.[1]).toBe('enabled');
    expect(allow(on)?.[2]).not.toContain('disabled=""');
    const off = tab(feed([], { classes: [{ ...eligible, eligible: false }] }), { policy, onSetTier: async () => true });
    expect(allow(off)?.[1]).toBe('disabled');
    expect(allow(off)?.[2]).toContain('disabled=""');
  });

  it('the control sits beside the class name, before Streak, with no blank trailing column', () => {
    const html = tab(feed([], { classes: [eligible] }), { policy, onSetTier: async () => true });
    const headers = [...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
    expect(headers.slice(0, 5)).toEqual(['Store', 'Rule', 'Field', 'Auto-apply', 'Streak']);
    expect(headers).not.toContain('');
    const row = html.slice(html.indexOf('data-class='), html.indexOf('</tr>', html.indexOf('data-class=')));
    expect(row.indexOf('data-tier-allow')).toBeGreaterThan(-1);
    expect(row.indexOf('data-tier-allow')).toBeLessThan(row.indexOf('>22<'));
    expect(row).toContain('Eligible: see Auto-apply');
  });

  it('the inline confirm names the class and the caps', () => {
    const html = renderToStaticMarkup(
      <TierControl c={eligible} label="Alpha · rule 4 · descriptionHtml" listed={false} busy={false} onSetTier={async () => true} startAsking />,
    );
    const text = tierConfirmText('Alpha · rule 4 · descriptionHtml');
    expect(text).toBe(
      'Allow auto-apply for Alpha · rule 4 · descriptionHtml? Up to 20 a day are applied without asking, within 50 per store and 1 per product. Any revert or failed verification turns it off.',
    );
    expect(html).toContain('Up to 20 a day are applied without asking, within 50 per store and 1 per product.');
    expect(html).toContain('Confirm: allow auto-apply');
  });

  it('Turn off is always enabled for a listed class, eligible or not', () => {
    const listed = { ...policy, classes: [{ store: 'alpha', rule: '4', field: 'descriptionHtml', tier: 1 as const, since: 'x', rules_sha256: RULES }] };
    const html = tab(feed([], { classes: [cls({ tier: 1, policy_tier: 1 })] }), { policy: listed, onSetTier: async () => true });
    expect(html).toMatch(/data-tier-off="true"><button(?![^>]*disabled="")/);
    expect(html).not.toContain('data-tier-allow');
    expect(html).toMatch(/data-policy-tier="1"/);
  });

  it('a demoted class shows why and offers the raise again only when eligible', () => {
    const listed = { ...policy, classes: [{ store: 'alpha', rule: '4', field: 'descriptionHtml', tier: 1 as const, since: 'x', rules_sha256: RULES }] };
    const demoted = cls({ policy_tier: 1, tier: 0, demoted: { at: '2026-10-02T09:00:00Z', reason: 'revert' } });
    const html = tab(feed([], { classes: [demoted] }), { policy: listed, onSetTier: async () => true });
    expect(demotedNote(demoted.demoted!)).toMatch(/^Demoted: a revert /);
    expect(html).toContain('Demoted: a revert');
    expect(allow(html)?.[1]).toBe('disabled');
    expect(html).toContain('data-tier-off');
  });

  it('reads the policy file’s state', () => {
    expect(policyLine({ exists: false, updated_at: null, classes: [] })).toBe(NO_POLICY);
    expect(policyLine(policy)).toMatch(/^Auto-fix policy updated /);
    expect(tab(feed([], { classes: [eligible] }), { policy: { exists: false, updated_at: null, classes: [] } })).toContain(
      'No class auto-applies',
    );
  });

  it('goes to OpenJarvis’s own policy route, never a Hermes fixes route', () => {
    expect(tierRequest(eligible, 1, ' ok ')).toEqual({
      path: '/api/commerce/fixes/policy',
      body: { store: 'alpha', rule: '4', field: 'descriptionHtml', tier: 1, rules_sha256: RULES, note: 'ok' },
    });
    expect(tierRequest(eligible, 0)).toEqual({
      path: '/api/commerce/fixes/policy',
      body: { store: 'alpha', rule: '4', field: 'descriptionHtml', tier: 0 },
    });
  });

  it('says why a tier change was refused', () => {
    expect(tierOutcome({ status: 200, body: {} })).toBeNull();
    expect(tierOutcome({ status: 409, body: { detail: { reason: 'not_eligible' } } })).toBe(
      'Not changed: the class isn’t eligible in the latest feed.',
    );
    expect(tierOutcome({ status: 403, body: { detail: 'Only from this machine' } })).toBe('Only from this machine');
  });
});

describe('auto-applied fixes in the digest (v1.4)', () => {
  const fixes: AutoFix[] = [ids(1), ids(2), ids(3), ids(4)].map((id) => ({
    patch_id: id,
    store: 'alpha',
    product_title: `Sample Item ${id.slice(-2)}`,
    admin_url: 'https://admin.example.test/products/1001',
    fix_class: { store: 'alpha', rule: '4', field: 'descriptionHtml' },
    applied_at: '2026-10-03T05:00:00Z',
  }));

  it('lists each with class and time, and offers Revert only on the three statuses', () => {
    expect(REVERTABLE).toEqual(['applied', 'verified', 'failed-verify']);
    const statuses: Record<string, FixStatus> = { [ids(1)]: 'applied', [ids(2)]: 'verified', [ids(3)]: 'failed-verify', [ids(4)]: 'reverted' };
    const html = renderToStaticMarkup(<AutoFixesList fixes={fixes} statuses={statuses} onRevert={() => {}} />);
    expect(html).toContain('Fixes applied automatically (4)');
    expect(html).toContain('rule 4 · descriptionHtml');
    for (const [id, revert] of [
      [ids(1), true],
      [ids(2), true],
      [ids(3), true],
      [ids(4), false],
    ] as const) {
      const item = html.split(`data-auto-fix="${id}"`)[1].split('</li>')[0];
      expect(item.includes('Revert'), id).toBe(revert);
    }
    // Unknown to the feed: no Revert.
    expect(renderToStaticMarkup(<AutoFixesList fixes={fixes.slice(0, 1)} statuses={{}} onRevert={() => {}} />)).not.toContain(
      'Revert',
    );
  });

  it('renders nothing with no auto-fixes', () => {
    expect(renderToStaticMarkup(<AutoFixesList fixes={[]} statuses={{}} onRevert={() => {}} />)).toBe('');
  });
});
