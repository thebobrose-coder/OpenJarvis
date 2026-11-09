import { Activity, FileText, Inbox, LayoutList, X } from 'lucide-react';
import { useNavigate } from 'react-router';
import { parseCards, type DeskCard, type DroppedCard } from '../../lib/desk-cards';
import { DESK_DEFAULTS, type DeskId } from '../../lib/desks-api';
import { useAppStore } from '../../lib/store';
import { useOpenWaitingItem, useWaiting } from '../../lib/WaitingContext';
import { groupItems, staleSources, bellCount, type Waiting, type WaitingItem } from '../../lib/waiting-api';
import type { Conversation } from '../../types';
import { deskTrace } from '../../pages/DesksPage';
import type { TraceRow } from '../Desks/DesksView';
import { DeskReplyCards } from '../Desks/DeskCards';
import { ToolCallCard } from './ToolCallCard';
import { WaitingListView, type RowActions } from '../Waiting/WaitingListView';
import { Quiet, SmallButton } from '../shared/ui';

/** The rail shows this many "For you" rows before "Show all" (on the Inbox page). */
export const RAIL_ROWS = 12;
/** And this many trace rows. */
export const RAIL_TRACE = 12;

function Section({ icon: Icon, title, tag, children }: { icon: typeof Inbox; title: string; tag?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2 min-h-0">
      <h3 className="flex items-center gap-1.5 text-ui-11 font-semibold uppercase tracking-wide" style={{ color: 'var(--color-text-tertiary)' }}>
        <Icon size={12} style={{ color: 'var(--color-accent)' }} />
        {title}
        {tag && <span className="ml-auto font-normal normal-case tracking-normal tabular-nums">{tag}</span>}
      </h3>
      {children}
    </section>
  );
}

/** What the thread was opened with: the context block's label, and the block on demand. */
export function threadContext(conv: Conversation | undefined): { block: string; label: string } | null {
  if (!conv) return null;
  return conv.pendingContext ?? conv.messages.find((m) => m.context)?.context ?? null;
}

/** The newest assistant reply that carries cards, with its parsed cards. */
export function latestCards(conv: Conversation | undefined, desk: DeskId): { messageId: string; cards: DeskCard[]; dropped: DroppedCard[] } | null {
  if (!conv) return null;
  for (let i = conv.messages.length - 1; i >= 0; i--) {
    const m = conv.messages[i];
    if (m.role !== 'assistant' || !m.content) continue;
    const parsed = parseCards(m.content, DESK_DEFAULTS[desk]);
    if (parsed.cards.length || parsed.dropped.length) return { messageId: m.id, cards: parsed.cards, dropped: parsed.dropped };
  }
  return null;
}

export interface DeskRailProps {
  conv: Conversation;
  desk: DeskId;
  trace: TraceRow[];
  live: boolean;
  now: number;
  /** The streaming thread's cards stay disabled until the reply finishes. */
  isLive: boolean;
}

/** A desk thread's rail: its context block, the latest reply's cards, and the live tool trace. */
export function DeskRail({ conv, desk, trace, live, now, isLive }: DeskRailProps) {
  const context = threadContext(conv);
  const cards = latestCards(conv, desk);
  const shown = trace.slice(0, RAIL_TRACE);
  return (
    <div className="flex flex-col gap-5" data-rail="desk">
      <Section icon={FileText} title="Context">
        {context ? (
          <details className="rounded-lg px-3 py-2 text-ui-12" style={{ background: 'var(--color-bg-secondary)' }}>
            <summary className="cursor-pointer" style={{ color: 'var(--color-text)' }}>
              {context.label}
            </summary>
            <pre className="mt-2 whitespace-pre-wrap break-words text-ui-11 font-mono max-h-80 overflow-y-auto" style={{ color: 'var(--color-text-secondary)' }} data-context-block>
              {context.block}
            </pre>
          </details>
        ) : (
          <Quiet>No page context: this thread started from Chat.</Quiet>
        )}
      </Section>

      <Section icon={LayoutList} title="Cards" tag={cards ? `${cards.cards.length}` : undefined}>
        {cards ? (
          <DeskReplyCards thread={conv.id} desk={desk} cards={cards.cards} dropped={cards.dropped} isLive={isLive} />
        ) : (
          <Quiet>No cards yet. A desk reply can propose an open, a tick or a ruling; you act on it here or under the reply.</Quiet>
        )}
      </Section>

      <Section icon={Activity} title="Tool trace" tag={live ? 'live' : trace.length ? `${trace.length}` : undefined}>
        {shown.length === 0 ? (
          <Quiet>No tool calls yet in this desk’s threads.</Quiet>
        ) : (
          <ul className="flex flex-col gap-2" data-rail-trace>
            {shown.map((row) => (
              <li key={row.key} className="flex flex-col gap-1">
                <span className="text-ui-11" style={{ color: 'var(--color-text-tertiary)' }}>
                  {row.thread === conv.id ? 'this thread' : 'another thread'} · {row.route === 'hermes' ? 'Hermes' : 'local'} · {Math.max(0, Math.round((now - row.at) / 60000))} min ago
                </span>
                <ToolCallCard toolCall={row.call} />
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

/** A plain chat's rail: the Waiting "For you" lane, as on the Dashboard. */
export function WaitingRail({
  waiting,
  loading,
  error,
  now,
  onOpen,
  onInbox,
  actions,
}: {
  waiting: Waiting | null;
  loading: boolean;
  error: string | null;
  now: number;
  onOpen: (item: WaitingItem) => void;
  onInbox: () => void;
  actions?: RowActions;
}) {
  return (
    <div className="flex flex-col gap-3" data-rail="waiting">
      <Section icon={Inbox} title="For you" tag={waiting ? `${bellCount(waiting)}` : undefined}>
        {!waiting ? (
          <Quiet>{loading ? 'Loading…' : error ?? 'Nothing waiting on you'}</Quiet>
        ) : (
          <WaitingListView groups={groupItems(waiting, 'act')} stale={staleSources(waiting)} now={now} compact limit={RAIL_ROWS} onMore={onInbox} onOpen={onOpen} actions={actions} />
        )}
      </Section>
      <div>
        <SmallButton onClick={onInbox} title="Every lane: For you, Dispatch, Filed">
          Open the Inbox
        </SmallButton>
      </div>
    </div>
  );
}

/**
 * Chat's right rail (widescreen plan 4.8), replacing the upstream System panel: for
 * a desk thread its context, cards and live tool trace; for a plain chat the
 * Waiting "For you" lane. Ctrl/Cmd+I toggles it. A third of the window at 3xl.
 */
export function ContextRail() {
  const conv = useAppStore((s) => s.conversations.find((c) => c.id === s.activeId));
  const conversations = useAppStore((s) => s.conversations);
  const streamState = useAppStore((s) => s.streamState);
  const toggle = useAppStore((s) => s.toggleSystemPanel);
  const { waiting, loading, error, rowActions } = useWaiting();
  const { openItem } = useOpenWaitingItem();
  const navigate = useNavigate();
  const desk = conv?.desk;
  const now = Date.now();
  const live = streamState.isStreaming ? { conversationId: streamState.conversationId, calls: streamState.activeToolCalls } : undefined;
  const trace = desk ? deskTrace(conversations, desk, live) : [];
  const title = desk ? DESK_DEFAULTS[desk].name : 'Waiting on you';
  return (
    <aside
      className="w-[22rem] 3xl:w-[clamp(28rem,30vw,44rem)] shrink-0 h-full overflow-y-auto flex flex-col gap-4 p-4"
      style={{ borderLeft: '1px solid var(--color-border)', background: 'var(--color-surface)' }}
      aria-label="Context rail"
      data-context-rail
    >
      <header className="flex items-center justify-between gap-2">
        <span className="text-ui-13 font-semibold" style={{ color: 'var(--color-text)' }}>
          {title}
        </span>
        <button onClick={toggle} aria-label="Hide the context rail" title="Hide (Ctrl+I)" className="cursor-pointer p-1" style={{ background: 'transparent', border: 'none', color: 'var(--color-text-tertiary)' }}>
          <X size={14} />
        </button>
      </header>
      {desk && conv ? (
        <DeskRail
          conv={conv}
          desk={desk}
          trace={trace}
          live={!!live && trace.some((r) => r.key.startsWith('live:'))}
          now={now}
          isLive={!!live && live.conversationId === conv.id}
        />
      ) : (
        <WaitingRail waiting={waiting} loading={loading} error={error} now={now} onOpen={openItem} onInbox={() => navigate('/inbox')} actions={rowActions} />
      )}
    </aside>
  );
}
