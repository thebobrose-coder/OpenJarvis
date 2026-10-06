import { AlertTriangle, CheckCircle2, HeartPulse, OctagonX } from 'lucide-react';
import {
  haltTone,
  killCause,
  killWhen,
  sleeveLabel,
  sleeveNames,
  staleness,
  type HaltState,
  type TradingStatus,
} from '../../lib/trading-api';
import { FeedFreshness } from '../Dashboard/FeedFreshness';
import { shortDateTime } from '../shared/format';
import { Chip } from '../shared/ui';

export const STALE_BANNER = 'Status is stale: the trader may be silent. Check the sleeves in WSL and the approval page.';

/** A halt state as a pill: icon plus word, never color alone. */
export function HaltPill({ state, children }: { state: HaltState | null | undefined; children?: React.ReactNode }) {
  const tone = haltTone(state);
  const Icon = state === 'KILL' ? OctagonX : state === 'DEGRADED' ? AlertTriangle : state === 'NORMAL' ? CheckCircle2 : HeartPulse;
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold"
      data-halt={state ?? 'unknown'}
      style={{
        color: `var(--color-${tone === 'neutral' ? 'text-secondary' : tone})`,
        border: `1px solid var(--color-${tone === 'neutral' ? 'border' : tone})`,
        background: tone === 'error' ? 'color-mix(in srgb, var(--color-error) 12%, transparent)' : 'transparent',
      }}
    >
      <Icon size={12} /> {state ?? 'unknown'}
      {children}
    </span>
  );
}

/** Mode, the sleeves' halt states, the heartbeat, the status age and the
 * installed commit. The stale banner sits under it. */
export function TradingHeader({ status, now }: { status: TradingStatus | null; now: number }) {
  const stale = staleness(status, now);
  const hb = status?.heartbeat;
  const hbBad = hb ? hb.last_ok === false || hb.alarm === 'ALARM' : false;
  return (
    <header className="flex flex-col gap-3 mb-6" data-trading-header>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold" style={{ color: 'var(--color-text)' }}>
            Trading
          </h1>
          <p className="text-sm mt-1" style={{ color: 'var(--color-text-secondary)' }}>
            The x402 paper trader as it reports itself. This page shows and never acts.
          </p>
        </div>
        {status && (
          <div className="flex flex-wrap items-center gap-2">
            <Chip tone="muted" title="The trader's mode">
              {status.mode ?? 'mode unknown'}
            </Chip>
            {status.app?.installed_commit && (
              <Chip tone="neutral" title={status.app.run_from ? `Runs from ${status.app.run_from}` : 'Installed commit'}>
                commit {status.app.installed_commit}
              </Chip>
            )}
          </div>
        )}
      </div>

      {status && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[11.5px]" style={{ color: 'var(--color-text-secondary)' }}>
          {sleeveNames(status).map((name) => {
            const s = status.sleeves?.[name];
            const when = s?.halt_state === 'KILL' ? killWhen(status, name) : null;
            const cause = s?.halt_state === 'KILL' ? killCause(status) : null;
            return (
              <span key={name} className="inline-flex items-center gap-1.5" data-sleeve-pill={name}>
                <span style={{ color: 'var(--color-text)' }}>{sleeveLabel(name)}</span>
                <HaltPill state={s?.halt_state}>
                  {s?.halt_state === 'KILL' && (cause || when) && (
                    <span className="font-normal" data-kill-detail>
                      · {cause ?? 'cause unknown'}
                      {when ? ` · ${shortDateTime(when)}` : ''}
                    </span>
                  )}
                </HaltPill>
              </span>
            );
          })}
          {hb && (
            <span className="inline-flex items-center gap-1.5" data-heartbeat={hbBad ? 'alarm' : 'ok'} style={{ color: hbBad ? 'var(--color-error)' : undefined }}>
              <HeartPulse size={12} />
              Heartbeat {hb.last_sent_at ? shortDateTime(hb.last_sent_at) : 'never'} · {hb.alarm ?? 'unknown'}
              {hb.last_ok === false ? ' · last send failed' : ''}
            </span>
          )}
          {status.written_at && (
            <span style={{ color: 'var(--color-text-tertiary)' }}>Status written {shortDateTime(status.written_at)}</span>
          )}
          <FeedFreshness label="Status" ageSeconds={status.age_seconds} stale={status.stale} staleAfterSeconds={15 * 60} />
        </div>
      )}

      {stale.stale && (
        <div
          className="flex items-center gap-2 rounded-lg px-3 py-2 text-[12px]"
          role="alert"
          data-stale-banner
          style={{ border: '1px solid var(--color-warning)', color: 'var(--color-text)', background: 'color-mix(in srgb, var(--color-warning) 10%, transparent)' }}
        >
          <AlertTriangle size={14} style={{ color: 'var(--color-warning)', flexShrink: 0 }} />
          <span>
            {STALE_BANNER}
            {stale.reason ? ` (${stale.reason})` : ''}
          </span>
        </div>
      )}
    </header>
  );
}
