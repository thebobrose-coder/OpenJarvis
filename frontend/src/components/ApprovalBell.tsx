import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Bell } from 'lucide-react';
import { useWaiting } from '../lib/WaitingContext';
import { groupItems, linkFor, staleSources, type WaitingItem } from '../lib/waiting-api';
import { WaitingListView } from './Waiting/WaitingListView';

/**
 * The header bell (hq 0020 P1): its count is everything waiting on the
 * operator, from the shared "Waiting on you" poll (the Dashboard panel shows
 * the same list). The dropdown groups rows by kind; a row opens the page
 * that holds its action, or the Decisions drawer. The upstream "Agent
 * approvals" source was dormant here and is replaced, not stacked.
 */
export function ApprovalBell() {
  const { waiting, setDecisionsOpen } = useWaiting();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const count = waiting?.counts.total ?? 0;

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const onOpen = (item: WaitingItem) => {
    setOpen(false);
    if (item.opens === 'decisions') setDecisionsOpen(true);
    else {
      const href = linkFor(item);
      if (href) navigate(href);
    }
  };

  return (
    <div ref={containerRef} className="fixed top-2 right-3 z-40">
      <button
        onClick={() => setOpen((o) => !o)}
        className="relative p-2 rounded-lg transition-colors cursor-pointer"
        title="Waiting on you"
        style={{
          color: count > 0 ? 'var(--color-text)' : 'var(--color-text-secondary)',
          background: open
            ? 'var(--color-bg-tertiary)'
            : count > 0
            ? 'color-mix(in srgb, var(--color-error) 8%, transparent)'
            : 'transparent',
        }}
      >
        <Bell size={17} />
        {count > 0 && (
          <span
            className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 flex items-center justify-center rounded-full text-[10px] font-bold px-1 leading-none"
            style={{ background: 'var(--color-error)', color: '#fff' }}
          >
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-1 rounded-xl shadow-2xl overflow-hidden flex flex-col"
          style={{
            width: '360px',
            maxHeight: '520px',
            background: 'var(--color-bg-secondary)',
            border: '1px solid var(--color-border)',
          }}
        >
          <div
            className="flex items-center justify-between px-4 py-3 shrink-0"
            style={{ borderBottom: '1px solid var(--color-border)' }}
          >
            <div className="flex items-center gap-2">
              <Bell size={13} style={{ color: 'var(--color-accent)' }} />
              <span className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
                Waiting on you
              </span>
            </div>
            <button
              onClick={() => {
                setOpen(false);
                setDecisionsOpen(true);
              }}
              className="text-[11px] cursor-pointer"
              style={{ color: 'var(--color-accent)', background: 'transparent', border: 'none' }}
            >
              Decisions
            </button>
          </div>
          <div className="overflow-y-auto flex-1 px-2 py-2">
            <WaitingListView
              groups={groupItems(waiting)}
              stale={staleSources(waiting)}
              now={Date.now()}
              compact
              perGroup={5}
              onOpen={onOpen}
            />
          </div>
        </div>
      )}
    </div>
  );
}
