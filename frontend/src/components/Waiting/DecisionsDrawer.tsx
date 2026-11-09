import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Drawer } from '../shared/Drawer';
import { X } from 'lucide-react';
import { Chip, Quiet, SmallButton } from '../shared/ui';
import { useWaiting } from '../../lib/WaitingContext';
import { useAppStore } from '../../lib/store';
import {
  DEFER_DAYS,
  DEFER_DEFAULT,
  NOTE_MAX,
  ago,
  decideDecision,
  deferUntil,
  fetchDecisions,
  type DecisionBox,
  type DecisionChoice,
  type Decisions,
} from '../../lib/waiting-api';

export const DEFAULT_HINT = 'Unticked means the default. Keep default records that choice in the brief; Defer hides the box until a date.';

const boxKey = (b: Pick<DecisionBox, 'file' | 'line'>) => `${b.file}:${b.line}`;

/** One box's place in the two-click flow: idle, armed for one choice, posting, or done with one. */
export type BoxState = 'idle' | 'posting' | `armed:${DecisionChoice}` | `done:${DecisionChoice}`;

export const CHOICE_LABEL: Record<DecisionChoice, { confirm: string; done: string }> = {
  tick: { confirm: 'Confirm tick', done: 'Ticked' },
  decline: { confirm: 'Confirm: keep the default', done: 'Default kept' },
  defer: { confirm: 'Confirm defer', done: 'Deferred' },
};

/** The open box a desk's `tick` card names (hq 0020 P2), by brief and number. */
export function findCardBox(decisions: Decisions | null, file: string, box: number): DecisionBox | null {
  return decisions?.open.find((b) => b.file === file && b.number === box) ?? null;
}

/** "default kept" on a declined box, else the stamp text without its bold marks. */
export function decidedLabel(b: Pick<DecisionBox, 'status' | 'decided_note'>): string {
  const note = b.decided_note ? b.decided_note.replace(/\*\*/g, '') : '';
  return b.status === 'declined' ? `default kept · ${note}` : note;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-ui-11 uppercase tracking-wide" style={{ color: 'var(--color-text-tertiary)' }}>
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
  days,
  onNote,
  onDays,
  onArm,
  onDecide,
  fromDesk = false,
}: {
  box: DecisionBox;
  fromDesk?: boolean;
  state: BoxState;
  note: string;
  days: number;
  onNote: (note: string) => void;
  onDays: (days: number) => void;
  onArm: (choice: DecisionChoice | null) => void;
  onDecide: (choice: DecisionChoice) => void;
}) {
  const armed = state.startsWith('armed:') ? (state.slice('armed:'.length) as DecisionChoice) : null;
  const done = state.startsWith('done:') ? (state.slice('done:'.length) as DecisionChoice) : null;
  return (
    <li
      id={fromDesk ? 'desk-card-box' : undefined}
      className="flex flex-col gap-1.5 rounded-lg p-3"
      style={{ background: 'var(--color-bg-secondary)', border: fromDesk ? '1px solid var(--color-accent)' : undefined }}
      data-box={boxKey(box)}
    >
      {fromDesk && (
        <span role="note" className="text-ui-11" style={{ color: 'var(--color-accent)' }}>
          A desk proposed this tick. Tick, then Confirm, to write it; or keep the default.
        </span>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip tone="accent">{box.folder}</Chip>
        <span className="text-ui-11-5" style={{ color: 'var(--color-text-tertiary)' }}>
          {box.title}
        </span>
        {box.deferred_until && <Chip tone="muted">deferred until {box.deferred_until}, due</Chip>}
      </div>
      <span className="font-medium text-ui-13" style={{ color: 'var(--color-text)' }}>
        D{box.number}. {box.decision}
      </span>
      {box.default && (
        <span>
          <b>Default:</b> {box.default}
        </span>
      )}
      {box.alternative && (
        <span>
          <b>Alternative:</b> {box.alternative}
        </span>
      )}
      <span className="text-ui-11" style={{ color: 'var(--color-text-tertiary)' }}>
        {DEFAULT_HINT}
      </span>
      {box.paragraph && box.paragraph !== box.text && (
        <details>
          <summary className="cursor-pointer text-ui-11-5">Context</summary>
          <pre className="whitespace-pre-wrap text-ui-11-5 mt-1" style={{ fontFamily: 'inherit' }}>
            {box.paragraph}
          </pre>
        </details>
      )}
      {done ? (
        <Chip tone="success">{done === 'defer' ? `Deferred until ${deferUntil(days)}` : CHOICE_LABEL[done].done}</Chip>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          <input
            type="text"
            value={note}
            maxLength={NOTE_MAX}
            onChange={(e) => onNote(e.target.value.replace(/[\r\n]+/g, ' '))}
            placeholder="Note (optional, one line)"
            aria-label={`Note for D${box.number}`}
            className="flex-1 min-w-[12rem] rounded-md px-2 py-1 text-ui-12"
            style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
          />
          {state === 'idle' ? (
            <>
              <SmallButton tone="accent" onClick={() => onArm('tick')} title="Tick this box in the brief">
                Tick D{box.number}
              </SmallButton>
              <SmallButton onClick={() => onArm('decline')} title="Leave the box unticked and record that the default is kept">
                Keep default
              </SmallButton>
              <SmallButton onClick={() => onArm('defer')} title="Hide this box until a later date">
                Defer…
              </SmallButton>
            </>
          ) : (
            <>
              {armed === 'defer' && (
                <select
                  value={days}
                  onChange={(e) => onDays(Number(e.target.value))}
                  aria-label={`Defer D${box.number} for`}
                  disabled={state === 'posting'}
                  className="rounded-md px-1.5 py-1 text-ui-12"
                  style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
                >
                  {DEFER_DAYS.map((d) => (
                    <option key={d} value={d}>
                      {d} day{d === 1 ? '' : 's'} (to {deferUntil(d)})
                    </option>
                  ))}
                </select>
              )}
              <SmallButton
                tone="success"
                disabled={state === 'posting'}
                onClick={() => onDecide(armed ?? 'tick')}
                title="Write this into the brief"
              >
                {CHOICE_LABEL[armed ?? 'tick'].confirm}
              </SmallButton>
              <SmallButton disabled={state === 'posting'} onClick={() => onArm(null)}>
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
 * boxes with their default and alternative as written, the boxes deferred to
 * a later date, the briefs still waiting on a session (read-only), and the
 * recently decided boxes. Pure: DecisionsDrawer passes the data and the
 * write in.
 */
export function DecisionsView({
  decisions,
  loading,
  error,
  states,
  notes,
  days = {},
  message,
  now,
  onNote,
  onDays = () => {},
  onArm,
  onDecide,
  highlight = null,
}: {
  decisions: Decisions | null;
  /** The box a desk card named, by its key: marked, never armed. */
  highlight?: string | null;
  loading: boolean;
  error: string | null;
  states: Record<string, BoxState>;
  notes: Record<string, string>;
  /** The defer length picked per box, in days (the default when absent). */
  days?: Record<string, number>;
  message: string | null;
  now: number;
  onNote: (key: string, note: string) => void;
  onDays?: (key: string, days: number) => void;
  onArm: (key: string, choice: DecisionChoice | null) => void;
  onDecide: (box: DecisionBox, choice: DecisionChoice) => void;
}) {
  if (!decisions) return <Quiet>{loading ? 'Loading…' : error ?? 'Nothing to show.'}</Quiet>;
  const deferred = decisions.deferred ?? [];
  return (
    <div className="flex flex-col gap-5">
      {message && (
        <p className="text-ui-12" role="status" style={{ color: 'var(--color-warning)' }}>
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
                days={days[boxKey(b)] ?? DEFER_DEFAULT}
                onNote={(n) => onNote(boxKey(b), n)}
                onDays={(d) => onDays(boxKey(b), d)}
                onArm={(c) => onArm(boxKey(b), c)}
                onDecide={(c) => onDecide(b, c)}
                fromDesk={highlight === boxKey(b)}
              />
            ))}
          </ul>
        )}
      </Section>
      {deferred.length > 0 && (
        <Section title={`Deferred (${deferred.length})`}>
          <ul className="flex flex-col gap-1">
            {deferred.map((b) => (
              <li key={boxKey(b)} className="flex flex-col">
                <span style={{ color: 'var(--color-text)' }}>
                  D{b.number}. {b.decision}
                </span>
                <span className="text-ui-11" style={{ color: 'var(--color-text-tertiary)' }}>
                  {b.folder} · {b.title} · back on {b.deferred_until}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section title={`Briefs waiting on a session (${decisions.waiting_briefs.length})`}>
        {decisions.waiting_briefs.length === 0 ? (
          <Quiet>Every inbox brief has its Result.</Quiet>
        ) : (
          <ul className="flex flex-col gap-1">
            {decisions.waiting_briefs.map((w) => (
              <li key={w.file} className="flex flex-wrap items-center gap-1.5">
                <Chip tone="muted">{w.folder}</Chip>
                <span style={{ color: 'var(--color-text)' }}>{w.title}</span>
                <span className="text-ui-11" style={{ color: 'var(--color-text-tertiary)' }}>
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
                <span className="text-ui-11" style={{ color: 'var(--color-text-tertiary)' }}>
                  {b.folder} · {b.title}
                  {b.archived ? ' · archived' : ''}
                  {b.decided_note || b.status === 'declined' ? ` · ${decidedLabel(b)}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

/** The drawer shell: loads /api/decisions when opened, writes one box at a
 * time (tick, keep default or defer, each behind a confirm step), and
 * refreshes the bell's list afterwards. */
export function DecisionsDrawer() {
  const { decisionsOpen, setDecisionsOpen, refresh } = useWaiting();
  const [decisions, setDecisions] = useState<Decisions | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [states, setStates] = useState<Record<string, BoxState>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [days, setDays] = useState<Record<string, number>>({});
  const [message, setMessage] = useState<string | null>(null);
  // A desk's tick card: the box it names gets the card's note, and the
  // operator's own two clicks write it (hq 0020 P2).
  const handoff = useAppStore((s) => s.deskHandoff);
  const setDeskHandoff = useAppStore((s) => s.setDeskHandoff);
  const addOutcome = useAppStore((s) => s.addOutcome);
  const card = handoff?.kind === 'tick' ? handoff : null;
  // True once this opening's own listing has arrived (not the last one's).
  const [fresh, setFresh] = useState(false);
  const cardBox = card ? findCardBox(decisions, card.file, card.box) : null;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setDecisions(await fetchDecisions());
      setFresh(true);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (decisionsOpen) {
      setFresh(false);
      setStates({});
      setMessage(null);
      void load();
    }
  }, [decisionsOpen, load]);

  useEffect(() => {
    if (!card || !decisions || !fresh) return;
    if (!cardBox) {
      setMessage(`The desk's card names D${card.box} in ${card.file}, which isn't an open box.`);
      addOutcome(card.thread, `D${card.box} isn't open in ${card.file}; nothing ticked`);
      setDeskHandoff(null);
      return;
    }
    const key = boxKey(cardBox);
    if (card.note) setNotes((s) => (s[key] ? s : { ...s, [key]: card.note }));
    document.getElementById('desk-card-box')?.scrollIntoView({ block: 'center' });
  }, [card, decisions, fresh, cardBox, addOutcome, setDeskHandoff]);

  useEffect(() => {
    if (!decisionsOpen && card) setDeskHandoff(null);
  }, [decisionsOpen, card, setDeskHandoff]);

  if (!decisionsOpen) return null;

  const decide = async (box: DecisionBox, choice: DecisionChoice) => {
    const key = boxKey(box);
    const until = choice === 'defer' ? deferUntil(days[key] ?? DEFER_DEFAULT) : undefined;
    setStates((s) => ({ ...s, [key]: 'posting' }));
    try {
      await decideDecision(box, choice, (notes[key] ?? '').trim(), until);
      setStates((s) => ({ ...s, [key]: `done:${choice}` }));
      setMessage(null);
      if (card && cardBox && boxKey(cardBox) === key) {
        const what = choice === 'tick' ? 'Ticked' : choice === 'decline' ? 'Kept the default on' : `Deferred to ${until}`;
        addOutcome(card.thread, `${what} D${box.number} on ${box.title}`);
        setDeskHandoff(null);
      }
      void refresh();
    } catch (e) {
      setStates((s) => ({ ...s, [key]: 'idle' }));
      setMessage(`D${box.number}: ${e instanceof Error ? e.message : String(e)}`);
      void load(); // the brief changed: show it as it is now
    }
  };

  return (
    <Drawer open onClose={() => setDecisionsOpen(false)} label="Decisions" width="narrow">
      <header className="flex items-center justify-between gap-2">
        <h2 className="text-ui-15 font-semibold" style={{ color: 'var(--color-text)' }}>
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
        days={days}
        message={message}
        now={Date.now()}
        onNote={(k, n) => setNotes((s) => ({ ...s, [k]: n }))}
        onDays={(k, d) => setDays((s) => ({ ...s, [k]: d }))}
        onArm={(k, c) => setStates((s) => ({ ...s, [k]: c ? `armed:${c}` : 'idle' }))}
        onDecide={(b, c) => void decide(b, c)}
        highlight={cardBox ? boxKey(cardBox) : null}
      />
    </Drawer>
  );
}
