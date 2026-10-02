import { useEffect, useRef, useState } from 'react';
import { Check, Pencil, RotateCcw, ShieldAlert, X } from 'lucide-react';
import { actionsFor, judgeOnlyInvalid, specDrops, type FixAction, type FixStatus, type Patch } from '../../../lib/fixes-api';
import type { PendingFix } from '../../../hooks/useCatalogFixes';
import { Chip, ExtIcon, ExtLink, SmallButton, type Tone } from '../../shared/ui';
import { shortDateTime } from '../format';
import { DiffBody, DroppedFigures, FieldDiff } from './FieldDiff';

export const STATUS_TONE: Record<FixStatus, Tone> = {
  proposed: 'accent',
  invalid: 'error',
  approved: 'success',
  rejected: 'muted',
  stale: 'warning',
  applied: 'success',
  verified: 'success',
  'failed-verify': 'error',
  reverted: 'muted',
};

const PENDING_LABEL: Record<FixAction, string> = {
  approve: 'approved',
  edit: 'edited',
  reject: 'rejected',
  revert: 'revert requested',
};

export type CardPanel = 'edit' | 'reject' | 'revert' | 'over-judge' | null;

export type DecideOpts = { note?: string; changes?: { field: string; after: string }[]; overJudge?: boolean };

export const REVIEW_ONLY_TITLE =
  'A judge flag allowed a spec to be dropped from this fix, so it is never auto-applied and is approved one at a time.';

const textareaStyle: React.CSSProperties = {
  background: 'var(--color-bg)',
  color: 'var(--color-text)',
  border: '1px solid var(--color-border)',
};

function NoteConfirm({
  label,
  tone,
  onConfirm,
  onCancel,
}: {
  label: string;
  tone: Tone;
  onConfirm: (note: string) => void;
  onCancel: () => void;
}) {
  const [note, setNote] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        ref={ref}
        value={note}
        onChange={(e) => setNote(e.target.value.slice(0, 500))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onConfirm(note);
          if (e.key === 'Escape') onCancel();
        }}
        placeholder="Note (optional)"
        className="flex-1 min-w-[12rem] rounded-md px-2 py-1 text-[12px]"
        style={textareaStyle}
      />
      <SmallButton tone={tone} onClick={() => onConfirm(note)}>
        {label}
      </SmallButton>
      <SmallButton onClick={onCancel}>Cancel</SmallButton>
    </div>
  );
}

/** The judge's flag, shown where the operator decides to override it. */
function JudgeFlag({ judge }: { judge: NonNullable<Patch['judge']> }) {
  return (
    <span className="text-[11.5px]" data-judge-flag style={{ color: 'var(--color-warning)' }}>
      Judge: {judge.quote && <span className="italic">“{judge.quote}”</span>} {judge.reason}
    </span>
  );
}

function Editor({
  patch,
  onSubmit,
  onCancel,
}: {
  patch: Patch;
  onSubmit: (opts: DecideOpts) => void;
  onCancel: () => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(patch.changes.map((c) => [c.field, c.after])),
  );
  const [note, setNote] = useState('');
  const first = useRef<HTMLTextAreaElement>(null);
  useEffect(() => first.current?.focus(), []);
  return (
    <div className="flex flex-col gap-3 rounded-md p-2" style={{ border: '1px solid var(--color-accent-subtle)' }}>
      {patch.changes.map((c, i) => (
        <div key={c.field} className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-medium" style={{ color: 'var(--color-text-secondary)' }}>
              {c.field}
            </span>
            <DroppedFigures before={c.before} after={drafts[c.field]} />
          </div>
          <textarea
            ref={i === 0 ? first : undefined}
            value={drafts[c.field]}
            onChange={(e) => setDrafts((d) => ({ ...d, [c.field]: e.target.value }))}
            onKeyDown={(e) => e.key === 'Escape' && onCancel()}
            rows={c.field === 'descriptionHtml' ? 10 : 2}
            spellCheck
            className="w-full rounded-md p-2 font-mono text-[11.5px]"
            style={textareaStyle}
          />
          <span className="text-[10.5px]" style={{ color: 'var(--color-text-tertiary)' }}>
            Live diff against the current copy
          </span>
          <DiffBody before={c.before} after={drafts[c.field]} mode={c.field === 'descriptionHtml' ? 'text' : 'html'} />
        </div>
      ))}
      <input
        value={note}
        onChange={(e) => setNote(e.target.value.slice(0, 500))}
        placeholder="Note (optional)"
        className="rounded-md px-2 py-1 text-[12px]"
        style={textareaStyle}
      />
      <p className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
        Saving approves your text. Hermes re-checks edited text; the new check results appear on the next feed
        refresh (about 2 minutes).
      </p>
      <div className="flex gap-2">
        <SmallButton
          tone="accent"
          onClick={() =>
            onSubmit({
              note,
              changes: patch.changes.map((c) => ({ field: c.field, after: drafts[c.field] })),
            })
          }
        >
          <Check size={11} /> Save edit and approve
        </SmallButton>
        <SmallButton onClick={onCancel}>Cancel</SmallButton>
      </div>
    </div>
  );
}

/** One proposed fix: what it changes, why, how it checked out, and the
 * operator's actions on it. */
export function PatchCard({
  patch,
  storeName,
  pending,
  cardNote,
  focused,
  panel,
  onPanel,
  onFocus,
  onDecide,
  recTitles,
  onOpenRec,
}: {
  patch: Patch;
  storeName: string;
  pending?: PendingFix;
  cardNote?: string;
  focused: boolean;
  panel: CardPanel;
  onPanel: (p: CardPanel) => void;
  onFocus: () => void;
  onDecide: (action: FixAction, opts?: DecideOpts) => void;
  recTitles: Record<string, string>;
  onOpenRec?: (id: string) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [focused]);

  const actions = pending ? [] : actionsFor(patch.status);
  const overJudge = !pending && judgeOnlyInvalid(patch);
  const overridden = !!patch.judge_overridden;
  // An approval over the judge is the operator's call, not an error (A6).
  // With Approve over judge offered, the flag shows beside that button instead.
  const failed = patch.validator.checks.filter(
    (c) => !c.passed && !((overridden || overJudge) && c.name === 'judge'),
  );
  const judge = patch.judge;
  const drops = specDrops(patch);

  return (
    <article
      ref={ref}
      id={`fix-${patch.id}`}
      data-status={patch.status}
      onClick={onFocus}
      className="flex flex-col gap-2.5 rounded-lg p-3"
      style={{
        background: 'var(--color-surface)',
        border: `1px solid ${focused ? 'var(--color-accent)' : 'var(--color-border)'}`,
        boxShadow: focused ? '0 0 0 1px var(--color-accent)' : undefined,
      }}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip tone={STATUS_TONE[patch.status] ?? 'neutral'}>{patch.status}</Chip>
        {pending && <Chip tone="muted">{PENDING_LABEL[pending.action]} · recording…</Chip>}
        {patch.edited && <Chip tone="neutral" title="The operator's text replaced the model's">edited</Chip>}
        {overridden && (
          <Chip tone="neutral" title="The operator approved this over the judge's flag">
            approved over judge
          </Chip>
        )}
        {patch.review_only && (
          <Chip tone="warning" title={REVIEW_ONLY_TITLE}>
            review only: never auto-applied
          </Chip>
        )}
        <span className="text-[13px] font-medium" style={{ color: 'var(--color-text)' }}>
          <ExtLink url={patch.admin_url} title="Open in Shopify admin">
            {patch.product_title}
          </ExtLink>
        </span>
        <ExtIcon url={patch.admin_url} title="Open in Shopify admin" />
        <span className="text-[11px] ml-auto" style={{ color: 'var(--color-text-tertiary)' }}>
          {storeName} · {shortDateTime(patch.decided_at ?? patch.created_at)}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
        {patch.addresses.finding_ids.map((id) => (
          <Chip key={id} tone="muted" title={`Compliance finding ${id} (OpenJarvis has no per-finding view yet)`}>
            finding {id.slice(0, 8)}
          </Chip>
        ))}
        {patch.addresses.rec_ids.map((id) => (
          <button
            key={id}
            onClick={(e) => {
              e.stopPropagation();
              onOpenRec?.(id);
            }}
            className="cursor-pointer"
            style={{ background: 'transparent', border: 'none', padding: 0 }}
            title={recTitles[id] ? `Recommendation: ${recTitles[id]}` : `Recommendation ${id}`}
          >
            <Chip tone="accent">rec {recTitles[id] ? recTitles[id].slice(0, 40) : id}</Chip>
          </button>
        ))}
        {patch.validator.checks.map((c) => (
          <Chip
            key={c.name}
            tone={c.passed ? 'success' : overridden && c.name === 'judge' ? 'warning' : 'error'}
            title={c.detail}
          >
            {c.passed ? '✓' : '✗'} {c.name}
          </Chip>
        ))}
        {judge && (
          <Chip
            tone={judge.verdict === 'clear' ? 'success' : 'warning'}
            title={[judge.model, judge.judge_version].filter(Boolean).join(' · ')}
          >
            judge: {judge.verdict}
          </Chip>
        )}
      </div>

      {failed.some((c) => c.detail) && (
        <ul className="flex flex-col gap-0.5 text-[11.5px]" style={{ color: 'var(--color-error)' }}>
          {failed
            .filter((c) => c.detail)
            .map((c) => (
              <li key={c.name}>
                <span className="font-medium">{c.name}:</span> {c.detail}
              </li>
            ))}
        </ul>
      )}
      {judge?.verdict === 'finding' && (judge.quote || judge.reason) && !overJudge && (
        <p className="text-[11.5px]" style={{ color: 'var(--color-warning)' }}>
          Judge: {judge.quote && <span className="italic">“{judge.quote}”</span>} {judge.reason}
        </p>
      )}

      {patch.changes.map((c) => (
        <FieldDiff key={c.field} field={c.field} before={c.before} after={c.after} rationale={c.rationale} drops={drops} />
      ))}

      {patch.note && (
        <p className="text-[11.5px] italic" style={{ color: 'var(--color-text-secondary)' }}>
          Note: “{patch.note}”
        </p>
      )}
      {cardNote && (
        <p className="text-[12px]" role="status" style={{ color: 'var(--color-warning)' }}>
          {cardNote}
        </p>
      )}

      {panel === 'edit' && actions.includes('edit') ? (
        <Editor patch={patch} onSubmit={(opts) => onDecide('edit', opts)} onCancel={() => onPanel(null)} />
      ) : panel === 'reject' && actions.includes('reject') ? (
        <NoteConfirm
          label="Reject (final)"
          tone="error"
          onConfirm={(note) => onDecide('reject', { note })}
          onCancel={() => onPanel(null)}
        />
      ) : panel === 'over-judge' && overJudge && judge ? (
        <div className="flex flex-col gap-1.5">
          <JudgeFlag judge={judge} />
          <NoteConfirm
            label="Confirm: approve over judge"
            tone="warning"
            onConfirm={(note) => onDecide('approve', { note, overJudge: true })}
            onCancel={() => onPanel(null)}
          />
        </div>
      ) : panel === 'revert' && actions.includes('revert') ? (
        <NoteConfirm
          label="Revert"
          tone="warning"
          onConfirm={(note) => onDecide('revert', { note })}
          onCancel={() => onPanel(null)}
        />
      ) : (
        actions.length > 0 && (
          <div className="flex flex-wrap gap-2" data-actions={actions.join(' ')}>
            {actions.includes('approve') && (
              <SmallButton tone="accent" onClick={() => onDecide('approve')} title="Approve exactly this fix (a)">
                <Check size={11} /> Approve
              </SmallButton>
            )}
            {actions.includes('edit') && (
              <SmallButton onClick={() => onPanel('edit')} title="Edit, then approve (e)">
                <Pencil size={11} /> Edit
              </SmallButton>
            )}
            {overJudge && (
              <>
                <SmallButton
                  tone="warning"
                  onClick={() => onPanel('over-judge')}
                  title="Every deterministic check passed; only the judge flagged it. No keyboard shortcut."
                >
                  <ShieldAlert size={11} /> Approve over judge
                </SmallButton>
                {judge && <JudgeFlag judge={judge} />}
              </>
            )}
            {actions.includes('reject') && (
              <SmallButton onClick={() => onPanel('reject')} title="Reject; final (r)">
                <X size={11} /> Reject
              </SmallButton>
            )}
            {actions.includes('revert') && (
              <SmallButton tone="warning" onClick={() => onPanel('revert')}>
                <RotateCcw size={11} /> Revert
              </SmallButton>
            )}
          </div>
        )
      )}
    </article>
  );
}
