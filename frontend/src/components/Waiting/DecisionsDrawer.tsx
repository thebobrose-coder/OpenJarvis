import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { Chip, Quiet, SmallButton } from '../shared/ui';
import { useWaiting } from '../../lib/WaitingContext';
import { NOTE_MAX, ago, fetchDecisions, tickDecision, type DecisionBox, type Decisions } from '../../lib/waiting-api';

export const DEFAULT_HINT = 'Unticked means the default: leaving it alone is a choice too.';

const boxKey = (b: Pick<DecisionBox, 'file' | 'line'>) => `${b.file}:${b.line}`;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--color-text-tertiary)' }}>
        {title}
      </h3>
      {children}
    </section>
  );
}

function OpenBox({
  box,
  state,
  note,
  onNote,
  onArm,
  onTick,
}: {
  box: DecisionBox;
  state: 'idle' | 'armed' | 'posting' | 'done';
  note: string;
  onNote: (note: string) => void;
  onArm: (armed: boolean) => void;
  onTick: () => void;
}) {
  return (
    <li className="flex flex-col gap-1.5 rounded-lg p-3" style={{ background: 'var(--color-bg-secondary)' }} data-box={boxKey(box)}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip tone="accent">{box.folder}</Chip>
        <span className="text-[11.5px]" style={{ color: 'var(--color-text-tertiary)' }}>
          {box.title}
        </span>
      </div>
      <span className="font-medium text-[13px]" style={{ color: 'var(--color-text)' }}>
        D{box.number}. {box.decision}
      </span>
      <span>
        <b>Default:</b> {box.default}
      </span>
      {box.alternative && (
        <span>
          <b>Alternative:</b> {box.alternative}
        </span>
      )}
      <span className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
        {DEFAULT_HINT}
      </span>
      {box.paragraph && box.paragraph !== box.text && (
        <details>
          <summary className="cursor-pointer text-[11.5px]">Context</summary>
          <pre className="whitespace-pre-wrap text-[11.5px] mt-1" style={{ fontFamily: 'inherit' }}>
            {box.paragraph}
          </pre>
        </details>
      )}
      {state === 'done' ? (
        <Chip tone="success">Ticked</Chip>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          <input
            type="text"
            value={note}
            maxLength={NOTE_MAX}
            onChange={(e) => onNote(e.target.value.replace(/[\r\n]+/g, ' '))}
            placeholder="Note (optional, one line)"
            aria-label={`Note for D${box.number}`}
            className="flex-1 min-w-[12rem] rounded-md px-2 py-1 text-[12px]"
            style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
          />
          {state === 'idle' ? (
            <SmallButton tone="accent" onClick={() => onArm(true)} title="Tick this box in the brief">
              Tick D{box.number}
            </SmallButton>
          ) : (
            <>
              <SmallButton tone="success" disabled={state === 'posting'} onClick={onTick} title="Write the tick into the brief">
                Confirm tick
              </SmallButton>
              <SmallButton disabled={state === 'posting'} onClick={() => onArm(false)}>
                Cancel
              </SmallButton>
            </>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * The Decisions drawer's body (hq 0020 A5): the inbox briefs' open decision
 * boxes with their default and alternative as written, the briefs still
 * waiting on a session (read-only), and the recently decided boxes. Pure:
 * DecisionsDrawer passes the data and the tick in.
 */
export function DecisionsView({
  decisions,
  loading,
  error,
  states,
  notes,
  message,
  now,
  onNote,
  onArm,
  onTick,
}: {
  decisions: Decisions | null;
  loading: boolean;
  error: string | null;
  states: Record<string, 'idle' | 'armed' | 'posting' | 'done'>;
  notes: Record<string, string>;
  message: string | null;
  now: number;
  onNote: (key: string, note: string) => void;
  onArm: (key: string, armed: boolean) => void;
  onTick: (box: DecisionBox) => void;
}) {
  if (!decisions) return <Quiet>{loading ? 'Loading…' : error ?? 'Nothing to show.'}</Quiet>;
  return (
    <div className="flex flex-col gap-5">
      {message && (
        <p className="text-[12px]" role="status" style={{ color: 'var(--color-warning)' }}>
          {message}
        </p>
      )}
      <Section title={`Open decisions (${decisions.open.length})`}>
        {decisions.open.length === 0 ? (
          <Quiet>No open decision boxes in the inbox.</Quiet>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {decisions.open.map((b) => (
              <OpenBox
                key={boxKey(b)}
                box={b}
                state={states[boxKey(b)] ?? 'idle'}
                note={notes[boxKey(b)] ?? ''}
                onNote={(n) => onNote(boxKey(b), n)}
                onArm={(a) => onArm(boxKey(b), a)}
                onTick={() => onTick(b)}
              />
            ))}
          </ul>
        )}
      </Section>
      <Section title={`Briefs waiting on a session (${decisions.waiting_briefs.length})`}>
        {decisions.waiting_briefs.length === 0 ? (
          <Quiet>Every inbox brief has its Result.</Quiet>
        ) : (
          <ul className="flex flex-col gap-1">
            {decisions.waiting_briefs.map((w) => (
              <li key={w.file} className="flex flex-wrap items-center gap-1.5">
                <Chip tone="muted">{w.folder}</Chip>
                <span style={{ color: 'var(--color-text)' }}>{w.title}</span>
                <span className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
                  {ago(w.modified_at, now)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Recently decided">
        {decisions.recently_decided.length === 0 ? (
          <Quiet>Nothing decided in the last 14 days.</Quiet>
        ) : (
          <ul className="flex flex-col gap-1">
            {decisions.recently_decided.map((b) => (
              <li key={`${b.archived ? 'a' : 'i'}:${boxKey(b)}`} className="flex flex-col">
                <span style={{ color: 'var(--color-text)' }}>
                  D{b.number}. {b.decision}
                </span>
                <span className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
                  {b.folder} · {b.title}
                  {b.archived ? ' · archived' : ''}
                  {b.decided_note ? ` · ${b.decided_note.replace(/\*\*/g, '')}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

/** The drawer shell: loads /api/decisions when opened, ticks one box at a
 * time (with a confirm step), and refreshes the bell's list afterwards. */
export function DecisionsDrawer() {
  const { decisionsOpen, setDecisionsOpen, refresh } = useWaiting();
  const [decisions, setDecisions] = useState<Decisions | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [states, setStates] = useState<Record<string, 'idle' | 'armed' | 'posting' | 'done'>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setDecisions(await fetchDecisions());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (decisionsOpen) {
      setStates({});
      setMessage(null);
      void load();
    }
  }, [decisionsOpen, load]);

  useEffect(() => {
    if (!decisionsOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setDecisionsOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [decisionsOpen, setDecisionsOpen]);

  if (!decisionsOpen) return null;

  const tick = async (box: DecisionBox) => {
    const key = boxKey(box);
    setStates((s) => ({ ...s, [key]: 'posting' }));
    try {
      await tickDecision(box, (notes[key] ?? '').trim());
      setStates((s) => ({ ...s, [key]: 'done' }));
      setMessage(null);
      void refresh();
    } catch (e) {
      setStates((s) => ({ ...s, [key]: 'idle' }));
      setMessage(`D${box.number}: ${e instanceof Error ? e.message : String(e)}`);
      void load(); // the brief changed: show it as it is now
    }
  };

  const drawer = (
    <div className="fixed inset-0 z-[70] flex justify-end" style={{ background: 'rgba(0,0,0,0.35)' }} onClick={() => setDecisionsOpen(false)}>
      <aside
        role="dialog"
        aria-label="Decisions"
        onClick={(e) => e.stopPropagation()}
        className="h-full w-full max-w-[36rem] overflow-y-auto flex flex-col gap-4 p-5 text-[12.5px]"
        style={{ background: 'var(--color-surface)', borderLeft: '1px solid var(--color-border)', color: 'var(--color-text-secondary)' }}
      >
        <header className="flex items-center justify-between gap-2">
          <h2 className="text-[15px] font-semibold" style={{ color: 'var(--color-text)' }}>
            Decisions
          </h2>
          <button onClick={() => setDecisionsOpen(false)} aria-label="Close" className="cursor-pointer" style={{ background: 'transparent', border: 'none', color: 'inherit' }}>
            <X size={16} />
          </button>
        </header>
        <DecisionsView
          decisions={decisions}
          loading={loading}
          error={error}
          states={states}
          notes={notes}
          message={message}
          now={Date.now()}
          onNote={(k, n) => setNotes((s) => ({ ...s, [k]: n }))}
          onArm={(k, a) => setStates((s) => ({ ...s, [k]: a ? 'armed' : 'idle' }))}
          onTick={(b) => void tick(b)}
        />
      </aside>
    </div>
  );
  // Portalled to <body>, like the other drawers: Layout's stacking context
  // would otherwise keep it under the header bell.
  return typeof document === 'undefined' ? drawer : createPortal(drawer, document.body);
}
