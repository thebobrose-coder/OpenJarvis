import { useState } from 'react';
import { RefreshCw, Sparkles } from 'lucide-react';
import type { BriefingFocus, EcomBriefing, RefreshTarget } from '../../lib/commerce-api';
import type { RefreshStatus } from '../../hooks/useCommerceData';
import { DashboardPanel } from '../Dashboard/DashboardPanel';
import { REFRESH_NOTES } from './CommerceHeader';
import { ALL_STORES, shortDateTime } from './format';
import { Chip, Quiet, Segmented, SmallButton } from './ui';

const TABS: { value: BriefingFocus; label: string }[] = [
  { value: 'products', label: 'Products & research' },
  { value: 'growth', label: 'Content & ads' },
  { value: 'technical', label: 'Site & technical SEO' },
];

export function BriefingPanel({
  briefing,
  selectedStore,
  storeNames,
  refreshStatus,
  onRefresh,
  loading,
  error,
}: {
  briefing: EcomBriefing | null;
  selectedStore: string;
  storeNames: Record<string, string>;
  refreshStatus: Partial<Record<RefreshTarget, RefreshStatus>>;
  onRefresh: (target: RefreshTarget) => void;
  loading?: boolean;
  error?: string | null;
}) {
  const [tab, setTab] = useState<BriefingFocus>('products');
  const section = briefing?.sections?.[tab];
  const target: RefreshTarget = `ecom_briefing_${tab}`;
  const status = refreshStatus[target] ?? 'idle';
  const summaries = (section?.stores ?? []).filter(
    (s) => selectedStore === ALL_STORES || s.slug === selectedStore,
  );

  return (
    <DashboardPanel icon={Sparkles} title="Today’s briefing" tag="Daily" size="full" priority loading={loading} error={error}>
      {!briefing ? (
        <Quiet>No briefing yet -- Hermes writes it daily from 07:00.</Quiet>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Segmented ariaLabel="Briefing section" value={tab} onChange={setTab} options={TABS} />
            <div className="flex items-center gap-2">
              {section?.run_at && (
                <span className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
                  ran {shortDateTime(section.run_at)}
                </span>
              )}
              <SmallButton
                onClick={() => onRefresh(target)}
                disabled={status === 'queued'}
                title="Re-run this section (capped at 3 runs a day)"
              >
                <RefreshCw size={11} className={status === 'queued' ? 'animate-spin' : ''} />
                Refresh
              </SmallButton>
            </div>
          </div>

          {status !== 'idle' && (
            <Quiet>Refresh: {REFRESH_NOTES[status]}</Quiet>
          )}

          {!section ? (
            <Quiet>This section hasn’t run yet.</Quiet>
          ) : section.model_error ? (
            <div
              className="rounded-lg px-3 py-2 text-[12px]"
              style={{ border: '1px solid var(--color-warning)', color: 'var(--color-text-secondary)' }}
            >
              <span style={{ color: 'var(--color-warning)' }}>This section’s model step failed:</span>{' '}
              {section.model_error}
            </div>
          ) : (
            <>
              {section.headline && (
                <p className="text-[14px] leading-snug" style={{ color: 'var(--color-text)' }}>
                  {section.headline}
                </p>
              )}

              {summaries.length > 0 && (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  {summaries.map((s) => (
                    <div key={s.slug} className="flex flex-col gap-1.5 rounded-lg p-3" style={{ background: 'var(--color-bg-secondary)' }}>
                      <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--color-text-tertiary)' }}>
                        {storeNames[s.slug] ?? s.slug}
                      </span>
                      <p className="whitespace-pre-wrap">{s.summary}</p>
                      {tab === 'products' && (s.top_targets?.length ?? 0) > 0 && (
                        <div className="flex flex-col gap-1.5 mt-1">
                          <span className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--color-text-tertiary)' }}>
                            Top targets
                          </span>
                          {s.top_targets!.map((t) => (
                            <div
                              key={t.product_id}
                              className="rounded-md px-2 py-1.5"
                              style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
                            >
                              <div className="font-medium" style={{ color: 'var(--color-text)' }}>{t.title}</div>
                              <div>{t.why}</div>
                              <div className="mt-0.5" style={{ color: 'var(--color-accent)' }}>{t.suggested_action}</div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {(section.data_gaps?.length ?? 0) > 0 && (
                <details className="text-[11.5px]">
                  <summary className="cursor-pointer" style={{ color: 'var(--color-text-tertiary)' }}>
                    Data gaps ({section.data_gaps!.length})
                  </summary>
                  <ul className="mt-1 flex flex-col gap-0.5 list-disc pl-4">
                    {section.data_gaps!.map((g, i) => (
                      <li key={i}>{g}</li>
                    ))}
                  </ul>
                </details>
              )}

              {section.model && (
                <div>
                  <Chip tone="muted">{section.model}</Chip>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </DashboardPanel>
  );
}
