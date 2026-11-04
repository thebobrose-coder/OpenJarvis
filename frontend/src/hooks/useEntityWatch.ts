import { useEffect, useState } from 'react';
import { fetchEntityWatch, type EntityWatch } from '../lib/sites-api';

/** The Company sites feed, read each time the drawer opens; keeps the last
 * good copy. Hermes publishes it once a day, so there is no poll. */
export function useEntityWatch(open: boolean) {
  const [sites, setSites] = useState<EntityWatch | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    fetchEntityWatch().then(
      (w) => {
        if (!live) return;
        setSites(w);
        setError(null);
      },
      (e) => live && setError(e instanceof Error ? e.message : 'Company sites unavailable'),
    );
    return () => {
      live = false;
    };
  }, [open]);
  return { sites, error };
}
