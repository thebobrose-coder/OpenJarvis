import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { ArrowRight, CandlestickChart } from 'lucide-react';
import {
  fetchTradingFeed,
  fmtMoney,
  fmtUsdc,
  killCause,
  killWhen,
  money,
  OVER_CAP,
  recentEvents,
  sleeveLabel,
  sleeveNames,
  spendTone,
  staleness,
  type TradingStatus,
} from '../../lib/trading-api';
import { firstBlock } from '../../lib/voice-api';
import { Meter } from '../Trading/Meter';
import { HaltPill } from '../Trading/TradingHeader';
import { shortDateTime } from '../shared/format';
import { Chip, Quiet, SmallButton } from '../shared/ui';
import { SpeakButton } from '../shared/SpeakButton';
import { DashboardPanel } from './DashboardPanel';
import { FeedFreshness } from './FeedFreshness';

const REFRESH_MS = 60 * 1000;
const STALE_AFTER_S = 15 * 60;

/** Event types that describe order activity: the trader's proposals, the
 * gate's verdicts, HITL decisions, fills. The newest one is the "latest
 * order recommendation" line. */
export const ORDER_EVENT_TYPES = new Set(['PROPOSAL', 'GATE', 'HITL', 'FILL', 'ORDER', 'EXIT']);

export const NO_STATUS = 'No trading status yet. The trader publishes it every 5 minutes.';

/** The top line of the x402 paper trader for the Dashboard: halt state and
 * today's x402
 * spend against the cap, equity per sleeve, open positions, the latest order
 * activity, and the stale or KILL warnings. Read-only; the link opens /trading. */
export function TradingSummaryView({ status, now, onOpen }: { status: TradingStatus; now: number; onOpen?: () => void }) {
  const stale = staleness(status, now);
  const sleeves = sleeveNames(status);
  const positions = sleeves.flatMap((name) => (status.sleeves?.[name]?.positions ?? []).map((p) => ({ ...p, sleeve: name })));
  const latest = recentEvents(status).find((e) => ORDER_EVENT_TYPES.has(e.type)) ?? null;
  const hb = status.heartbeat;
  const hbBad = hb ? hb.last_ok === false || hb.alarm === 'ALARM' : false;
  const killed = sleeves.filter((n) => status.sleeves?.[n]?.halt_state === 'KILL');
  return (
    <div className="flex flex-col gap-3" data-trading-summary>
      {(stale.stale || hbBad || killed.length > 0) && (
        <ul className="flex flex-col gap-1 text-[12px]" data-trading-warnings>
          {killed.map((n) => (
            <li key={n} style={{ color: 'var(--color-error)' }}>
              {sleeveLabel(n)} is in KILL{killCause(status) ? `: ${killCause(status)}` : ''}
              {killWhen(status, n) ? ` (${shortDateTime(killWhen(status, n))})` : ''}. Cleared only on the approval page with MFA, or by the operator in WSL.
            </li>
          ))}
          {hbBad && <li style={{ color: 'var(--color-error)' }}>Heartbeat alarm: the trader is not reporting to AWS.</li>}
          {stale.stale && (
            <li style={{ color: 'var(--color-warning)' }}>
              Status is stale{stale.reason ? ` (${stale.reason})` : ''}.
            </li>
          )}
        </ul>
      )}

      {status.x402 ? (
        <div className="flex flex-col gap-1" data-summary-spend>
          <Meter
            testId="summary-spend"
            value={money(status.x402.total_usdc)}
            limit={money(status.x402.daily_cap_usdc) ?? 0}
            tone={spendTone(status.x402)}
            label={`x402 today: ${status.x402.payments} payment${status.x402.payments === 1 ? '' : 's'}`}
            detail={`${fmtUsdc(status.x402.total_usdc)} of ${fmtUsdc(status.x402.daily_cap_usdc)} USDC`}
          />
          {status.x402.under_cap === false && (
            <p className="text-[11px]" role="status" style={{ color: 'var(--color-error)' }}>
              {OVER_CAP}
            </p>
          )}
        </div>
      ) : (
        <p className="text-[11px]" data-summary-spend style={{ color: 'var(--color-text-secondary)' }}>
          x402 spend not reported
        </p>
      )}

      {sleeves.length === 0 ? (
        <Quiet>Hermes could not read the trader’s status export.</Quiet>
      ) : (
        <ul className="flex flex-col gap-1.5" data-trading-sleeves>
          {sleeves.map((name) => {
            const s = status.sleeves![name];
            return (
              <li key={name} className="flex flex-wrap items-center gap-2 text-[12px]">
                <span className="font-medium" style={{ color: 'var(--color-text)', minWidth: '4.5rem' }}>
                  {sleeveLabel(name)}
                </span>
                <HaltPill state={s.halt_state} />
                <span className="tabular-nums" style={{ color: 'var(--color-text)' }}>
                  {fmtMoney(s.equity)}
                </span>
                <span className="tabular-nums text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
                  drawdown {s.drawdown_pct ?? '—'}% · {(s.positions ?? []).length} open
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-col gap-1">
        <span className="text-[11px] font-medium" style={{ color: 'var(--color-text-secondary)' }}>
          Open positions ({positions.length})
        </span>
        {positions.length === 0 ? (
          <Quiet>No open positions.</Quiet>
        ) : (
          <ul className="flex flex-col gap-0.5 text-[12px] tabular-nums" data-summary-positions style={{ color: 'var(--color-text)' }}>
            {positions.slice(0, 6).map((p, i) => (
              <li key={`${p.sleeve}-${p.product}-${i}`}>
                {p.side} {String(p.size)} {p.product} @ {fmtMoney(p.entry)}
                {p.stop ? ` · stop ${fmtMoney(p.stop)}` : ''}
                {p.held_days != null ? ` · ${p.held_days} d` : ''}
                <span style={{ color: 'var(--color-text-tertiary)' }}> · {sleeveLabel(p.sleeve)}</span>
              </li>
            ))}
            {positions.length > 6 && <li style={{ color: 'var(--color-text-tertiary)' }}>+{positions.length - 6} more on the Trading page</li>}
          </ul>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-[11px] font-medium" style={{ color: 'var(--color-text-secondary)' }}>
          Latest order activity
        </span>
        {latest ? (
          <p className="flex flex-wrap items-baseline gap-2 text-[12px]" data-latest-order>
            <span className="tabular-nums" style={{ color: 'var(--color-text-tertiary)' }}>
              {shortDateTime(latest.ts)}
            </span>
            <Chip tone="accent">{latest.type}</Chip>
            <span style={{ color: 'var(--color-text-tertiary)' }}>{sleeveLabel(latest.sleeve)}</span>
            {latest.summary && <span style={{ color: 'var(--color-text)' }}>{latest.summary}</span>}
          </p>
        ) : (
          <Quiet>No proposals or fills in the recent events.</Quiet>
        )}
      </div>

      {onOpen && (
        <div className="flex justify-end pt-1" data-summary-footer>
          <SmallButton onClick={onOpen} title="The full Trading view">
            Trading view <ArrowRight size={11} />
          </SmallButton>
        </div>
      )}
    </div>
  );
}

/** The Dashboard's Trading Summary: `trading_status` every minute, the
 * speech block's speaker when Hermes includes one, and the feed's age. */
export function TradingSummaryPanel() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<TradingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      setStatus(await fetchTradingFeed<TradingStatus>('trading_status'));
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load.');
    } finally {
      setLoading(false);
      setNow(Date.now());
    }
  }, []);

  useEffect(() => {
    void load();
    const interval = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(interval);
  }, [load]);

  const block = firstBlock(status?.speech);
  return (
    <DashboardPanel
      icon={CandlestickChart}
      title="Trading Summary"
      tag="Paper · 5 min"
      size="half"
      priority
      loading={loading}
      error={error}
      actions={<SpeakButton feed="trading_status" block={block} />}
    >
      {!status ? (
        <Quiet>{NO_STATUS}</Quiet>
      ) : (
        <div className="flex flex-col gap-2">
          <TradingSummaryView status={status} now={now} onOpen={() => navigate('/trading')} />
          <FeedFreshness ageSeconds={status.age_seconds} stale={status.stale} staleAfterSeconds={STALE_AFTER_S} />
        </div>
      )}
    </DashboardPanel>
  );
}
