import { useLocation, useNavigate } from 'react-router';
import { Bell } from 'lucide-react';
import { useWaiting } from '../lib/WaitingContext';
import { bellCount } from '../lib/waiting-api';

/**
 * The header bell (hq 0020 P1, 0023 D1): its count is the For you lane, what only the
 * operator can do, from the shared "Waiting on you" poll. Since the widescreen plan
 * (Phase 1) it is a badge that opens the Inbox page, where the three lanes have the
 * whole width; the 380 px dropdown is gone. The upstream "Agent approvals" source was
 * dormant here and is replaced, not stacked.
 */
export function ApprovalBell() {
  const { waiting } = useWaiting();
  const navigate = useNavigate();
  const location = useLocation();
  const count = bellCount(waiting);
  const onInbox = location.pathname === '/inbox';

  return (
    <div className="fixed top-2 right-3 z-40">
      <button
        onClick={() => navigate('/inbox')}
        className="relative p-2 rounded-lg transition-colors cursor-pointer"
        title={count ? `${count} waiting on you · open the Inbox` : 'Inbox'}
        aria-label="Inbox"
        style={{
          color: count > 0 ? 'var(--color-text)' : 'var(--color-text-secondary)',
          background: onInbox
            ? 'var(--color-bg-tertiary)'
            : count > 0
            ? 'color-mix(in srgb, var(--color-error) 8%, transparent)'
            : 'transparent',
        }}
      >
        <Bell size={17} />
        {count > 0 && (
          <span
            className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 flex items-center justify-center rounded-full text-ui-10 font-bold px-1 leading-none"
            style={{ background: 'var(--color-error)', color: '#fff' }}
          >
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>
    </div>
  );
}
