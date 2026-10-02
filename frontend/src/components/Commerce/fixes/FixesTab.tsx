import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCheck, Pause, Play, Wrench, X } from 'lucide-react';
import {
  FIX_STATUSES,
  REFUSAL_REASON,
  isWaiting,
  needsOperator,
  type CatalogFixes,
  type ClassAction,
  type ClassStats,
  type FixAction,
  type FixClass,
  type FixStatus,
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

/** Keys of the classes whose spot-check hasn't passed (v1.3.3 A9). */
export const spotPending = (classes: ClassStats[] | undefined) =>
  new Set((classes ?? []).filter((c) => c.spot_check && !c.spot_check.passed).map(classKey));

// What needs a single decision leads: a waiting review-only fix (A7), and,
// in a class still in its spot-check, a figure-dropping fix to confirm (A9).
function rank(p: Patch, spot: Set<string>): number {
  if (p.review_only && needsOperator(p.status)) return -1;
  if (p.status === 'confirm' && p.drops_figure && spot.has(classKey(p.fix_class))) return -1;
  return ORDER[p.status] ?? DECIDED;
}

/** Single-decision fixes first, then proposed, invalid, to confirm, then the
 * rest by most recently decided. */
export function sortPatches(patches: Patch[], spot: Set<string> = new Set()): Patch[] {
  return [...patches].sort((a, b) => {
    const oa = rank(a, spot);
    const ob = rank(b, spot);
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

/** What the class confirm says: the spot-check's state while it hasn't
 * passed, and what must still be confirmed singly. */
export function classConfirmNotes(group: FixGroup, pending: Record<string, PendingFix>, stats?: ClassStats): string[] {
  const open = openConfirm(group, pending);
  const notes: string[] = [];
  const spot = stats?.spot_check;
  if (spot && !spot.passed) {
    // Past the count, what's missing is a figure-dropping P1 approval
    // confirmed on its own (A9).
    notes.push(
      spot.confirmed >= spot.required
        ? `Spot-check: confirmed ${spot.confirmed} of ${spot.required}, but each figure-dropping approval must also be confirmed one at a time.`
        : `Spot-check: confirmed ${spot.confirmed} of ${spot.required}. Confirm one at a time until it passes.`,
    );
  }
  const figures = open.filter((p) => p.drops_figure && !p.review_only).length;
  if (figures) {
    notes.push(
      `${plural(figures, 'figure-dropping fix is', 'figure-dropping fixes are')} waiting; confirm those one at a time.`,
    );
  }
  const reviewOnly = open.filter((p) => p.review_only).length;
  if (reviewOnly) notes.push(`${plural(reviewOnly, 'review-only fix needs', 'review-only fixes need')} a single confirm.`);
  return notes;
}

export const ELIGIBILITY_RULE =
  'Suggest auto-apply when: 20 single approvals in a row, 20 fixes applied and verified, no reverts, no failed verifications.';

/** The writer line in the header (v1.3.3). */
export function writerLine(w: CatalogFixes['writer']): string {
  if (!w.live) return 'Writer not live';
  const since = w.live_since ? ` since ${shortDateTime(w.live_since)}` : '';
  return `Writer live${since} · ${num(w.writes_today)}/${w.writes_cap ?? '—'} today`;
}

export const PAUSE_TITLE = {
  running: 'Pause stops the writer applying fixes. Reverts still run (0011 A1).',
  paused: 'The writer is paused: it applies nothing, but reverts still run (0011 A1). Resume lets it apply again.',
};

export const BULK_NO_STREAK = 'These approvals won’t count toward auto-apply.';
export const STREAK_EXPLAINED = 'Counts only fixes approved one at a time, unedited.';

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

type StatusFilter = 'all' | 'waiting' | FixStatus;

/** What a key does on the focused card: a approve and r reject a proposal,
 * e edits a waiting fix, c confirms a P1 approval. Approve over judge has
 * no key (A6). */
export function keyAction(key: string, status: FixStatus): Exclude<FixAction, 'revert'> | null {
  if (key === 'a' && status === 'proposed') return 'approve';
  if (key === 'e' && isWaiting(status)) return 'edit';
  if (key === 'r' && status === 'proposed') return 'reject';
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
}: {
  feed: CatalogFixes;
  paused: boolean;
  pausePending: boolean;
  onPause: (paused: boolean) => void;
}) {
  const w = feed.writer;
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
      <FeedFreshness ageSeconds={feed.age_seconds} stale={feed.stale} staleAfterSeconds={26 * 3600} label="Fixes" />
    </div>
  );
}

function ClassPanel({ classes, storeNames }: { classes: ClassStats[]; storeNames: Record<string, string> }) {
  return (
    <DashboardPanel icon={CheckCheck} title="Fix classes" tag="Read-only" size="full">
      {classes.length === 0 ? (
        <Quiet>No fix classes yet.</Quiet>
      ) : (
        <div className="overflow-x-auto">
          <p className="text-[11px] mb-1.5" style={{ color: 'var(--color-text-tertiary)' }}>
            Streak: {STREAK_EXPLAINED} Bulk: approvals through “Approve these N”, which don’t count toward it.
            Reverts are revert decisions; Applied to Reverted count the writer’s outcomes.
          </p>
          <p className="text-[11px] mb-1.5" style={{ color: 'var(--color-text-secondary)' }}>
            {ELIGIBILITY_RULE}
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
                  '',
                ].map((h) => (
                  <th key={h} className="font-normal pr-3 pb-1" title={h === 'Streak' ? STREAK_EXPLAINED : undefined}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {classes.map((c) => (
                <tr key={classKey(c)} style={{ color: 'var(--color-text)' }}>
                  <td className="pr-3 py-0.5">{storeNames[c.store] ?? c.store}</td>
                  <td className="pr-3">{ruleLabel(c.rule)}</td>
                  <td className="pr-3">{c.field}</td>
                  <td className="pr-3 tabular-nums">{num(c.streak)}</td>
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
                  <td className="pr-3 tabular-nums">{c.tier}</td>
                  <td className="text-[11px]" style={{ color: 'var(--color-success)' }}>
                    {c.eligible && 'Eligible for auto-apply. That switch is an operator config change, not available here.'}
                  </td>
                </tr>
              ))}
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
}: FixesTabProps) {
  const [status, setStatus] = useState<StatusFilter>('all');
  const [cls, setCls] = useState('all');
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

  const groups = useMemo(() => {
    const visible = (patches ?? []).filter(
      (p) =>
        (selectedStore === ALL_STORES || p.store === selectedStore) &&
        (cls === 'all' || classKey(p.fix_class) === cls) &&
        (status === 'all' || (status === 'waiting' ? needsOperator(p.status) : p.status === status)),
    );
    return groupPatches(sortPatches(visible, spotPending(classes)));
  }, [patches, classes, selectedStore, cls, status]);
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
            <FixesHeader feed={feed} paused={paused} pausePending={pausePending} onPause={onPause} />
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
              <span className="text-[11px] ml-auto" style={{ color: 'var(--color-text-tertiary)' }}>
                j / k move · a approve · e edit · r reject · c confirm
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

      {feed && <ClassPanel classes={feed.classes ?? []} storeNames={storeNames} />}
    </div>
  );
}
