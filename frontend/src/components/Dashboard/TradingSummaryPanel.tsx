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
  positionPnlPct,
  signedPct,
  sleeveColor,
  sleeveLabel,
  sleeveNames,
  spendTone,
  staleness,
  stopDistancePct,
  stopTone,
  type Position,
  type TradingStatus,
} from '../../lib/trading-api';
import { firstBlock } from '../../lib/voice-api';
import { Meter } from '../Trading/Meter';
import { HaltPill } from '../Trading/TradingHeader';
import { num, shortDateTime } from '../shared/format';
import { Quiet, SmallButton } from '../shared/ui';
import { SpeakButton } from '../shared/SpeakButton';
import { DashboardPanel } from './DashboardPanel';
import { FeedAge } from './FeedAge';

const REFRESH_MS = 60 * 1000;

const STALE_AFTER_S = 15 * 60;

export const NO_STATUS = 'No trading status yet. The trader publishes it every 5 minutes.';

/** One open position as a line: what it is, which way and how much, how it
 * stands against its entry, and the room left before its stop (amber under
 * 2 %, red once through). Prices are on hover and on /trading. */
function PositionLine({ p }: { p: Position }) {
  const pnl = positionPnlPct(p);
  const stop = stopDistancePct(p);
  const tone = stopTone(stop);
  const hover = [
    `entry ${fmtMoney(p.entry)}`,
    p.mark != null ? `mark ${fmtMoney(p.mark)}` : null,
    p.stop ? `stop ${fmtMoney(p.stop)}` : null,
    p.held_days != null ? `held ${p.held_days} d` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <li className="flex flex-wrap items-baseline gap-x-2" data-summary-position title={hover}>
      <span className="font-medium" style={{ color: 'var(--color-text)' }}>
        {p.product}
      </span>
      <span style={{ color: 'var(--color-text-secondary)' }}>
        {String(p.side).toLowerCase()} {String(p.size)}
      </span>
      {pnl != null && (
        <span data-position-pnl style={{ color: pnl > 0 ? 'var(--color-success)' : pnl < 0 ? 'var(--color-error)' : 'var(--color-text-tertiary)' }}>
          {signedPct(pnl, 1)}
        </span>
      )}
      {stop != null && (
        <span className="text-ui-11" data-position-stop style={{ color: tone ? `var(--color-${tone})` : 'var(--color-text-tertiary)' }}>
          {stop <= 0 ? 'past stop' : `stop ${num(stop, 1)}% away`}
        </span>
      )}
    </li>
  );
}

/** The top line of the x402 paper trader for the Dashboard: halt state, today's
 * x402 spend against the cap, equity per sleeve with its open positions one line
 * each, and the stale or KILL warnings. Order activity lives on /trading. Read-only. */
export function TradingSummaryView({ status, now, onOpen }: { status: TradingStatus; now: number; onOpen?: () => void }) {
  const stale = staleness(status, now);
  const sleeves = sleeveNames(status);
  const hb = status.heartbeat;
  const hbBad = hb ? hb.last_ok === false || hb.alarm === 'ALARM' : false;
  const killed = sleeves.filter((n) => status.sleeves?.[n]?.halt_state === 'KILL');
  return (
    <div className="flex flex-col gap-3" data-trading-summary>
      {(stale.stale || hbBad || killed.length > 0) && (
        <ul className="flex flex-col gap-1 text-ui-12" data-trading-warnings>
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
            <p className="text-ui-11" role="status" style={{ color: 'var(--color-error)' }}>
              {OVER_CAP}
            </p>
          )}
        </div>
      ) : (
        <p className="text-ui-11" data-summary-spend style={{ color: 'var(--color-text-secondary)' }}>
          x402 spend not reported
        </p>
      )}

      {sleeves.length === 0 ? (
        <Quiet>Hermes could not read the trader’s status export.</Quiet>
      ) : (
        <ul className="flex flex-col gap-1.5" data-trading-sleeves>
          {sleeves.map((name) => {
            const s = status.sleeves![name];
            const positions = s.positions ?? [];
            return (
              <li key={name} className="flex flex-col gap-1 text-ui-12">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium" style={{ color: 'var(--color-text)', minWidth: '4.5rem' }}>
                    {sleeveLabel(name)}
                  </span>
                  <HaltPill state={s.halt_state} />
                  <span className="tabular-nums" style={{ color: 'var(--color-text)' }}>
                    {fmtMoney(s.equity)}
                  </span>
                  <span className="tabular-nums text-ui-11" style={{ color: 'var(--color-text-tertiary)' }}>
                    drawdown {s.drawdown_pct ?? '—'}% · {positions.length} open
                  </span>
                </div>
                {positions.length > 0 && (
                  <ul
                    className="ml-1 flex flex-col gap-0.5 pl-2 text-ui-11-5 tabular-nums"
                    data-summary-positions={name}
                    style={{ borderLeft: `2px solid ${sleeveColor(name)}` }}
                  >
                    {positions.map((p, i) => (
                      <PositionLine key={`${p.product}-${i}`} p={p} />
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}

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
      size="quarter"
      band="short"
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
          <FeedAge label="Trading" ageSeconds={status.age_seconds} stale={status.stale} staleAfterSeconds={STALE_AFTER_S} />
        </div>
      )}
    </DashboardPanel>
  );
}
