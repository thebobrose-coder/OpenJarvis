import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { CommerceView } from '../components/Commerce/CommerceView';
import { ALL_STORES } from '../components/Commerce/format';
import { useCatalogFixes } from '../hooks/useCatalogFixes';
import { useCommerceData } from '../hooks/useCommerceData';
import type { ComplianceFinding, DailyStore, LedgerItem } from '../lib/commerce-api';
import { contextBlock, fetchPrecheckProperties, runPrecheck, type PrecheckResult } from '../lib/desks-api';
import { useAppStore } from '../lib/store';
import { useWaiting } from '../lib/WaitingContext';

const short = (s: string, n = 40) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** A recommendation as a Commerce desk thread's context: the card as shown. */
export function recContext(item: LedgerItem): { block: string; label: string } {
  const block = contextBlock({
    page: '/commerce',
    kind: 'recommendation',
    id: item.id,
    store: item.store,
    category: item.category,
    priority: item.priority,
    title: item.title,
    created_at: item.created_at,
    detail: item.detail,
  });
  return { block, label: `recommendation “${short(item.title)}”` };
}

/** The selected stores' KPIs as a Commerce desk thread's context. */
export function kpiContext(stores: DailyStore[]): { block: string; label: string } {
  const block = contextBlock({ page: '/commerce', kind: 'store_kpis', stores });
  const names = stores.map((s) => s.display_name || s.slug);
  return { block, label: stores.length === 1 ? `${names[0]} KPIs` : `KPIs for ${stores.length} stores` };
}

/** A compliance finding (or the pasted text and its hits) as a Compliance desk thread's context. */
export function findingContext(f: ComplianceFinding): { block: string; label: string } {
  const block = contextBlock({ page: '/commerce', kind: 'compliance_finding', ...f });
  return { block, label: `finding ${f.location ?? f.id.slice(0, 8)}` };
}

export function precheckContext(
  propertyId: string,
  text: string,
  result: PrecheckResult | null,
): { block: string; label: string } {
  const block = contextBlock({
    page: '/commerce',
    kind: 'precheck',
    propertyId,
    text,
    ...(result ? { result } : {}),
  });
  return { block, label: `pasted copy for ${propertyId}` };
}

/** Hermes's ecom-seo feeds and catalog fixes on one page: see components/Commerce. */
export function CommercePage() {
  const { feeds, pending, refreshStatus, refresh, decide, notice, clearNotice } = useCommerceData();
  const fixes = useCatalogFixes();
  // Fix it (0024 J1): the waiting feed says which recs the fixer can write.
  const { waiting } = useWaiting();
  const fixRecs = useMemo(
    () => new Set((waiting?.items ?? []).filter((i) => i.kind === 'rec' && i.fix === true).map((i) => String(i.id))),
    [waiting],
  );
  const [store, setStore] = useState(ALL_STORES);
  // ?focus=<id> from "Waiting on you": #fixes means a patch, else a rec.
  const location = useLocation();
  const [params] = useSearchParams();
  const target = params.get('focus');
  const onFixes = location.hash === '#fixes';
  const focus = target ? { fix: onFixes ? target : null, rec: onFixes ? null : target, key: location.key } : null;
  useEffect(() => {
    if (target) setStore(ALL_STORES);
  }, [target, location.key]);

  // Desks (hq 0020 P3): the entry points open a thread and go to Chat.
  const navigate = useNavigate();
  const openDeskThread = useAppStore((s) => s.openDeskThread);
  const ask = (desk: 'commerce' | 'compliance', context?: { block: string; label: string }) => {
    openDeskThread(desk, context);
    navigate('/');
  };
  const [properties, setProperties] = useState<string[]>([]);
  useEffect(() => {
    fetchPrecheckProperties().then(setProperties, () => setProperties([]));
  }, []);

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
        focus={focus}
        fixRecs={fixRecs}
        onAskDesk={{
          rec: (item) => ask('commerce', recContext(item)),
          kpis: (stores) => ask('commerce', kpiContext(stores)),
          finding: (f) => ask('compliance', f ? findingContext(f) : undefined),
        }}
        precheck={{
          properties,
          onCheck: runPrecheck,
          onAskDesk: (propertyId, text, result) => ask('compliance', precheckContext(propertyId, text, result)),
        }}
      />
    </div>
  );
}
