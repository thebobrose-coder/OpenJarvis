import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, X } from 'lucide-react';
import { Chip, Quiet, SmallButton } from '../shared/ui';
import { useWaiting } from '../../lib/WaitingContext';
import { G1_NOTE_MAX, decideG1, fetchG1, g1Media, type G1Item, type G1Outcome } from '../../lib/g1-api';
import { ago } from '../../lib/waiting-api';

export const ALREADY = 'Already decided (Telegram or app)';

/** G1 waits 24 hours: the time left, in hours (or minutes in the last hour). */
export function expiresLabel(expiresAt: string, now: number): string | null {
  const t = Date.parse(expiresAt);
  if (Number.isNaN(t)) return null;
  const min = Math.floor((t - now) / 60000);
  if (min <= 0) return 'expired';
  return min < 60 ? `expires in ${min} min` : `expires in ${Math.floor(min / 60)} h`;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10.5px] uppercase tracking-wide" style={{ color: 'var(--color-text-tertiary)' }}>
        {label}
      </span>
      {children}
    </div>
  );
}

/** The still, or the clip with sound, loaded as blobs when the drawer opens. */
function G1Media({ item, load }: { item: G1Item; load: (which: 'still' | 'clip') => Promise<string> }) {
  const [urls, setUrls] = useState<{ still?: string; clip?: string }>({});
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const made: string[] = [];
    const want: ('still' | 'clip')[] = [...(item.hasClip ? (['clip'] as const) : []), ...(item.hasStill ? (['still'] as const) : [])];
    for (const which of want) {
      load(which).then(
        (u) => {
          made.push(u);
          if (alive) setUrls((s) => ({ ...s, [which]: u }));
          else URL.revokeObjectURL(u);
        },
        (e: unknown) => alive && setFailed(e instanceof Error ? e.message : String(e)),
      );
    }
    return () => {
      alive = false;
      made.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [item.approvalId, item.hasClip, item.hasStill, load]);

  if (!item.hasClip && !item.hasStill) return <Quiet>No still or clip on this row. A row written before the mirror stored its card shows only its label.</Quiet>;
  return (
    <div className="flex flex-col gap-2">
      {item.hasClip &&
        (urls.clip ? (
          <video src={urls.clip} controls poster={urls.still} className="w-full rounded-md max-h-[55vh]" style={{ background: '#000' }} aria-label={item.contentType === 'episode' ? 'The 60 s cut' : 'The clip'} />
        ) : (
          <Quiet>Loading the {item.contentType === 'episode' ? '60 s cut' : 'clip'}…</Quiet>
        ))}
      {!item.hasClip && item.hasStill && (urls.still ? <img src={urls.still} alt={item.headline} className="w-full rounded-md" /> : <Quiet>Loading the still…</Quiet>)}
      {failed && (
        <span className="text-[11.5px]" style={{ color: 'var(--color-error)' }}>
          {failed}
        </span>
      )}
    </div>
  );
}

/**
 * One G1 row as Telegram's card shows it (foundry-g1-mirror.md): the still or
 * the clip, headline, caption, disclosures, targets and the motion beat, with
 * Approve or Reject and an optional note. A G2 row shows everything and no
 * buttons: it is decided in Telegram (0020 A2). Pure but for its media
 * blobs; G1Drawer passes the row and the decision in.
 */
export function G1View({
  item,
  now,
  outcome,
  busy,
  onDecide,
  load,
}: {
  item: G1Item;
  now: number;
  outcome: G1Outcome | null;
  busy: boolean;
  onDecide: (decision: 'approve' | 'reject', note: string) => void;
  load: (which: 'still' | 'clip') => Promise<string>;
}) {
  const [note, setNote] = useState('');
  const [arm, setArm] = useState<'approve' | 'reject' | null>(null);
  const episode = item.contentType === 'episode';
  const due = expiresLabel(item.expiresAt, now);
  const done = outcome?.kind === 'decided' || outcome?.kind === 'already';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip tone={item.decidable ? 'warning' : 'error'}>{item.gate}</Chip>
        <Chip tone="accent">{item.propertyId}</Chip>
        <Chip tone="muted">{episode ? 'episode' : item.contentType ?? 'post'}</Chip>
        <span className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
          asked {ago(item.createdAt, now)}
          {due ? ` · ${due}` : ''}
        </span>
      </div>

      <G1Media item={item} load={load} />

      <Field label={episode ? 'Title' : 'Headline'}>
        <span className="text-[14px] font-semibold" style={{ color: 'var(--color-text)' }}>
          {item.headline || item.executionName}
        </span>
      </Field>
      {item.caption && (
        <Field label={episode ? 'Description' : 'Caption'}>
          <p className="whitespace-pre-wrap" style={{ color: 'var(--color-text)' }}>
            {item.caption}
          </p>
        </Field>
      )}
      {item.disclosures.length > 0 && (
        <Field label="Disclosures">
          <ul className="pl-4 list-disc">
            {item.disclosures.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        </Field>
      )}
      {item.escalation && (
        <Field label="Compliance">
          <span style={{ color: 'var(--color-error)' }}>{item.escalation}</span>
        </Field>
      )}
      {(item.targets ?? []).length > 0 && (
        <Field label={episode ? 'Tags' : 'Targets'}>
          <span className="flex flex-wrap gap-1">
            {(item.targets ?? []).map((t) => (
              <Chip key={t} tone="neutral">
                {t}
              </Chip>
            ))}
          </span>
        </Field>
      )}
      {item.motion && (
        <Field label={`Motion (${item.motion.release})`}>
          <span>{item.motion.beat ?? 'No beat'}</span>
        </Field>
      )}
      {episode && <Quiet>Approving publishes the full cut to YouTube with this title, description, tags and thumbnail.</Quiet>}

      {outcome?.kind === 'decided' && (
        <p role="status" style={{ color: 'var(--color-success)' }}>
          {outcome.status === 'APPROVED' ? (episode ? 'Approved: Foundry publishes it now.' : 'Approved: Foundry posts it now.') : 'Rejected.'}
        </p>
      )}
      {outcome?.kind === 'already' && (
        <p role="status" style={{ color: 'var(--color-warning)' }}>
          {ALREADY}
          {outcome.status ? `: ${outcome.status.toLowerCase()}` : ''}.
        </p>
      )}
      {outcome?.kind === 'error' && (
        <p role="alert" style={{ color: 'var(--color-error)' }}>
          {outcome.message}
        </p>
      )}

      {!item.decidable ? (
        <p className="rounded-md p-2" style={{ border: '1px solid var(--color-error)' }}>
          Decide in Telegram: compliance flagged this one (G2).
        </p>
      ) : (
        !done && (
          <div className="flex flex-col gap-2">
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value.slice(0, G1_NOTE_MAX))}
              rows={2}
              placeholder="Note (optional)"
              aria-label="G1 note"
              className="w-full rounded-md px-2 py-1.5 text-[12px] resize-y"
              style={{ background: 'var(--color-surface)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
            />
            {arm ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <span>{arm === 'approve' ? (episode ? 'Approve and publish to YouTube?' : 'Approve and post?') : 'Reject it?'}</span>
                <SmallButton tone={arm === 'approve' ? 'success' : 'error'} disabled={busy} onClick={() => onDecide(arm, note)}>
                  Confirm {arm}
                </SmallButton>
                <SmallButton disabled={busy} onClick={() => setArm(null)}>
                  Cancel
                </SmallButton>
              </div>
            ) : (
              <div className="flex gap-1.5">
                <SmallButton tone="success" disabled={busy} onClick={() => setArm('approve')}>
                  <Check size={11} /> Approve
                </SmallButton>
                <SmallButton tone="error" disabled={busy} onClick={() => setArm('reject')}>
                  <X size={11} /> Reject
                </SmallButton>
              </div>
            )}
          </div>
        )
      )}
    </div>
  );
}

/** The drawer shell: lists the mirror when it opens (links are never kept),
 * decides one row, and refreshes the bell's list afterwards. */
export function G1Drawer() {
  const { g1Open, setG1Open, refresh } = useWaiting();
  const [item, setItem] = useState<G1Item | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<G1Outcome | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!g1Open) return;
    setItem(null);
    setOutcome(null);
    setError(null);
    setLoading(true);
    fetchG1()
      .then((items) => {
        const found = items.find((i) => i.approvalId === g1Open) ?? null;
        setItem(found);
        if (!found) setError('No longer open: Telegram or the app decided it, or it expired.');
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [g1Open]);

  useEffect(() => {
    if (!g1Open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setG1Open(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [g1Open, setG1Open]);

  const load = useCallback((which: 'still' | 'clip') => (g1Open ? g1Media(g1Open, which) : Promise.reject(new Error('closed'))), [g1Open]);

  if (!g1Open) return null;

  const decide = async (decision: 'approve' | 'reject', note: string) => {
    setBusy(true);
    try {
      setOutcome(await decideG1(g1Open, decision, note));
    } catch (e) {
      setOutcome({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
      void refresh(); // decided or already decided: the bell drops it
    }
  };

  const drawer = (
    <div className="fixed inset-0 z-[70] flex justify-end" style={{ background: 'rgba(0,0,0,0.35)' }} onClick={() => setG1Open(null)}>
      <aside
        role="dialog"
        aria-label="G1 approval"
        onClick={(e) => e.stopPropagation()}
        className="h-full w-full max-w-[36rem] overflow-y-auto flex flex-col gap-4 p-5 text-[12.5px]"
        style={{ background: 'var(--color-surface)', borderLeft: '1px solid var(--color-border)', color: 'var(--color-text-secondary)' }}
      >
        <header className="flex items-center justify-between gap-2">
          <h2 className="text-[15px] font-semibold" style={{ color: 'var(--color-text)' }}>
            {item && !item.decidable ? 'Flagged for G2 (decide in Telegram)' : item?.contentType === 'episode' ? 'Episode to approve (G1)' : 'Post to approve (G1)'}
          </h2>
          <button onClick={() => setG1Open(null)} aria-label="Close" className="cursor-pointer" style={{ background: 'transparent', border: 'none', color: 'inherit' }}>
            <X size={16} />
          </button>
        </header>
        {item ? (
          <G1View item={item} now={Date.now()} outcome={outcome} busy={busy} onDecide={(d, n) => void decide(d, n)} load={load} />
        ) : (
          <Quiet>{loading ? 'Loading…' : error ?? 'Nothing to show.'}</Quiet>
        )}
      </aside>
    </div>
  );
  // Portalled to <body>, like the other drawers.
  return typeof document === 'undefined' ? drawer : createPortal(drawer, document.body);
}
