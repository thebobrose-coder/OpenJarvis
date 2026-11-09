import { useEffect, useMemo } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { PageFrame } from '../components/shared/PageFrame';
import { OpsView } from '../components/Ops/OpsView';
import type { CostSource } from '../components/Ops/EngineCost';
import { stackContext } from '../components/Sidebar/StackHealthDock';
import { useEntityWatch } from '../hooks/useEntityWatch';
import { useOpsData } from '../hooks/useOpsData';
import { useStackHealth } from '../hooks/useStackHealth';
import { useAppStore } from '../lib/store';
import { scrollToWhenReady } from '../lib/waiting-api';

/**
 * /ops (widescreen plan 5.3): the stack-health run, spend, model cost, the machine
 * and the voice layer on one page. The hooks live here; OpsView is pure. Reads only,
 * but for the stack's Run now (the same button the drawer has).
 */
export function OpsPage() {
  const s = useStackHealth();
  const sites = useEntityWatch(true);
  const ops = useOpsData();
  const openDeskThread = useAppStore((st) => st.openDeskThread);
  const navigate = useNavigate();

  // ?focus=spend-<line> from "Waiting on you": scroll to that gauge.
  const location = useLocation();
  const [params] = useSearchParams();
  const focus = params.get('focus');
  useEffect(() => (focus ? scrollToWhenReady([focus]) : undefined), [focus, location.key]);

  const sources: CostSource[] = useMemo(() => {
    const out: CostSource[] = [];
    const c = ops.proposals.data?.cost;
    if (c) out.push({ label: 'Content', cost: c });
    for (const l of ops.bdStats.data?.lines ?? []) if (l.cost) out.push({ label: `BizDev · ${l.line}`, cost: l.cost });
    return out;
  }, [ops.proposals.data, ops.bdStats.data]);

  const freshness = [
    ...(ops.spend.data ? [{ label: 'Spend ledger', ageSeconds: ops.spend.data.age_seconds, stale: ops.spend.data.stale, staleAfterSeconds: 26 * 3600 }] : []),
    ...(s.health ? [{ label: 'Stack health', ageSeconds: s.age, stale: s.health.stale, staleAfterSeconds: 7 * 3600 }] : []),
    ...(ops.proposals.data ? [{ label: 'Content cost', ageSeconds: ops.proposals.data.age_seconds, stale: ops.proposals.data.stale }] : []),
    ...(ops.bdStats.data ? [{ label: 'BizDev cost', ageSeconds: ops.bdStats.data.age_seconds, stale: ops.bdStats.data.stale }] : []),
  ];

  return (
    <PageFrame>
      <OpsView
        stack={{
          health: s.health,
          level: s.level,
          age: s.age,
          now: s.now,
          missing: s.missing,
          error: s.error,
          run: s.run,
          onRun: () => void s.runNow(),
          onAskDesk: s.health
            ? () => {
                openDeskThread('ops', stackContext(s.health!));
                navigate('/');
              }
            : undefined,
        }}
        sites={sites}
        spend={ops.spend}
        costs={{
          sources,
          loading: ops.proposals.loading || ops.bdStats.loading,
          error: ops.proposals.error ?? ops.bdStats.error,
        }}
        voice={ops.voice}
        connectors={ops.connectors}
        freshness={freshness}
        now={Date.now()}
      />
    </PageFrame>
  );
}
