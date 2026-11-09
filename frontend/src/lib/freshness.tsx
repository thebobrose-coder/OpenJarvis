import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { FeedAge as FeedAgeEntry } from '../components/Dashboard/FeedFreshnessLine';

/**
 * A page's feed ages in one place (widescreen plan, Phase 1): each panel reports the
 * age of the copy it shows, the page header draws one freshness line from them. A
 * panel rendered without a provider (another page, a test) simply reports nowhere.
 */
type Registry = {
  feeds: Record<string, FeedAgeEntry>;
  report: (entry: FeedAgeEntry) => void;
  forget: (label: string) => void;
};

const FreshnessContext = createContext<Registry | null>(null);

export function FreshnessProvider({ children }: { children: ReactNode }) {
  const [feeds, setFeeds] = useState<Record<string, FeedAgeEntry>>({});
  const value = useMemo<Registry>(
    () => ({
      feeds,
      report: (entry) =>
        setFeeds((m) => {
          const prev = m[entry.label];
          if (
            prev &&
            prev.ageSeconds === entry.ageSeconds &&
            prev.stale === entry.stale &&
            prev.staleAfterSeconds === entry.staleAfterSeconds
          )
            return m;
          return { ...m, [entry.label]: entry };
        }),
      forget: (label) =>
        setFeeds((m) => {
          if (!(label in m)) return m;
          const next = { ...m };
          delete next[label];
          return next;
        }),
    }),
    [feeds],
  );
  return <FreshnessContext.Provider value={value}>{children}</FreshnessContext.Provider>;
}

/** Report one feed's age to the page; a no-op without a provider. */
export function useReportFreshness(entry: FeedAgeEntry): boolean {
  const ctx = useContext(FreshnessContext);
  const { label, ageSeconds, stale, staleAfterSeconds } = entry;
  useEffect(() => {
    if (!ctx || ageSeconds == null) return undefined;
    ctx.report({ label, ageSeconds, stale, staleAfterSeconds });
    return () => ctx.forget(label);
  }, [ctx, label, ageSeconds, stale, staleAfterSeconds]);
  return ctx != null;
}

/** The page's reported feeds, for the header line. */
export function useFreshnessFeeds(): FeedAgeEntry[] {
  const ctx = useContext(FreshnessContext);
  return useMemo(() => (ctx ? Object.values(ctx.feeds) : []), [ctx]);
}
