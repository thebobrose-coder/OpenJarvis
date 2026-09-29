import { Megaphone } from 'lucide-react';
import type { DailyStore } from '../../lib/commerce-api';
import { DashboardPanel } from '../Dashboard/DashboardPanel';
import { money, num, ratio } from './format';
import { Quiet } from '../shared/ui';

/**
 * Google Ads, as GA4 reports it (ecom_daily.ga4.ads). Per-day history isn't
 * in the feed yet; a trend chart joins here once it is.
 */
export function AdsPanel({ stores, loading, error }: { stores: DailyStore[]; loading?: boolean; error?: string | null }) {
  const connected = stores.filter((s) => s.ga4?.connected);
  const multi = stores.length > 1;
  const campaigns = connected.flatMap((s) =>
    (s.ga4?.ads?.campaigns ?? []).map((c) => ({ ...c, store: s.display_name, currency: s.sales?.currency ?? null })),
  );
  const queries = connected.flatMap((s) =>
    (s.ga4?.ads?.top_queries ?? []).map((row) => ({ row, store: s.display_name })),
  );
  const queryColumns = [...new Set(queries.flatMap((q) => Object.keys(q.row)))];

  return (
    <DashboardPanel icon={Megaphone} title="Ads" tag="GA4 · 28 d" size="half" loading={loading} error={error}>
      {connected.length === 0 ? (
        <Quiet>
          {stores.length === 0 ? 'No store data yet.' : 'GA4 isn’t connected, so there’s no ads data to show.'}
        </Quiet>
      ) : (
        <div className="flex flex-col gap-3">
          {campaigns.length === 0 ? (
            <Quiet>No campaigns have run yet.</Quiet>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12px] tabular-nums">
                <thead>
                  <tr style={{ color: 'var(--color-text-tertiary)' }}>
                    <th className="py-1.5 px-2 text-left font-medium">Campaign</th>
                    <th className="py-1.5 px-2 text-right font-medium">Cost</th>
                    <th className="py-1.5 px-2 text-right font-medium">Clicks</th>
                    <th className="py-1.5 px-2 text-right font-medium">Impr.</th>
                    <th className="py-1.5 px-2 text-right font-medium">Revenue</th>
                    <th className="py-1.5 px-2 text-right font-medium">ROAS</th>
                  </tr>
                </thead>
                <tbody>
                  {campaigns.map((c, i) => {
                    const roas = ratio(c.purchaseRevenue, c.advertiserAdCost);
                    return (
                      <tr key={i} style={{ borderTop: '1px solid var(--color-border)' }}>
                        <td className="py-1.5 px-2">
                          <div style={{ color: 'var(--color-text)' }}>{c.sessionGoogleAdsCampaignName || '(unnamed)'}</div>
                          {multi && <div className="text-[10.5px]" style={{ color: 'var(--color-text-tertiary)' }}>{c.store}</div>}
                        </td>
                        <td className="py-1.5 px-2 text-right">{money(c.advertiserAdCost ?? 0, c.currency)}</td>
                        <td className="py-1.5 px-2 text-right">{num(c.advertiserAdClicks)}</td>
                        <td className="py-1.5 px-2 text-right">{num(c.advertiserAdImpressions)}</td>
                        <td className="py-1.5 px-2 text-right">{money(c.purchaseRevenue ?? 0, c.currency)}</td>
                        <td className="py-1.5 px-2 text-right">{roas == null ? '—' : `${num(roas, 2)}×`}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--color-text-tertiary)' }}>
              Top ads search queries
            </span>
            {queries.length === 0 ? (
              <Quiet>None yet.</Quiet>
            ) : (
              <table className="w-full text-[12px] tabular-nums">
                <tbody>
                  {queries.slice(0, 10).map(({ row, store }, i) => (
                    <tr key={i} style={{ borderTop: i ? '1px solid var(--color-border)' : undefined }}>
                      {queryColumns.map((k) => {
                        const v = row[k];
                        return (
                          <td key={k} className={`py-1 px-2 ${typeof v === 'number' ? 'text-right' : ''}`}>
                            {typeof v === 'number' ? num(v, 2) : String(v ?? '')}
                          </td>
                        );
                      })}
                      {multi && <td className="py-1 px-2 text-[10.5px]" style={{ color: 'var(--color-text-tertiary)' }}>{store}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {connected.length < stores.length && (
            <Quiet>
              GA4 not connected for {stores.filter((s) => !s.ga4?.connected).map((s) => s.display_name).join(', ')}.
            </Quiet>
          )}
        </div>
      )}
    </DashboardPanel>
  );
}
