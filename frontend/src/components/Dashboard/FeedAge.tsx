import { useReportFreshness } from '../../lib/freshness';
import { FeedFreshness } from './FeedFreshness';

/**
 * A panel's feed age (widescreen plan, Phase 1). On a page with a freshness line in
 * its header, the panel reports the age there and shows only the amber line when the
 * copy is stale or late; elsewhere it is the full "Updated N ago" line as before.
 */
export function FeedAge({
  label,
  ageSeconds,
  stale,
  staleAfterSeconds,
  staleTitle,
  className,
}: {
  label: string;
  ageSeconds?: number | null;
  stale?: boolean;
  staleAfterSeconds?: number;
  staleTitle?: string;
  className?: string;
}) {
  const reported = useReportFreshness({ label, ageSeconds, stale, staleAfterSeconds });
  const late = staleAfterSeconds != null && ageSeconds != null && ageSeconds > staleAfterSeconds;
  if (reported && !stale && !late) return null;
  return <FeedFreshness ageSeconds={ageSeconds} stale={stale} staleAfterSeconds={staleAfterSeconds} staleTitle={staleTitle} className={className} />;
}
