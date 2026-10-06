import { ExternalLink, OctagonX } from 'lucide-react';
import type { TradingConfig, TradingStatus } from '../../lib/trading-api';
import { openExternal } from '../../lib/open-external';
import { DashboardPanel } from '../Dashboard/DashboardPanel';
import { shortDateTime } from '../shared/format';
import { SmallButton } from '../shared/ui';

export const AWS_FLAG_RULE = 'Cleared only on the approval page, by a human with MFA.';
export const LOCAL_FILE_RULE = 'Cleared only by the operator, by hand, in WSL.';
export const NO_URL_HINT = 'No approval page URL is configured on this machine ([trading] page_url in config.toml).';

function Indicator({ label, on, rule, sub, testId }: { label: string; on: boolean | null | 'unknown'; rule: string; sub?: string; testId: string }) {
  const state = on === true ? 'set' : on === false ? 'clear' : 'unknown';
  const color = state === 'set' ? 'var(--color-error)' : state === 'clear' ? 'var(--color-success)' : 'var(--color-text-tertiary)';
  return (
    <div className="flex flex-col gap-1 rounded-lg px-3 py-2" data-kill-indicator={testId} data-kill-state={state} style={{ background: 'var(--color-bg-secondary)' }}>
      <div className="flex items-center gap-2">
        <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: color }} aria-hidden />
        <span className="text-[12px] font-medium" style={{ color: 'var(--color-text)' }}>
          {label}
        </span>
        <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color }}>
          {state === 'set' ? 'KILL set' : state === 'clear' ? 'clear' : 'unknown'}
        </span>
      </div>
      {sub && (
        <span className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
          {sub}
        </span>
      )}
      <span className="text-[11px]" style={{ color: 'var(--color-text-secondary)' }}>
        {rule}
      </span>
    </div>
  );
}

/** The two kill indicators, each with where it is cleared, and the one
 * outbound control on the page: a link to the approval page in the system
 * browser (0014 D2). Nothing here writes anything. */
export function KillCard({ status, config, loading, error }: { status: TradingStatus | null; config: TradingConfig | null; loading?: boolean; error?: string | null }) {
  const kill = status?.kill;
  const url = config?.page_url_set ? config.page_url : null;
  return (
    <DashboardPanel icon={OctagonX} title="Kill switch" tag="Read-only" size="third" loading={loading} error={error}>
      <div className="flex flex-col gap-2">
        <Indicator
          testId="aws-flag"
          label="AWS flag"
          on={kill ? kill.aws_flag : null}
          rule={AWS_FLAG_RULE}
          sub={kill?.aws_checked_at ? `Checked ${shortDateTime(kill.aws_checked_at)}` : undefined}
        />
        <Indicator testId="local-file" label="Local file" on={kill ? kill.local_file : null} rule={LOCAL_FILE_RULE} />
        {kill?.last_cause && (
          <p className="text-[11.5px]" data-kill-cause style={{ color: 'var(--color-text-secondary)' }}>
            Last cause: {kill.last_cause}
            {kill.cleared_at ? ` · cleared ${shortDateTime(kill.cleared_at)}` : ''}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <span data-approval-link={url ? 'enabled' : 'disabled'}>
            <SmallButton
              disabled={!url}
              onClick={() => void openExternal(url ?? '')}
              title={url ? 'Opens the approval page in your browser; nothing is sent from here' : NO_URL_HINT}
            >
              <ExternalLink size={11} /> Open approval page
            </SmallButton>
          </span>
          {!url && (
            <span className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
              {NO_URL_HINT}
            </span>
          )}
        </div>
      </div>
    </DashboardPanel>
  );
}
