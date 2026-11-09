import { useState, type ReactNode } from 'react';
import { DollarSign, Headphones, ListTree, Plug, Server } from 'lucide-react';
import type { RunState } from '../../hooks/useStackHealth';
import type { Polled, VoiceState } from '../../hooks/useOpsData';
import type { SpendLedger } from '../../lib/commerce-api';
import type { StackHealth, StackLevel } from '../../lib/stack-api';
import type { EntityWatch } from '../../lib/sites-api';
import type { CachedConnector } from '../../lib/store';
import { CostComparison } from '../Dashboard/CostComparison';
import { DashboardPanel } from '../Dashboard/DashboardPanel';
import { EnergyDashboard } from '../Dashboard/EnergyDashboard';
import { FeedFreshnessLine, type FeedAge } from '../Dashboard/FeedFreshnessLine';
import { TraceDebugger } from '../Dashboard/TraceDebugger';
import { StackSections } from '../Sidebar/StackHealthDrawer';
import { Chip, Quiet, Segmented, Tile } from '../shared/ui';
import { EngineCostView, type CostSource } from './EngineCost';
import { SpendBurnView } from './SpendBurn';
import { StackBandView } from './StackBand';

type MachineTab = 'energy' | 'traces';

/** Worker, text to speech and speech to text, one tile each: up, or why not. */
export function VoiceTiles({ voice }: { voice: VoiceState | null }) {
  const tile = (label: string, ok: boolean | null | undefined, sub?: string | null) => (
    <Tile
      label={label}
      value={<span style={{ color: ok ? 'var(--color-success)' : ok === false ? 'var(--color-warning)' : 'var(--color-text-tertiary)' }}>{ok ? 'up' : ok === false ? 'down' : '—'}</span>}
      sub={sub ?? undefined}
    />
  );
  return (
    <div className="grid grid-cols-3 gap-2" data-voice-tiles>
      {tile('Voice worker', voice?.queue ? voice.queue.worker : null, voice?.queue?.voice_name ?? null)}
      {tile('Text to speech', voice?.tts ? voice.tts.available : null, voice?.tts?.backend ?? voice?.tts?.reason ?? null)}
      {tile('Speech to text', voice?.stt ? voice.stt.available : null, voice?.stt?.backend ?? voice?.stt?.reason ?? null)}
    </div>
  );
}

/**
 * Ops row 3, the machine (widescreen plan 5.3): the voice layer's state, then the
 * local-LLM energy telemetry, with the trace debugger behind a tab. The Energy body
 * polls every 5 s only while it is mounted, so only on this tab of this page.
 */
export function MachinePanel({ voice, initialTab = 'energy' }: { voice: VoiceState | null; initialTab?: MachineTab }) {
  const [tab, setTab] = useState<MachineTab>(initialTab);
  return (
    <DashboardPanel
      icon={Server}
      title="Machine"
      tag={tab === 'energy' ? 'live · 5 s' : 'last 50'}
      size="half"
      band="tall"
      headerExtra={
        <Segmented<MachineTab>
          ariaLabel="Machine view"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'energy', label: 'Energy' },
            { value: 'traces', label: 'Traces' },
          ]}
        />
      }
    >
      {tab === 'energy' ? (
        <div className="flex flex-col gap-3" data-machine-tab="energy">
          <VoiceTiles voice={voice} />
          <EnergyDashboard />
        </div>
      ) : (
        <div className="h-full" data-machine-tab="traces">
          <TraceDebugger />
        </div>
      )}
    </DashboardPanel>
  );
}

/** The Listen queue as counts: how much is waiting and in which voice. Playing stays on the Dashboard. */
export function ListenQueuePanel({ voice, loading, error }: { voice: VoiceState | null; loading?: boolean; error?: string | null }) {
  const q = voice?.queue;
  const items = q?.items ?? [];
  const by = (a: string) => items.filter((i) => i.audio === a).length;
  return (
    <DashboardPanel icon={Headphones} title="Listen queue" tag={q ? `${items.length} items` : undefined} size="trio" band="short" loading={loading && !voice} error={!voice ? error : null}>
      {!q ? (
        <Quiet>The voice queue is unavailable.</Quiet>
      ) : (
        <div className="flex flex-col gap-3" data-listen-queue>
          <div className="grid grid-cols-3 gap-2">
            <Tile label="Expressive" value={by('expressive')} />
            <Tile label="Fast lane" value={by('fast')} />
            <Tile label="Not rendered" value={by('missing')} />
          </div>
          <span className="flex flex-wrap items-center gap-1.5 text-ui-11-5">
            <Chip tone={q.worker ? 'success' : 'warning'}>{q.worker ? 'worker up' : 'worker down'}</Chip>
            {q.run_at && <span style={{ color: 'var(--color-text-tertiary)' }}>queue built {new Date(q.run_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}
          </span>
          <Quiet>Play the queue from the Dashboard’s Briefings panel.</Quiet>
        </div>
      )}
    </DashboardPanel>
  );
}

/** The connector dots that left the sidebar dock, with their names. */
export function ConnectorsPanel({ connectors, error }: { connectors: CachedConnector[] | null; error?: string | null }) {
  const up = (connectors ?? []).filter((c) => c.connected).length;
  return (
    <DashboardPanel icon={Plug} title="Connectors" tag={connectors ? `${up} of ${connectors.length} connected` : undefined} size="trio" band="short" error={!connectors ? error : null}>
      {!connectors ? (
        <Quiet>Reading the connectors…</Quiet>
      ) : connectors.length === 0 ? (
        <Quiet>No connectors set up.</Quiet>
      ) : (
        <ul className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-ui-12" data-connectors>
          {connectors.map((c) => (
            <li key={c.connector_id} className="flex items-center gap-2 min-w-0" data-connected={c.connected ? 'true' : 'false'}>
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: c.connected ? 'var(--color-success)' : 'var(--color-text-tertiary)' }} aria-hidden />
              <span className="truncate" style={{ color: 'var(--color-text)' }}>
                {c.display_name}
              </span>
              <span className="ml-auto text-ui-11 shrink-0" style={{ color: 'var(--color-text-tertiary)' }}>
                {c.connected ? 'connected' : 'not connected'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </DashboardPanel>
  );
}

export interface OpsViewProps {
  stack: {
    health: StackHealth | null;
    level: StackLevel;
    age: number | null;
    now: number;
    missing: boolean;
    error: string | null;
    run: { state: RunState; detail: string | null };
    onRun: () => void;
    onAskDesk?: () => void;
  };
  sites?: { sites: EntityWatch | null; error: string | null };
  spend: Polled<SpendLedger>;
  costs: { sources: CostSource[]; loading: boolean; error: string | null };
  voice: Polled<VoiceState>;
  connectors: { connectors: CachedConnector[] | null; error: string | null };
  freshness: FeedAge[];
  now: number;
  /** Slots for tests: the Machine panel self-fetches, so a test may pass a stand-in. */
  machine?: ReactNode;
}

/**
 * The Ops page (widescreen plan 5.3): operator-wide cost and machine state.
 * Row 1, the stack-health band. Row 2, tall: spend burn (wide) and cost by engine
 * (third). Row 3, tall: the stack detail and the machine (halves). Row 4, short:
 * cost comparison (dim), the Listen queue and the connectors. Pure but for the
 * telemetry bodies, which fetch while mounted.
 */
export function OpsView(props: OpsViewProps) {
  const { stack } = props;
  return (
    <div>
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-ui-20 font-semibold" style={{ color: 'var(--color-text)' }}>
            Ops
          </h1>
          <p className="text-ui-12-5 mt-1" style={{ color: 'var(--color-text-secondary)' }}>
            What the stack costs and how the machine is doing. Read only, but for Run now.
          </p>
        </div>
        <FeedFreshnessLine feeds={props.freshness} />
      </header>

      <div className="grid grid-cols-12 gap-4 mb-4">
        <StackBandView {...stack} />
      </div>

      <div className="grid grid-cols-12 gap-4 mb-4">
        <SpendBurnView ledger={props.spend.data} loading={props.spend.loading} error={props.spend.error} now={props.now} />
        <EngineCostView sources={props.costs.sources} loading={props.costs.loading} error={props.costs.error} />
      </div>

      <div className="grid grid-cols-12 gap-4 mb-4">
        <DashboardPanel icon={ListTree} title="Stack detail" tag={stack.health ? `${stack.health.failing.length + stack.health.warning.length} to read` : undefined} size="half" band="tall">
          <div className="flex flex-col gap-4" data-stack-detail>
            <StackSections health={stack.health} now={stack.now} sites={props.sites} />
          </div>
        </DashboardPanel>
        {props.machine ?? <MachinePanel voice={props.voice.data} />}
      </div>

      <div className="grid grid-cols-12 gap-4 mb-10">
        <DashboardPanel icon={DollarSign} title="Cost comparison" tag="local vs cloud" size="trio" band="short" dim>
          <CostComparison />
        </DashboardPanel>
        <ListenQueuePanel voice={props.voice.data} loading={props.voice.loading} error={props.voice.error} />
        <ConnectorsPanel connectors={props.connectors.connectors} error={props.connectors.error} />
      </div>
    </div>
  );
}
