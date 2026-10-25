import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router';
import { CheckSquare, ExternalLink, Gavel, Info, Pencil } from 'lucide-react';
import { Chip, SmallButton } from '../shared/ui';
import { useAppStore, type DeskHandoff } from '../../lib/store';
import { useWaiting } from '../../lib/WaitingContext';
import { addRuling, DESK_DEFAULTS, LOCAL_ONLY, type DeskId } from '../../lib/desks-api';
import { deskIcon } from './deskIcon';
import { openUrl, outcomeLine, type DeskCard, type DroppedCard } from '../../lib/desk-cards';

const ICON = { open: ExternalLink, tick: CheckSquare, proposal_decision: Pencil, ruling: Gavel } as const;

function cardHint(card: DeskCard): string {
  switch (card.kind) {
    case 'open':
      if (card.page === '/stack') return 'Opens the Stack drawer. Run now stays its own button.';
      return card.draft
        ? `Opens ${card.page} on ${card.focus} with the draft in its message field. Nothing is sent.`
        : `Opens ${card.page}${card.focus ? ` on ${card.focus}` : ''}.`;
    case 'tick':
      return `Opens the Decisions drawer on D${card.box} (${card.file}); you confirm the tick there.`;
    case 'proposal_decision':
      return `Opens the ${card.decision} editor on /content, filled in. You submit it there.`;
    case 'ruling':
      return `Records this ruling for the desk: “${card.text}”`;
  }
}

/** A reply's cards as buttons, and the dropped ones as a visible note. Pure. */
export function DeskCardsView({
  cards,
  dropped,
  onCard,
  busy = null,
  done = [],
  disabled = false,
}: {
  cards: DeskCard[];
  dropped: DroppedCard[];
  onCard?: (card: DeskCard, index: number) => void;
  busy?: number | null;
  done?: number[];
  disabled?: boolean;
}) {
  if (cards.length === 0 && dropped.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-1.5" data-desk-cards>
      {cards.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {cards.map((card, i) => {
            const Icon = ICON[card.kind];
            const isDone = done.includes(i);
            return (
              <SmallButton
                key={i}
                tone={card.kind === 'ruling' ? 'neutral' : 'accent'}
                disabled={disabled || busy != null || (isDone && card.kind === 'ruling')}
                onClick={() => onCard?.(card, i)}
                title={cardHint(card)}
              >
                <Icon size={11} /> {card.label}
                {isDone && card.kind === 'ruling' ? ' ✓' : ''}
              </SmallButton>
            );
          })}
        </div>
      )}
      {dropped.map((d, i) => (
        <div key={i} role="note" className="text-[11px]" style={{ color: 'var(--color-warning, var(--color-text-tertiary))' }}>
          Dropped a card “{d.label}”: {d.reason}.
        </div>
      ))}
    </div>
  );
}

/** The thread's system line after an act ("Ruling recorded"). Pure. */
export function OutcomeLine({ text }: { text: string }) {
  return (
    <div className="flex justify-center mb-4" data-outcome>
      <span
        className="inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full"
        style={{ color: 'var(--color-text-secondary)', background: 'var(--color-bg-secondary)', border: '1px solid var(--color-border)' }}
      >
        <Info size={11} /> {text}
      </span>
    </div>
  );
}

/** A desk thread's header: which desk, its default route, the page context. Pure. */
export function DeskThreadHeader({ desk, context }: { desk: DeskId; context?: string }) {
  const info = DESK_DEFAULTS[desk];
  const Icon = deskIcon(desk);
  return (
    <div className="flex items-center gap-2 min-w-0 text-[12px]" data-desk-header>
      <Icon size={13} style={{ color: 'var(--color-accent)' }} />
      <span className="font-medium" style={{ color: 'var(--color-text)' }}>
        {info.name}
      </span>
      <Chip tone="neutral">
        {LOCAL_ONLY.includes(desk) ? 'local only' : info.default_route === 'hermes' ? 'Hermes by default' : 'local by default'}
      </Chip>
      {context && (
        <span className="truncate" style={{ color: 'var(--color-text-tertiary)' }} title={context}>
          Context: {context}
        </span>
      )}
    </div>
  );
}

export interface CardDeps {
  navigate: (to: string) => void;
  setHandoff: (h: DeskHandoff) => void;
  addOutcome: (thread: string, text: string) => void;
  openDecisions: () => void;
  /** The sidebar's Stack drawer (an Ops desk `open` to /stack). */
  openStack: () => void;
  addRuling: (desk: DeskId, text: string, thread: string) => Promise<unknown>;
}

/** What a click does. Every act goes through the page's existing control or
 * route: `open` navigates (a draft only prefills), `tick` opens the
 * Decisions drawer for its two-click confirm, `proposal_decision` opens the
 * editor filled in, `ruling` records one ruling. Only `ruling` writes. */
export async function runCard(card: DeskCard, thread: string, desk: DeskId, deps: CardDeps): Promise<void> {
  switch (card.kind) {
    case 'open':
      if (card.page === '/stack') {
        deps.openStack();
        deps.addOutcome(thread, outcomeLine(card, 'opened'));
        return;
      }
      if (card.draft) deps.setHandoff({ kind: 'draft', thread, page: card.page, focus: card.focus, draft: card.draft });
      deps.navigate(openUrl(card.page, card.focus));
      deps.addOutcome(thread, outcomeLine(card, 'opened'));
      return;
    case 'tick':
      deps.setHandoff({ kind: 'tick', thread, file: card.file, box: card.box, note: card.note });
      deps.openDecisions();
      return;
    case 'proposal_decision':
      deps.setHandoff({ kind: 'proposal_decision', thread, id: card.id, decision: card.decision, fields: card.fields });
      deps.navigate(`/content?focus=${encodeURIComponent(card.id)}`);
      deps.addOutcome(thread, outcomeLine(card, 'opened'));
      return;
    case 'ruling':
      try {
        await deps.addRuling(desk, card.text, thread);
        deps.addOutcome(thread, outcomeLine(card, 'done'));
      } catch (e) {
        deps.addOutcome(thread, e instanceof Error ? e.message : 'Ruling not recorded');
        throw e;
      }
  }
}

export function useDeskCardAction(thread: string, desk: DeskId) {
  const navigate = useNavigate();
  const setDeskHandoff = useAppStore((s) => s.setDeskHandoff);
  const addOutcome = useAppStore((s) => s.addOutcome);
  const setStackDrawerOpen = useAppStore((s) => s.setStackDrawerOpen);
  const { setDecisionsOpen } = useWaiting();
  const [busy, setBusy] = useState<number | null>(null);
  const [done, setDone] = useState<number[]>([]);

  const act = useCallback(
    async (card: DeskCard, index: number) => {
      setBusy(index);
      try {
        await runCard(card, thread, desk, {
          navigate,
          setHandoff: setDeskHandoff,
          addOutcome,
          openDecisions: () => setDecisionsOpen(true),
          openStack: () => setStackDrawerOpen(true),
          addRuling,
        });
        setDone((d) => [...d, index]);
      } catch {
        /* the thread shows why */
      } finally {
        setBusy(null);
      }
    },
    [thread, desk, navigate, setDeskHandoff, addOutcome, setDecisionsOpen, setStackDrawerOpen],
  );
  return { act, busy, done };
}

/** The cards under one desk reply, wired to their actions. */
export function DeskReplyCards({
  thread,
  desk,
  cards,
  dropped,
  isLive,
}: {
  thread: string;
  desk: DeskId;
  cards: DeskCard[];
  dropped: DroppedCard[];
  isLive: boolean;
}) {
  const { act, busy, done } = useDeskCardAction(thread, desk);
  return <DeskCardsView cards={cards} dropped={dropped} onCard={(c, i) => void act(c, i)} busy={busy} done={done} disabled={isLive} />;
}
