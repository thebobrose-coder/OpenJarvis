import { RefreshCw } from 'lucide-react';
import type { FeedName, RefreshTarget, StoreRef } from '../../lib/commerce-api';
import type { FeedStates, RefreshStatus } from '../../hooks/useCommerceData';
import { FeedFreshness } from '../Dashboard/FeedFreshness';
import { ALL_STORES } from './format';
import { Segmented, SmallButton } from '../shared/ui';

const DAY = 24 * 3600;

// Label and "too old" threshold per feed: the daily feeds get 26 h, the
// weekly SEO audit 8 days.
const FEED_LABELS: { feed: FeedName; label: string; staleAfter: number }[] = [
  { feed: 'ecom_daily', label: 'Data', staleAfter: 26 * 3600 },
  { feed: 'ecom_products', label: 'Products', staleAfter: 26 * 3600 },
  { feed: 'ecom_briefing', label: 'Briefing', staleAfter: 26 * 3600 },
  { feed: 'ecom_recommendations', label: 'Ledger', staleAfter: 26 * 3600 },
  { feed: 'ecom_seo_health', label: 'SEO audit', staleAfter: 8 * DAY },
  { feed: 'compliance_findings', label: 'Compliance', staleAfter: 26 * 3600 },
];

const REFRESH_BUTTONS: { target: RefreshTarget; label: string; title: string }[] = [
  { target: 'ecom_daily', label: 'Data', title: 'Re-collect store KPIs, products and ads data' },
  { target: 'ecom_seo_health', label: 'SEO audit', title: 'Re-run the technical SEO audit (takes several minutes)' },
  { target: 'ecom_briefing', label: 'Briefing', title: 'Re-run all three briefing sections (each is capped at 3 runs a day)' },
];

export const REFRESH_NOTES: Record<Exclude<RefreshStatus, 'idle'>, string> = {
  queued: 'queued -- checking back in a few minutes',
  updated: 'updated',
  unchanged: 'no new run yet (still running, or today’s cap was reached)',
  error: 'couldn’t reach Hermes',
};

export function CommerceHeader({
  stores,
  selected,
  onSelect,
  feeds,
  refreshStatus,
  onRefresh,
}: {
  stores: StoreRef[];
  selected: string;
  onSelect: (slug: string) => void;
  feeds: FeedStates;
  refreshStatus: Partial<Record<RefreshTarget, RefreshStatus>>;
  onRefresh: (target: RefreshTarget) => void;
}) {
  const notes = REFRESH_BUTTONS.filter((b) => (refreshStatus[b.target] ?? 'idle') !== 'idle');

  return (
    <header className="flex flex-col gap-3 mb-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold" style={{ color: 'var(--color-text)' }}>
            Commerce
          </h1>
          <p className="text-sm mt-1" style={{ color: 'var(--color-text-secondary)' }}>
            Store KPIs, Hermes’s recommendations, products, ads and SEO in one place.
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
            Refresh
          </span>
          {REFRESH_BUTTONS.map((b) => (
            <SmallButton
              key={b.target}
              onClick={() => onRefresh(b.target)}
              disabled={refreshStatus[b.target] === 'queued'}
              title={b.title}
            >
              <RefreshCw size={11} className={refreshStatus[b.target] === 'queued' ? 'animate-spin' : ''} />
              {b.label}
            </SmallButton>
          ))}
        </div>
      </div>

      {stores.length > 0 && (
        <Segmented
          ariaLabel="Store"
          value={selected}
          onChange={onSelect}
          options={[
            { value: ALL_STORES, label: 'All stores' },
            ...stores.map((s) => ({ value: s.slug, label: s.display_name })),
          ]}
        />
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {FEED_LABELS.map(({ feed, label, staleAfter }) => {
          const data = feeds[feed].data;
          return data ? (
            <FeedFreshness
              key={feed}
              label={label}
              ageSeconds={data.age_seconds}
              stale={data.stale}
              staleAfterSeconds={staleAfter}
            />
          ) : null;
        })}
      </div>

      {notes.length > 0 && (
        <div className="flex flex-wrap gap-x-4 text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
          {notes.map((b) => (
            <span key={b.target}>
              {b.label} refresh: {REFRESH_NOTES[refreshStatus[b.target] as Exclude<RefreshStatus, 'idle'>]}
            </span>
          ))}
        </div>
      )}
    </header>
  );
}
