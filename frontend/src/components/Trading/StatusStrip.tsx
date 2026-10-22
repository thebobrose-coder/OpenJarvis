import { useState } from 'react';
import { CalendarClock, ChevronDown, ChevronUp, ExternalLink, OctagonX, Wallet } from 'lucide-react';
import { fmtUsdc, localTime, topRowGreen, type TradingConfig, type TradingStatus } from '../../lib/trading-api';
import { openExternal } from '../../lib/open-external';
import { shortDateTime } from '../shared/format';
import { SmallButton } from '../shared/ui';
import { KillCard, NO_URL_HINT } from './KillCard';
import { NightlyCard, SpendCard } from './SpendCard';

function Part({ icon: Icon, children }: { icon: typeof Wallet; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 min-w-0">
      <Icon size={13} style={{ color: 'var(--color-success)', flexShrink: 0 }} />
      <span className="truncate">{children}</span>
    </span>
  );
}

/**
 * The kill switch, x402 spend and nightly row. While all of it is fine
 * (`topRowGreen`) it folds to one line, with the approval link and a
 * Details toggle; anything off (a kill flag, spend at 80 % of the cap, no
 * report or off-VHD copy, no status yet) shows the full cards, unfolded.
 */
export function StatusStrip({
  status,
  config,
  loading,
  error,
}: {
  status: TradingStatus | null;
  config: TradingConfig | null;
  loading?: boolean;
  error?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const green = !loading && !error && topRowGreen(status);
  const full = (
    <div className="grid grid-cols-12 gap-4" data-status-row="full">
      <KillCard status={status} config={config} loading={loading} error={error} />
      <SpendCard status={status} loading={loading} error={error} />
      <NightlyCard status={status} loading={loading} error={error} />
    </div>
  );
  if (!green) return <div className="mb-4">{full}</div>;

  const k = status!.kill!;
  const x = status!.x402!;
  const n = status!.nightly!;
  const url = config?.page_url_set ? config.page_url : null;
  return (
    <div className="mb-4 flex flex-col gap-3">
      <div
        className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl px-4 py-2.5 text-[12px]"
        data-status-row="folded"
        style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text-secondary)' }}
      >
        <Part icon={OctagonX}>
          <span style={{ color: 'var(--color-text)' }}>Kill switch clear</span>
          {k.aws_checked_at ? ` · AWS checked ${localTime(k.aws_checked_at)}` : ''}
        </Part>
        <Part icon={Wallet}>
          <span style={{ color: 'var(--color-text)' }}>x402</span> {fmtUsdc(x.total_usdc)} of {fmtUsdc(x.daily_cap_usdc)} USDC · {x.payments} payment
          {x.payments === 1 ? '' : 's'}
        </Part>
        <Part icon={CalendarClock}>
          <span style={{ color: 'var(--color-text)' }}>Nightly</span> {n.last_report}
          {n.next_run ? ` · next ${shortDateTime(n.next_run)}` : ''}
          {n.last_backup_copy ? ` · copy ${shortDateTime(n.last_backup_copy)}` : ''}
        </Part>
        <span className="ml-auto inline-flex items-center gap-2">
          <span data-approval-link={url ? 'enabled' : 'disabled'}>
            <SmallButton
              disabled={!url}
              onClick={() => void openExternal(url ?? '')}
              title={url ? 'Opens the approval page in your browser; nothing is sent from here' : NO_URL_HINT}
            >
              <ExternalLink size={11} /> Approval page
            </SmallButton>
          </span>
          <SmallButton onClick={() => setOpen((o) => !o)} title="Show the kill switch, spend and nightly cards" aria-expanded={open}>
            Details {open ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
          </SmallButton>
        </span>
      </div>
      {open && full}
    </div>
  );
}
