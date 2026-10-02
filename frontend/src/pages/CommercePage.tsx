import { useState } from 'react';
import { CommerceView } from '../components/Commerce/CommerceView';
import { ALL_STORES } from '../components/Commerce/format';
import { useCatalogFixes } from '../hooks/useCatalogFixes';
import { useCommerceData } from '../hooks/useCommerceData';

/** Hermes's ecom-seo feeds and catalog fixes on one page: see components/Commerce. */
export function CommercePage() {
  const { feeds, pending, refreshStatus, refresh, decide, notice, clearNotice } = useCommerceData();
  const fixes = useCatalogFixes();
  const [store, setStore] = useState(ALL_STORES);

  return (
    <div className="flex-1 overflow-y-auto px-6 py-10">
      <CommerceView
        feeds={feeds}
        pending={pending}
        refreshStatus={refreshStatus}
        selectedStore={store}
        onSelectStore={setStore}
        onRefresh={(t) => void refresh(t)}
        onDecide={(id, d, note) => void decide(id, d, note)}
        notice={notice}
        onClearNotice={clearNotice}
        fixes={fixes}
      />
    </div>
  );
}
