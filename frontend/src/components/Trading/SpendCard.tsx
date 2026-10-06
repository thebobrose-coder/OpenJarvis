import { CalendarClock, Wallet } from 'lucide-react';
import { fmtUsdc, money, type TradingStatus } from '../../lib/trading-api';
import { DashboardPanel } from '../Dashboard/DashboardPanel';
import { num, shortDateTime } from '../shared/format';
import { Quiet, Tile } from '../shared/ui';
import { Meter } from './Meter';

/** Today's x402 payments against the daily cap, the entry pool and the exit reserve. */
export function SpendCard({ status, loading, error }: { status: TradingStatus | null; loading?: boolean; error?: string | null }) {
  const x = status?.x402;
  const total = money(x?.total_usdc);
  const cap = money(x?.daily_cap_usdc) ?? 0;
  const over = x?.under_cap === false;
  return (
    <DashboardPanel icon={Wallet} title="x402 spend" tag={x?.day ?? 'Today'} size="third" loading={loading} error={error}>
      {!x ? (
        <Quiet>No spend reported yet.</Quiet>
      ) : (
        <div className="flex flex-col gap-3" data-spend-card>
          <Meter
            testId="spend"
            value={total}
            limit={cap}
            tone={over ? 'error' : total != null && cap > 0 && total / cap >= 0.8 ? 'warning' : 'accent'}
            label={`${num(x.payments)} payment${x.payments === 1 ? '' : 's'} today`}
            detail={`${fmtUsdc(x.total_usdc)} of ${fmtUsdc(x.daily_cap_usdc)} USDC`}
          />
          {over && (
            <p className="text-[11.5px]" role="status" style={{ color: 'var(--color-error)' }}>
              Over the daily cap: the trader stops paying for data until tomorrow.
            </p>
          )}
          <div className="grid grid-cols-2 gap-2">
            <Tile label="Entry pool" value={`${fmtUsdc(x.entry_pool_usdc)} USDC`} />
            <Tile label="Exit reserve" value={`${fmtUsdc(x.exit_reserve_usdc)} USDC`} />
          </div>
        </div>
      )}
    </DashboardPanel>
  );
}

/** The nightly report: last date, next run, last off-VHD copy. */
export function NightlyCard({ status, loading, error }: { status: TradingStatus | null; loading?: boolean; error?: string | null }) {
  const n = status?.nightly;
  return (
    <DashboardPanel icon={CalendarClock} title="Nightly" tag="05:20 UTC" size="third" loading={loading} error={error}>
      {!n ? (
        <Quiet>No nightly report yet.</Quiet>
      ) : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]" data-nightly>
          <dt style={{ color: 'var(--color-text-tertiary)' }}>Last report</dt>
          <dd className="tabular-nums" style={{ color: 'var(--color-text)' }}>
            {n.last_report ?? '—'}
          </dd>
          <dt style={{ color: 'var(--color-text-tertiary)' }}>Next run</dt>
          <dd className="tabular-nums" style={{ color: 'var(--color-text)' }}>
            {n.next_run ? shortDateTime(n.next_run) : '—'}
          </dd>
          <dt style={{ color: 'var(--color-text-tertiary)' }}>Last off-VHD copy</dt>
          <dd className="tabular-nums" style={{ color: n.last_backup_copy ? 'var(--color-text)' : 'var(--color-warning)' }}>
            {n.last_backup_copy ? shortDateTime(n.last_backup_copy) : 'none yet'}
          </dd>
        </dl>
      )}
    </DashboardPanel>
  );
}
