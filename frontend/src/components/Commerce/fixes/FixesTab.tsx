import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCheck, Pause, Play, Wrench, X } from 'lucide-react';
import {
  FIX_SOURCES,
  FIX_STATUSES,
  type AutofixPolicy,
  REFUSAL_REASON,
  charCount,
  foundryCopyLabel,
  isWaiting,
  needsOperator,
  patchSource,
  type CatalogFixes,
  type ClassAction,
  type ClassStats,
  type FixAction,
  type FixClass,
  type FixSource,
  type FixStatus,
  type FixerRun,
  type FixerSeoRun,
  type Patch,
} from '../../../lib/fixes-api';
import type { ClassResult, PendingFix } from '../../../hooks/useCatalogFixes';
import { DashboardPanel } from '../../Dashboard/DashboardPanel';
import { FeedFreshness } from '../../Dashboard/FeedFreshness';
import { Chip, Quiet, Select, SmallButton } from '../../shared/ui';
import { ALL_STORES, num, shortDateTime } from '../format';
import { PatchCard, type CardPanel, type DecideOpts } from './PatchCard';

export const P1_BANNER = 'Proposals only. Decisions are recorded; nothing is written to Shopify yet.';

const ORDER: Record<string, number> = { proposed: 0, invalid: 1, confirm: 2 };
const DECIDED = 3;

export const classKey = (c: FixClass) => `${c.store}|${c.rule}|${c.field}`;

/** The P1 approvals to confirm one at a time before a class's spot-check
 * can pass (A9). v1.3.4 names them in `spot_check.blockers`; a feed without
 * the key falls back to inferring them: the class's figure-dropping
 * `confirm` patches. */
export function spotBlockers(classes: ClassStats[] | undefined, patches: Patch[] | undefined): Set<string> {
  const ids = new Set<string>();
  for (const c of classes ?? []) {
    const spot = c.spot_check;
    if (!spot || spot.passed) continue;
    if (Array.isArray(spot.blockers)) spot.blockers.forEach((id) => ids.add(id));
    else
      (patches ?? [])
        .filter((p) => p.status === 'confirm' && p.drops_figure && classKey(p.fix_class) === classKey(c))
        .forEach((p) => ids.add(p.id));
  }
  return ids;
}

// What needs a single decision leads: a waiting review-only fix (A7), and a
// spot-check blocker to confirm (A9).
function rank(p: Patch, blockers: Set<string>): number {
  if (p.review_only && needsOperator(p.status)) return -1;
  if (p.status === 'confirm' && blockers.has(p.id)) return -1;
  return ORDER[p.status] ?? DECIDED;
}

/** Single-decision fixes first, then proposed, invalid, to confirm, then the
 * rest by most recently decided. */
export function sortPatches(patches: Patch[], blockers: Set<string> = new Set()): Patch[] {
  return [...patches].sort((a, b) => {
    const oa = rank(a, blockers);
    const ob = rank(b, blockers);
    if (oa !== ob) return oa - ob;
    if (oa === DECIDED) return (b.decided_at ?? '').localeCompare(a.decided_at ?? '');
    return a.created_at.localeCompare(b.created_at);
  });
}
export const ruleLabel = (rule: string) => (/^\d+$/.test(rule) ? `rule ${rule}` : rule);

export interface FixGroup {
  key: string;
  cls: FixClass;
  patches: Patch[];
}

/** Patches grouped by fix class, groups in the order their first patch sorts. */
export function groupPatches(sorted: Patch[]): FixGroup[] {
  const groups = new Map<string, FixGroup>();
  for (const p of sorted) {
    const key = classKey(p.fix_class);
    if (!groups.has(key)) groups.set(key, { key, cls: p.fix_class, patches: [] });
    groups.get(key)!.patches.push(p);
  }
  return [...groups.values()];
}

const openProposed = (group: FixGroup, pending: Record<string, PendingFix>) =>
  group.patches.filter((p) => p.status === 'proposed' && !pending[p.id]);

/** The class approval: only the visible, proposed, not-yet-decided patches.
 * Review-only ones need a single approval each (v1.3.2 A7), so stay out. */
export function classApprovable(group: FixGroup, pending: Record<string, PendingFix>): Patch[] {
  return openProposed(group, pending).filter((p) => !p.review_only);
}

/** Proposed review-only fixes the class approval leaves out. */
export const classReviewOnly = (group: FixGroup, pending: Record<string, PendingFix>) =>
  openProposed(group, pending).filter((p) => p.review_only).length;

const openConfirm = (group: FixGroup, pending: Record<string, PendingFix>) =>
  group.patches.filter((p) => p.status === 'confirm' && !pending[p.id]);

/** The class confirm (A9): the P1 approvals waiting to be re-confirmed,
 * review-only ones left out (they're always confirmed one at a time). */
export const classConfirmable = (group: FixGroup, pending: Record<string, PendingFix>) =>
  openConfirm(group, pending).filter((p) => !p.review_only);

const plural = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

/** The spot-check blockers Hermes names (v1.3.4), or null for a feed
 * without the key. */
export const namedBlockers = (stats?: ClassStats): string[] | null => {
  const spot = stats?.spot_check;
  if (!spot || spot.passed) return null;
  return Array.isArray(spot.blockers) ? spot.blockers : null;
};

export const BLOCKERS_LEAD = 'Confirm these singly first:';

/** What the class confirm says: the spot-check's state while it hasn't
 * passed, and what must still be confirmed singly. Blockers Hermes names
 * are listed separately, as links (see BLOCKERS_LEAD). */
export function classConfirmNotes(group: FixGroup, pending: Record<string, PendingFix>, stats?: ClassStats): string[] {
  const open = openConfirm(group, pending);
  const notes: string[] = [];
  const spot = stats?.spot_check;
  const named = namedBlockers(stats);
  if (spot && !spot.passed) {
    const counted = `Spot-check: confirmed ${spot.confirmed} of ${spot.required}`;
    if (spot.confirmed < spot.required) notes.push(`${counted}. Confirm one at a time until it passes.`);
    else if (named) notes.push(`${counted}.`);
    // Past the count, what's missing is a figure-dropping P1 approval
    // confirmed on its own (A9).
    else notes.push(`${counted}, but each figure-dropping approval must also be confirmed one at a time.`);
  }
  // Only without Hermes's list: infer the figure-droppers ourselves.
  const figures = named ? 0 : open.filter((p) => p.drops_figure && !p.review_only).length;
  if (figures) {
    notes.push(
      `${plural(figures, 'figure-dropping fix is', 'figure-dropping fixes are')} waiting; confirm those one at a time.`,
    );
  }
  const reviewOnly = open.filter((p) => p.review_only).length;
  if (reviewOnly) notes.push(`${plural(reviewOnly, 'review-only fix needs', 'review-only fixes need')} a single confirm.`);
  return notes;
}

/** The A14 sentence with the class's own threshold (v1.5 `suggest_at`). */
export const eligibilityRule = (n: number) =>
  `Suggest auto-apply when: ${n} single approvals in a row, ${n} fixes applied and verified, and no revert or failed verification since the streak began.`;
export const ELIGIBILITY_RULE = eligibilityRule(20);

/** A class's threshold: the feed's `suggest_at`, else 5 for `seo:foundry`
 * and 20 otherwise (contract v1.5, A16 D1). */
export const suggestAt = (c: Pick<ClassStats, 'suggest_at' | 'rule'>) =>
  c.suggest_at ?? (c.rule === 'seo:foundry' ? 5 : 20);

/** The class's progress toward the suggestion: "1 of 5 in a row · 1 of 5 verified". */
export function progressText(c: ClassStats): string {
  const n = suggestAt(c);
  return `${num(c.streak)} of ${n} in a row · ${num(c.verified ?? 0)} of ${n} verified`;
}

/** The panel's sentence: one threshold when every class shares it, else
 * the highest one with the lower ones named by rule. */
export function panelRule(classes: ClassStats[]): string {
  const ns = [...new Set(classes.map(suggestAt))].sort((a, b) => b - a);
  if (ns.length <= 1) return eligibilityRule(ns[0] ?? 20);
  const lower = ns.slice(1).map((n) => {
    const rules = [...new Set(classes.filter((c) => suggestAt(c) === n).map((c) => ruleLabel(c.rule)))];
    return `${n} for ${rules.join(', ')}`;
  });
  return `${eligibilityRule(ns[0])} The threshold is ${lower.join('; ')}.`;
}

/** The fixer's last run in a line; v1.5 adds the SEO pass as detail. */
export function runSummary(run: FixerRun): string {
  const parts = [`Fixer ran ${shortDateTime(run.run_at)}`];
  if (run.proposed != null) parts.push(`${num(run.proposed)} proposed${run.invalid ? `, ${num(run.invalid)} invalid` : ''}`);
  if (run.left_for_next_run) parts.push(`${num(run.left_for_next_run)} left for the next run`);
  return parts.join(' · ');
}

const seoItemCount = (seo: FixerSeoRun) =>
  Object.values(seo.items ?? {}).reduce((n, byRule) => n + Object.values(byRule).reduce((a, b) => a + b, 0), 0);

function RunLine({ run, storeNames }: { run: FixerRun; storeNames: Record<string, string> }) {
  const seo = run.seo;
  if (!seo) return <span data-run-line>{runSummary(run)}</span>;
  const name = (s: string) => storeNames[s] ?? s;
  return (
    <details data-run-line>
      <summary className="cursor-pointer">
        {runSummary(run)} · SEO: {num(seoItemCount(seo))} items
      </summary>
      <ul className="mt-1 flex flex-col gap-0.5" data-run-seo style={{ color: 'var(--color-text-tertiary)' }}>
        {Object.entries(seo.items ?? {}).map(([store, byRule]) => (
          <li key={store}>
            {name(store)}:{' '}
            {Object.entries(byRule)
              .map(([rule, n]) => `${num(n)} ${rule}`)
              .join(', ')}
          </li>
        ))}
        {(seo.in_stock != null || seo.out_of_stock != null) && (
          <li>
            In stock {num(seo.in_stock ?? 0)} · out of stock {num(seo.out_of_stock ?? 0)}
          </li>
        )}
        {seo.compliance_first != null && <li>Held behind a compliance finding: {num(seo.compliance_first)}</li>}
        {Object.entries(seo.copy_files ?? {}).map(([store, f]) => (
          <li key={store}>
            {name(store)}: {foundryCopyLabel(f)}
            {f.items != null ? ` · ${num(f.items)} items` : ''}
          </li>
        ))}
        {Object.entries(seo.title_suffix ?? {}).map(([store, s]) => (
          <li key={store}>
            {name(store)} title suffix: “{s}” ({charCount(s)} characters)
          </li>
        ))}
      </ul>
    </details>
  );
}

/** The writer line in the header (v1.3.3). */
export function writerLine(w: CatalogFixes['writer']): string {
  if (!w.live) return 'Writer not live';
  const since = w.live_since ? ` since ${shortDateTime(w.live_since)}` : '';
  return `Writer live${since} · ${num(w.writes_today)}/${w.writes_cap ?? '—'} today`;
}

const STATUS_OLD_MS = 10 * 60 * 1000;

/** The writer's own status, in amber, when something needs a look
 * (v1.3.4): a store whose credentials fail, a pause the writer hasn't
 * caught up with, and a status more than 10 minutes old. */
export function writerWarnings(
  w: CatalogFixes['writer'],
  paused: boolean,
  storeNames: Record<string, string>,
  now: number = Date.now(),
): string[] {
  const out: string[] = [];
  for (const [store, c] of Object.entries(w.credentials ?? {})) {
    if (c && c.ok === false) out.push(`${storeNames[store] ?? store}: ${c.reason || 'credentials failing'}`);
  }
  if (typeof w.paused_writer === 'boolean' && w.paused_writer !== paused) {
    out.push(w.paused_writer ? 'Writer still sees pause' : 'Writer hasn’t seen pause yet');
  }
  if (w.status_at) {
    const age = now - Date.parse(w.status_at);
    if (age > STATUS_OLD_MS) out.push(`writer status ${Math.floor(age / 60000)} min old`);
  }
  return out;
}

export const PAUSE_TITLE = {
  running: 'Pause stops the writer applying fixes. Reverts still run (0011 A1).',
  paused: 'The writer is paused: it applies nothing, but reverts still run (0011 A1). Resume lets it apply again.',
};

export const BULK_NO_STREAK = 'These approvals won’t count toward auto-apply.';
export const STREAK_EXPLAINED = 'Counts only fixes approved one at a time, unedited.';

export const tierConfirmText = (label: string) =>
  `Allow auto-apply for ${label}? Up to 20 a day are applied without asking, within 50 per store and 1 per product. Any revert or failed verification turns it off.`;

export const NO_POLICY = 'No class auto-applies';

/** The policy file's line on the class panel. */
export function policyLine(policy: AutofixPolicy | null | undefined): string {
  if (!policy) return 'Auto-fix policy file: not available here';
  if (!policy.exists) return NO_POLICY;
  return `Auto-fix policy updated ${policy.updated_at ? shortDateTime(policy.updated_at) : '—'}`;
}

/** Whether the policy file lists the class (the file is the truth; the
 * feed's `policy_tier` catches up at its next rewrite). */
export function inPolicy(c: ClassStats, policy: AutofixPolicy | null | undefined): boolean {
  if (policy) return policy.classes.some((p) => classKey(p) === classKey(c));
  return c.policy_tier === 1;
}

const DEMOTE_WORDS: Record<string, string> = {
  revert: 'a revert',
  failed_verify: 'a failed verification',
  rules_changed: 'the rules changed',
};

export const demotedNote = (d: NonNullable<ClassStats['demoted']>) =>
  `Demoted: ${DEMOTE_WORDS[d.reason] ?? d.reason} ${shortDateTime(d.at)}`;

/** What the class-approval confirm says beside its button. */
export function classConfirmText(reviewOnly: number): string {
  if (!reviewOnly) return BULK_NO_STREAK;
  const n = reviewOnly === 1 ? '1 review-only fix needs' : `${reviewOnly} review-only fixes need`;
  return `${BULK_NO_STREAK} ${n} a single approval.`;
}

export const refusalText = (r: { id: string; reason: string }) =>
  `${r.id.slice(0, 6)} (${REFUSAL_REASON[r.reason] ?? r.reason})`;

export const waitingCount = (feed: CatalogFixes | null) =>
  feed ? (feed.counts.proposed ?? 0) + (feed.counts.invalid ?? 0) + (feed.counts.confirm ?? 0) : 0;

export type StatusFilter = 'all' | 'waiting' | FixStatus;
export type SourceFilter = 'all' | FixSource;

export interface FixFilter {
  store: string;
  cls: string;
  status: StatusFilter;
  source: SourceFilter;
}

/** The patches the filters leave visible. v1.5 adds `source`, so the
 * operator can review the seo queue on its own. */
export function visiblePatches(patches: Patch[], f: FixFilter): Patch[] {
  return patches.filter(
    (p) =>
      (f.store === ALL_STORES || p.store === f.store) &&
      (f.cls === 'all' || classKey(p.fix_class) === f.cls) &&
      (f.status === 'all' || (f.status === 'waiting' ? needsOperator(p.status) : p.status === f.status)) &&
      (f.source === 'all' || patchSource(p) === f.source),
  );
}

/** What a key does on the focused card: a approve and r reject a proposal,
 * e edits a waiting fix, c confirms a P1 approval. Approve over judge has
 * no key (A6). */
export function keyAction(key: string, status: FixStatus): Exclude<FixAction, 'revert'> | null {
  if (key === 'a' && status === 'proposed') return 'approve';
  if (key === 'e' && isWaiting(status)) return 'edit';
  if (key === 'r' && (status === 'proposed' || status === 'confirm')) return 'reject';
  if (key === 'c' && status === 'confirm') return 'confirm';
  return null;
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

function FixesHeader({
  feed,
  paused,
  pausePending,
  onPause,
  storeNames,
}: {
  feed: CatalogFixes;
  paused: boolean;
  pausePending: boolean;
  onPause: (paused: boolean) => void;
  storeNames: Record<string, string>;
}) {
  const w = feed.writer;
  const warnings = writerWarnings(w, paused, storeNames);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[11.5px]" style={{ color: 'var(--color-text-secondary)' }}>
      <SmallButton
        tone={paused ? 'warning' : 'neutral'}
        onClick={() => onPause(!paused)}
        disabled={pausePending}
        title={paused ? PAUSE_TITLE.paused : PAUSE_TITLE.running}
      >
        {paused ? <Play size={11} /> : <Pause size={11} />}
        {paused ? 'Paused · Resume' : 'Pause writer'}
      </SmallButton>
      {pausePending && <span style={{ color: 'var(--color-text-tertiary)' }}>recording…</span>}
      <span data-writer={w.live ? 'live' : 'off'}>{writerLine(w)}</span>
      {warnings.map((t) => (
        <span key={t} data-writer-warning style={{ color: 'var(--color-warning)' }}>
          {t}
        </span>
      ))}
      {feed.last_fixer_run && <RunLine run={feed.last_fixer_run} storeNames={storeNames} />}
      <FeedFreshness ageSeconds={feed.age_seconds} stale={feed.stale} staleAfterSeconds={26 * 3600} label="Fixes" />
    </div>
  );
}

/** The tier control for one class (v1.4, 0011 A13): Allow auto-apply only
 * while the feed says it's eligible, behind an inline confirm; Turn off
 * always. Both write the policy file through OpenJarvis's backend. */
export function TierControl({
  c,
  label,
  listed,
  busy,
  onSetTier,
  startAsking = false,
}: {
  c: ClassStats;
  label: string;
  listed: boolean;
  busy: boolean;
  onSetTier: (c: ClassStats, tier: 0 | 1) => Promise<boolean>;
  /** Open with the inline confirm showing (tests). */
  startAsking?: boolean;
}) {
  const [asking, setAsking] = useState(startAsking);
  const raisable = !listed || !!c.demoted;
  if (asking) {
    return (
      <span className="flex flex-wrap items-center gap-2" data-tier-confirm>
        <span role="note" style={{ color: 'var(--color-text)' }}>
          {tierConfirmText(label)}
        </span>
        <SmallButton
          tone="warning"
          disabled={busy || !c.eligible}
          onClick={() => void onSetTier(c, 1).then(() => setAsking(false))}
        >
          Confirm: allow auto-apply
        </SmallButton>
        <SmallButton onClick={() => setAsking(false)}>Cancel</SmallButton>
      </span>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      {raisable && (
        <span data-tier-allow={c.eligible ? 'enabled' : 'disabled'}>
          <SmallButton
            disabled={busy || !c.eligible}
            onClick={() => setAsking(true)}
            title={c.eligible ? 'Let the writer apply this class’s fixes without asking' : eligibilityRule(suggestAt(c))}
          >
            Allow auto-apply
          </SmallButton>
        </span>
      )}
      {listed && (
        <span data-tier-off>
          <SmallButton disabled={busy} onClick={() => void onSetTier(c, 0)}>
            Turn off auto-apply
          </SmallButton>
        </span>
      )}
    </span>
  );
}

function ClassPanel({
  classes,
  storeNames,
  policy,
  tierPending,
  onSetTier,
}: {
  classes: ClassStats[];
  storeNames: Record<string, string>;
  policy?: AutofixPolicy | null;
  tierPending?: string | null;
  onSetTier?: (c: ClassStats, tier: 0 | 1) => Promise<boolean>;
}) {
  return (
    <DashboardPanel icon={CheckCheck} title="Fix classes" tag="Tier control" size="full">
      {classes.length === 0 ? (
        <Quiet>No fix classes yet.</Quiet>
      ) : (
        <div className="overflow-x-auto">
          <p className="text-[11px] mb-1.5" style={{ color: 'var(--color-text-tertiary)' }}>
            Streak: {STREAK_EXPLAINED} Bulk: approvals through “Approve these N”, which don’t count toward it.
            Reverts are revert decisions; Applied to Reverted count the writer’s outcomes.
          </p>
          <p className="text-[11px] mb-1.5" style={{ color: 'var(--color-text-secondary)' }}>
            {panelRule(classes)} Reverted and Failed verify are the all-time record.
          </p>
          <p className="text-[11px] mb-1.5" data-policy-line style={{ color: 'var(--color-text-secondary)' }}>
            {policyLine(policy)}
          </p>
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left" style={{ color: 'var(--color-text-tertiary)' }}>
                {[
                  'Store',
                  'Rule',
                  'Field',
                  'Streak',
                  'Bulk',
                  'Approvals',
                  'Edits',
                  'Rejects',
                  'Reverts',
                  'Applied',
                  'Verified',
                  'Failed verify',
                  'Reverted',
                  'Spot-check',
                  'Tier',
                  'Policy tier',
                  'Auto applied',
                  'Toward auto-apply',
                  '',
                ].map((h) => (
                  <th key={h} className="font-normal pr-3 pb-1" title={h === 'Streak' ? STREAK_EXPLAINED : undefined}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {classes.map((c) => {
                const label = `${storeNames[c.store] ?? c.store} · ${ruleLabel(c.rule)} · ${c.field}`;
                const listed = inPolicy(c, policy);
                return (
                  <tr key={classKey(c)} data-class={classKey(c)} style={{ color: 'var(--color-text)' }}>
                    <td className="pr-3 py-0.5">{storeNames[c.store] ?? c.store}</td>
                    <td className="pr-3">{ruleLabel(c.rule)}</td>
                    <td className="pr-3">{c.field}</td>
                    <td className="pr-3 tabular-nums">
                      {num(c.streak)}
                      {c.streak_since && (
                        <span className="block text-[10.5px]" data-streak-since style={{ color: 'var(--color-text-tertiary)' }}>
                          streak since {shortDateTime(c.streak_since)}
                        </span>
                      )}
                    </td>
                    <td className="pr-3 tabular-nums">{num(c.bulk_approvals ?? 0)}</td>
                    <td className="pr-3 tabular-nums">{num(c.approvals)}</td>
                    <td className="pr-3 tabular-nums">{num(c.edits)}</td>
                    <td className="pr-3 tabular-nums">{num(c.rejects)}</td>
                    <td className="pr-3 tabular-nums">{num(c.reverts)}</td>
                    <td className="pr-3 tabular-nums">{num(c.applied ?? 0)}</td>
                    <td className="pr-3 tabular-nums">{num(c.verified ?? 0)}</td>
                    <td className="pr-3 tabular-nums">{num(c.failed_verify ?? 0)}</td>
                    <td className="pr-3 tabular-nums">{num(c.reverted ?? 0)}</td>
                    <td className="pr-3 tabular-nums" data-spot={c.spot_check ? String(c.spot_check.passed) : undefined}>
                      {c.spot_check ? `${c.spot_check.confirmed}/${c.spot_check.required}${c.spot_check.passed ? ' ✓' : ''}` : '—'}
                    </td>
                    <td className="pr-3 tabular-nums" data-tier={c.tier}>{c.tier}</td>
                    <td className="pr-3 tabular-nums" data-policy-tier={listed ? 1 : 0}>{listed ? 1 : 0}</td>
                    <td className="pr-3 tabular-nums">{num(c.auto_applied ?? 0)}</td>
                    <td className="pr-3 tabular-nums whitespace-nowrap" data-progress={suggestAt(c)}>
                      {progressText(c)}
                    </td>
                    <td className="text-[11px]">
                      <span className="flex flex-col gap-1">
                        {c.demoted && (
                          <span data-demoted style={{ color: 'var(--color-warning)' }}>
                            {demotedNote(c.demoted)}
                          </span>
                        )}
                        {c.eligible && <span style={{ color: 'var(--color-success)' }}>Eligible for auto-apply</span>}
                        {onSetTier && (
                          <TierControl
                            c={c}
                            label={label}
                            listed={listed}
                            busy={tierPending === classKey(c)}
                            onSetTier={onSetTier}
                          />
                        )}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </DashboardPanel>
  );
}

export interface FixesTabProps {
  feed: CatalogFixes | null;
  loading?: boolean;
  error?: string | null;
  pending: Record<string, PendingFix>;
  cardNotes: Record<string, string>;
  paused: boolean;
  pausePending: boolean;
  selectedStore: string;
  storeNames: Record<string, string>;
  recTitles: Record<string, string>;
  onDecide: (patch: Patch, action: FixAction, opts?: DecideOpts) => Promise<boolean>;
  onDecideClass: (cls: FixClass, patches: Patch[], action?: ClassAction) => Promise<ClassResult | null>;
  onPause: (paused: boolean) => void;
  onOpenRec?: (id: string) => void;
  notice?: string | null;
  onClearNotice?: () => void;
  /** v1.4: the auto-fix policy file and the tier control. */
  policy?: AutofixPolicy | null;
  tierPending?: string | null;
  onSetTier?: (c: ClassStats, tier: 0 | 1) => Promise<boolean>;
}

/** The Fixes tab (hq 0011 §7): review Hermes's catalog fixes quickly.
 * Keyboard: j/k move, a approve, e edit, r reject, c confirm. */
export function FixesTab({
  feed,
  loading,
  error,
  pending,
  cardNotes,
  paused,
  pausePending,
  selectedStore,
  storeNames,
  recTitles,
  onDecide,
  onDecideClass,
  onPause,
  onOpenRec,
  notice,
  onClearNotice,
  policy,
  tierPending,
  onSetTier,
}: FixesTabProps) {
  const [status, setStatus] = useState<StatusFilter>('all');
  const [cls, setCls] = useState('all');
  const [source, setSource] = useState<SourceFilter>('all');
  const [focusId, setFocusId] = useState<string | null>(null);
  const [panel, setPanel] = useState<{ id: string; kind: CardPanel } | null>(null);
  const [classResults, setClassResults] = useState<Record<string, ClassResult>>({});
  const [confirmClass, setConfirmClass] = useState<{ key: string; action: ClassAction } | null>(null);

  const patches = feed?.patches;
  const classes = feed?.classes;
  const statsByKey = useMemo(() => new Map((classes ?? []).map((c) => [classKey(c), c])), [classes]);
  const classOptions = useMemo(() => {
    const seen = new Map<string, FixClass>();
    for (const p of patches ?? []) seen.set(classKey(p.fix_class), p.fix_class);
    return [...seen.entries()].map(([value, c]) => ({
      value,
      label: `${storeNames[c.store] ?? c.store} · ${ruleLabel(c.rule)} · ${c.field}`,
    }));
  }, [patches, storeNames]);

  const sourceOptions = useMemo(() => {
    const counts = new Map<FixSource, number>();
    for (const p of patches ?? []) counts.set(patchSource(p), (counts.get(patchSource(p)) ?? 0) + 1);
    const out: { value: SourceFilter; label: string }[] = [{ value: 'all', label: 'All' }];
    for (const s of FIX_SOURCES) if (counts.get(s)) out.push({ value: s, label: `${s} (${counts.get(s)})` });
    return out;
  }, [patches]);

  const groups = useMemo(() => {
    const visible = visiblePatches(patches ?? [], { store: selectedStore, cls, status, source });
    return groupPatches(sortPatches(visible, spotBlockers(classes, patches)));
  }, [patches, classes, selectedStore, cls, status, source]);
  const titles = useMemo(() => new Map((patches ?? []).map((p) => [p.id, p.product_title])), [patches]);

  /** Show a card wherever the filters left it, and focus it. */
  const openCard = (id: string) => {
    setStatus('all');
    setCls('all');
    setSource('all');
    setFocusId(id);
    setPanel(null);
  };
  const flat = useMemo(() => groups.flatMap((g) => g.patches), [groups]);

  const focused = flat.find((p) => p.id === focusId) ?? flat[0] ?? null;

  const move = useCallback(
    (delta: number) => {
      if (!flat.length) return;
      const i = focused ? flat.indexOf(focused) : -1;
      const next = flat[Math.min(flat.length - 1, Math.max(0, i + delta))];
      setFocusId(next.id);
      setPanel(null);
    },
    [flat, focused],
  );

  const decide = useCallback(
    async (patch: Patch, action: FixAction, opts?: DecideOpts) => {
      const ok = await onDecide(patch, action, opts);
      if (ok) {
        setPanel(null);
        // Next card, so a review is a stream of keystrokes.
        const i = flat.indexOf(patch);
        if (i >= 0 && i + 1 < flat.length && focused?.id === patch.id) setFocusId(flat[i + 1].id);
      }
    },
    [flat, focused, onDecide],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      if (e.key === 'j') move(1);
      else if (e.key === 'k') move(-1);
      else if (!focused || pending[focused.id]) return;
      else {
        const act = keyAction(e.key, focused.status);
        if (!act) return;
        if (act === 'edit' || act === 'reject') setPanel({ id: focused.id, kind: act });
        else void decide(focused, act);
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [decide, focused, move, pending]);

  const decideGroup = async (g: FixGroup, action: ClassAction) => {
    setConfirmClass(null);
    const list = action === 'approve' ? classApprovable(g, pending) : classConfirmable(g, pending);
    const result = await onDecideClass(g.cls, list, action);
    if (result) setClassResults((r) => ({ ...r, [g.key]: result }));
  };

  const statusOptions: { value: StatusFilter; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'waiting', label: 'Waiting' },
    ...FIX_STATUSES.filter((s) => feed?.counts[s]).map((s) => ({ value: s, label: `${s} (${feed!.counts[s]})` })),
  ];

  return (
    <div className="grid grid-cols-12 gap-4 mb-10">
      <DashboardPanel icon={Wrench} title="Catalog fixes" tag="Hermes · catalog-fixer" size="full" loading={loading} error={error}>
        {!feed ? (
          <Quiet>No fixer run yet.</Quiet>
        ) : (
          <div className="flex flex-col gap-3">
            {!feed.writer.live && (
              <div
                className="rounded-lg px-3 py-2 text-[12px]"
                role="note"
                style={{ border: '1px solid var(--color-accent-subtle)', color: 'var(--color-text-secondary)' }}
              >
                {P1_BANNER}
              </div>
            )}
            <FixesHeader feed={feed} paused={paused} pausePending={pausePending} onPause={onPause} storeNames={storeNames} />
            {notice && (
              <div
                className="flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-[12px]"
                style={{ border: '1px solid var(--color-warning)', color: 'var(--color-text-secondary)' }}
                role="status"
              >
                <span>{notice}</span>
                {onClearNotice && (
                  <button onClick={onClearNotice} aria-label="Dismiss" className="cursor-pointer" style={{ background: 'transparent', border: 'none', color: 'inherit' }}>
                    <X size={12} />
                  </button>
                )}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <Select label="Status" value={status} options={statusOptions} onChange={setStatus} />
              <Select label="Class" value={cls} options={[{ value: 'all', label: 'All' }, ...classOptions]} onChange={setCls} />
              <Select label="Source" value={source} options={sourceOptions} onChange={setSource} />
              <span className="text-[11px] ml-auto" style={{ color: 'var(--color-text-tertiary)' }}>
                j / k move · a approve · e edit · r reject or withdraw · c confirm
              </span>
            </div>

            {flat.length === 0 ? (
              <Quiet>Nothing for this filter.</Quiet>
            ) : (
              groups.map((g) => {
                const approvable = classApprovable(g, pending);
                const reviewOnly = classReviewOnly(g, pending);
                const confirmable = classConfirmable(g, pending);
                const hasConfirm = g.patches.some((p) => p.status === 'confirm' && !pending[p.id]);
                const stats = statsByKey.get(g.key);
                const spotBlocked = !!stats?.spot_check && !stats.spot_check.passed;
                const confirmNotes = classConfirmNotes(g, pending, stats);
                const blockers = namedBlockers(stats) ?? [];
                const asking = confirmClass?.key === g.key ? confirmClass.action : null;
                const result = classResults[g.key];
                return (
                  <section key={g.key} className="flex flex-col gap-2.5">
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <span className="text-[12.5px] font-semibold" style={{ color: 'var(--color-text)' }}>
                        {storeNames[g.cls.store] ?? g.cls.store} · {ruleLabel(g.cls.rule)} · {g.cls.field}
                      </span>
                      <Chip tone="muted">{g.patches.length}</Chip>
                      {approvable.length > 0 &&
                        (asking === 'approve' ? (
                          <>
                            <SmallButton tone="accent" onClick={() => void decideGroup(g, 'approve')}>
                              <CheckCheck size={11} /> Confirm: approve these {approvable.length}
                            </SmallButton>
                            <SmallButton onClick={() => setConfirmClass(null)}>Cancel</SmallButton>
                            <span className="text-[11px]" role="note" style={{ color: 'var(--color-text-secondary)' }}>
                              {classConfirmText(reviewOnly)}
                            </span>
                          </>
                        ) : (
                          <SmallButton
                            onClick={() => setConfirmClass({ key: g.key, action: 'approve' })}
                            title={`Approves exactly the listed proposed fixes, each as displayed. Not a tier change.${
                              reviewOnly ? ` Leaves out ${reviewOnly} review-only.` : ''
                            }`}
                          >
                            <CheckCheck size={11} /> Approve these {approvable.length}
                          </SmallButton>
                        ))}
                      {hasConfirm &&
                        (asking === 'confirm' ? (
                          <>
                            <SmallButton tone="accent" onClick={() => void decideGroup(g, 'confirm')}>
                              <CheckCheck size={11} /> Confirm: confirm these {confirmable.length}
                            </SmallButton>
                            <SmallButton onClick={() => setConfirmClass(null)}>Cancel</SmallButton>
                          </>
                        ) : (
                          <SmallButton
                            onClick={() => setConfirmClass({ key: g.key, action: 'confirm' })}
                            disabled={spotBlocked || confirmable.length === 0}
                            title="Re-confirms exactly the listed P1 approvals, each as displayed, so the writer applies them."
                          >
                            <CheckCheck size={11} /> Confirm these {confirmable.length}
                          </SmallButton>
                        ))}
                    </div>
                    {hasConfirm && confirmNotes.length > 0 && (
                      <p className="text-[11px]" role="note" data-confirm-notes style={{ color: 'var(--color-text-secondary)' }}>
                        {confirmNotes.join(' ')}
                      </p>
                    )}
                    {blockers.length > 0 && (
                      <p className="text-[11px]" role="note" data-blockers style={{ color: 'var(--color-warning)' }}>
                        {BLOCKERS_LEAD}{' '}
                        {blockers.map((id, i) => (
                          <span key={id}>
                            {i > 0 && ', '}
                            <a
                              href={`#fix-${id}`}
                              data-blocker={id}
                              onClick={(e) => {
                                e.preventDefault();
                                openCard(id);
                              }}
                              style={{ color: 'inherit', textDecoration: 'underline' }}
                            >
                              {titles.get(id) ?? id.slice(0, 6)}
                            </a>
                          </span>
                        ))}
                      </p>
                    )}
                    {result && (
                      <p className="text-[11.5px]" role="status" style={{ color: 'var(--color-text-secondary)' }}>
                        {result.action === 'approve' ? 'Approved' : 'Confirmed'} {result.done.length}
                        {result.refused.length > 0 &&
                          `; refused ${result.refused.length}: ${result.refused.map(refusalText).join(', ')}`}
                      </p>
                    )}
                    {g.patches.map((p) => (
                      <PatchCard
                        key={p.id}
                        patch={p}
                        storeName={storeNames[p.store] ?? p.store}
                        pending={pending[p.id]}
                        cardNote={cardNotes[p.id]}
                        focused={focused?.id === p.id}
                        panel={panel?.id === p.id ? panel.kind : null}
                        onPanel={(kind) => setPanel(kind ? { id: p.id, kind } : null)}
                        onFocus={() => setFocusId(p.id)}
                        onDecide={(action, opts) => void decide(p, action, opts)}
                        recTitles={recTitles}
                        onOpenRec={onOpenRec}
                      />
                    ))}
                  </section>
                );
              })
            )}
          </div>
        )}
      </DashboardPanel>

      {feed && (
        <ClassPanel
          classes={feed.classes ?? []}
          storeNames={storeNames}
          policy={policy}
          tierPending={tierPending}
          onSetTier={onSetTier}
        />
      )}
    </div>
  );
}
