import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCheck, Pause, Play, Wrench, X } from 'lucide-react';
import {
  FIX_STATUSES,
  isWaiting,
  type CatalogFixes,
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
import { ALL_STORES, num } from '../format';
import { PatchCard, type CardPanel, type DecideOpts } from './PatchCard';

export const P1_BANNER = 'Proposals only. Decisions are recorded; nothing is written to Shopify yet.';

const ORDER: Record<string, number> = { proposed: 0, invalid: 1 };

/** Proposed first, then invalid, then the rest by most recently decided. */
export function sortPatches(patches: Patch[]): Patch[] {
  return [...patches].sort((a, b) => {
    const oa = ORDER[a.status] ?? 2;
    const ob = ORDER[b.status] ?? 2;
    if (oa !== ob) return oa - ob;
    if (oa === 2) return (b.decided_at ?? '').localeCompare(a.decided_at ?? '');
    return a.created_at.localeCompare(b.created_at);
  });
}

export const classKey = (c: FixClass) => `${c.store}|${c.rule}|${c.field}`;
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

/** The class approval: only the visible, proposed, not-yet-decided patches. */
export function classApprovable(group: FixGroup, pending: Record<string, PendingFix>): Patch[] {
  return group.patches.filter((p) => p.status === 'proposed' && !pending[p.id]);
}

export const waitingCount = (feed: CatalogFixes | null) =>
  feed ? (feed.counts.proposed ?? 0) + (feed.counts.invalid ?? 0) : 0;

type StatusFilter = 'all' | 'waiting' | FixStatus;

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
        title={paused ? 'The writer is paused. Resume lets it apply approved fixes (from P2).' : 'Stop the writer from applying anything (from P2)'}
      >
        {paused ? <Play size={11} /> : <Pause size={11} />}
        {paused ? 'Paused · Resume' : 'Pause writer'}
      </SmallButton>
      {pausePending && <span style={{ color: 'var(--color-text-tertiary)' }}>recording…</span>}
      <span>
        Writes today:{' '}
        {w.live
          ? `${num(w.writes_today)} / ${w.writes_cap ?? '—'} · auto ${num(w.auto_today)} / ${w.auto_cap ?? '—'}`
          : 'not live'}
      </span>
      <FeedFreshness ageSeconds={feed.age_seconds} stale={feed.stale} staleAfterSeconds={26 * 3600} label="Fixes" />
    </div>
  );
}

function ClassPanel({ classes, storeNames }: { classes: ClassStats[]; storeNames: Record<string, string> }) {
  return (
    <DashboardPanel icon={CheckCheck} title="Fix classes" tag="Read-only" size="full">
      {classes.length === 0 ? (
        <Quiet>No class history yet. Streaks start with the first decisions.</Quiet>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left" style={{ color: 'var(--color-text-tertiary)' }}>
                {['Store', 'Rule', 'Field', 'Streak', 'Approvals', 'Edits', 'Rejects', 'Reverts', 'Tier', ''].map((h) => (
                  <th key={h} className="font-normal pr-3 pb-1">
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
                  <td className="pr-3 tabular-nums">{num(c.approvals)}</td>
                  <td className="pr-3 tabular-nums">{num(c.edits)}</td>
                  <td className="pr-3 tabular-nums">{num(c.rejects)}</td>
                  <td className="pr-3 tabular-nums">{num(c.reverts)}</td>
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
  onApproveClass: (cls: FixClass, patches: Patch[]) => Promise<ClassResult | null>;
  onPause: (paused: boolean) => void;
  onOpenRec?: (id: string) => void;
  notice?: string | null;
  onClearNotice?: () => void;
}

/** The Fixes tab (hq 0011 §7): review Hermes's catalog fixes quickly.
 * Keyboard: j/k move, a approve, e edit, r reject. */
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
  onApproveClass,
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
  const [confirmClass, setConfirmClass] = useState<string | null>(null);

  const patches = feed?.patches;
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
        (status === 'all' || (status === 'waiting' ? isWaiting(p.status) : p.status === status)),
    );
    return groupPatches(sortPatches(visible));
  }, [patches, selectedStore, cls, status]);
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
      else if (e.key === 'a' && focused.status === 'proposed') void decide(focused, 'approve');
      else if (e.key === 'e' && isWaiting(focused.status)) setPanel({ id: focused.id, kind: 'edit' });
      else if (e.key === 'r' && focused.status === 'proposed') setPanel({ id: focused.id, kind: 'reject' });
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [decide, focused, move, pending]);

  const approveGroup = async (g: FixGroup) => {
    setConfirmClass(null);
    const list = classApprovable(g, pending);
    const result = await onApproveClass(g.cls, list);
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
                j / k move · a approve · e edit · r reject
              </span>
            </div>

            {flat.length === 0 ? (
              <Quiet>Nothing for this filter.</Quiet>
            ) : (
              groups.map((g) => {
                const approvable = classApprovable(g, pending);
                const result = classResults[g.key];
                return (
                  <section key={g.key} className="flex flex-col gap-2.5">
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <span className="text-[12.5px] font-semibold" style={{ color: 'var(--color-text)' }}>
                        {storeNames[g.cls.store] ?? g.cls.store} · {ruleLabel(g.cls.rule)} · {g.cls.field}
                      </span>
                      <Chip tone="muted">{g.patches.length}</Chip>
                      {approvable.length > 0 &&
                        (confirmClass === g.key ? (
                          <>
                            <SmallButton tone="accent" onClick={() => void approveGroup(g)}>
                              <CheckCheck size={11} /> Confirm: approve these {approvable.length}
                            </SmallButton>
                            <SmallButton onClick={() => setConfirmClass(null)}>Cancel</SmallButton>
                          </>
                        ) : (
                          <SmallButton
                            onClick={() => setConfirmClass(g.key)}
                            title="Approves exactly the listed proposed fixes, each as displayed. Not a tier change."
                          >
                            <CheckCheck size={11} /> Approve these {approvable.length}
                          </SmallButton>
                        ))}
                    </div>
                    {result && (
                      <p className="text-[11.5px]" role="status" style={{ color: 'var(--color-text-secondary)' }}>
                        Approved {result.approved.length}
                        {result.refused.length > 0 &&
                          `; refused ${result.refused.length}: ${result.refused.map((r) => `${r.id.slice(0, 6)} (${r.reason})`).join(', ')}`}
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
