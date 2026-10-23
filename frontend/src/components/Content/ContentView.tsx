import { firstBlock } from '../../lib/voice-api';
import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { ApprovalEdits, PromptAction, SeedBody, VerifyResult } from '../../lib/content-api';
import { applyDecisions, type ContentFeedStates, type PendingDecision } from '../../hooks/useContentData';
import { ContentHeader } from './ContentHeader';
import { ALL_PROPERTIES, matchesProperty } from './format';
import { HealthStrip } from './HealthStrip';
import { PerformancePanel } from './PerformancePanel';
import { ProposalsQueue, type QueueTab } from './ProposalsQueue';
import { SeedbankStrip } from './SeedbankStrip';
import { SeedComposer, draftFromPrompt, emptyDraft, type SeedDraft } from './SeedComposer';
import { ThesisLane } from './ThesisLane';
import { ThesisPrompts } from './ThesisPrompts';
import { WinnersPanel } from './WinnersPanel';

export interface ContentViewProps {
  feeds: ContentFeedStates;
  pending: Record<string, PendingDecision>;
  selectedProperty: string;
  onSelectProperty: (id: string) => void;
  onApprove: (id: string, edits: ApprovalEdits) => void;
  onReject: (id: string, note: string) => void;
  onPrompt: (id: string, action: PromptAction) => void;
  onResearch: () => void;
  researchStatus: 'idle' | 'queued' | 'error';
  researchAvailableAt: number | null;
  now?: number;
  notice?: string | null;
  onClearNotice?: () => void;
  /** For tests: which proposals tab opens first. */
  initialTab?: QueueTab;
  // v1.16 operator seeds.
  /** Resolves to the proposal id Hermes minted. */
  onQueueSeed?: (body: SeedBody) => Promise<string>;
  onVerifyProduct?: (property: string, handle: string) => Promise<VerifyResult>;
  onRunIntake?: () => void;
  intakeStatus?: 'idle' | 'running' | 'started' | 'ran_recently' | 'error';
  intakeAvailableAt?: number | null;
  /** Thesis prompts with a seed sent this session. */
  seededPrompts?: string[];
  /** For tests: the composer open with this draft. */
  initialComposer?: SeedDraft | null;
}

/**
 * The Content page: the Foundry content loop per property. Header, health
 * alerts, the seedbank, the proposals queue (with thesis prompts beside it
 * when there are any), the thesis lane where a property has one,
 * performance, and the weekly winners. Generic by property. Pure:
 * everything comes in through props (see ContentPage).
 */
export function ContentView(props: ContentViewProps) {
  const { feeds, selectedProperty: selected } = props;
  const seedbank = feeds.content_seedbank.data;
  const proposals = feeds.content_proposals.data;

  const properties = [
    ...new Set([
      ...(seedbank?.properties ?? []).map((p) => p.id),
      ...(proposals?.pending ?? []).map((p) => p.property_id),
    ]),
  ];
  const showProperty = selected === ALL_PROPERTIES;

  const applied = applyDecisions(proposals, props.pending);
  const pending = applied.pending.filter((p) => matchesProperty(selected, p.property_id));
  const recent = applied.recent.filter((p) => matchesProperty(selected, p.property_id));
  const prompts = applied.prompts.filter((t) => matchesProperty(selected, t.property_id));
  const thesisLanes = (seedbank?.properties ?? []).filter((p) => p.thesis_lane != null && matchesProperty(selected, p.id));
  const alerts = (feeds.content_health.data?.alerts ?? []).filter((a) => !a.property || matchesProperty(selected, a.property));

  // The composer is open with a draft ("New seed" or a prompt's "Seed this");
  // a new key remounts it, so a new draft starts clean.
  const [composer, setComposer] = useState<{ draft: SeedDraft; key: number } | null>(
    props.initialComposer ? { draft: props.initialComposer, key: 0 } : null,
  );
  const composerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (composer) composerRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [composer]);
  const seeds = props.onQueueSeed && props.onVerifyProduct ? { queue: props.onQueueSeed, verify: props.onVerifyProduct } : null;
  const openComposer = (draft: SeedDraft) => setComposer((c) => ({ draft, key: (c?.key ?? 0) + 1 }));

  // Queued theses' places in their lane, by Foundry signal id.
  const lanePositions: Record<string, number> = {};
  for (const p of seedbank?.properties ?? []) {
    for (const q of p.thesis_lane?.queue ?? []) {
      if (q.signal_id && q.lane_position != null) lanePositions[q.signal_id] = q.lane_position;
    }
  }

  const pillarsByProperty: Record<string, string[]> = {};
  for (const p of [...applied.pending, ...applied.recent]) {
    if (!p.pillar_hint) continue;
    const list = (pillarsByProperty[p.property_id] ??= []);
    if (!list.includes(p.pillar_hint)) list.push(p.pillar_hint);
  }

  return (
    <div className="max-w-6xl mx-auto">
      <ContentHeader
        properties={properties}
        selectedProperty={selected}
        onSelectProperty={props.onSelectProperty}
        seedbank={seedbank}
        proposals={proposals}
        researchStatus={props.researchStatus}
        researchAvailableAt={props.researchAvailableAt}
        now={props.now ?? Date.now()}
        onResearch={props.onResearch}
        onNewSeed={seeds ? () => openComposer(emptyDraft(seedbank, showProperty ? undefined : selected)) : undefined}
        onRunIntake={props.onRunIntake}
        intakeStatus={props.intakeStatus}
        intakeAvailableAt={props.intakeAvailableAt}
      />

      {props.notice && (
        <div
          className="flex items-center justify-between gap-2 rounded-lg px-3 py-2 mb-4 text-[12px]"
          style={{ border: '1px solid var(--color-warning)', color: 'var(--color-text-secondary)' }}
          role="status"
        >
          <span>{props.notice}</span>
          {props.onClearNotice && (
            <button onClick={props.onClearNotice} aria-label="Dismiss" className="cursor-pointer" style={{ background: 'transparent', border: 'none', color: 'inherit' }}>
              <X size={12} />
            </button>
          )}
        </div>
      )}

      {seeds && composer && (
        <div ref={composerRef} className="grid grid-cols-12 gap-4 mb-4 scroll-mt-4">
          <SeedComposer
            key={composer.key}
            seedbank={seedbank}
            draft={composer.draft}
            proposals={[...applied.pending, ...applied.recent]}
            lanePositions={lanePositions}
            onQueue={seeds.queue}
            onVerify={seeds.verify}
            onClose={() => setComposer(null)}
          />
        </div>
      )}

      <HealthStrip alerts={alerts} showProperty={showProperty} />

      <div className="grid grid-cols-12 gap-4 mb-4">
        <SeedbankStrip
          seedbank={seedbank}
          selectedProperty={selected}
          loading={feeds.content_seedbank.loading}
          error={feeds.content_seedbank.error}
        />
      </div>

      <div className="grid grid-cols-12 gap-4 mb-4 items-start">
        <ProposalsQueue
          pending={pending}
          recent={recent}
          pillarsByProperty={pillarsByProperty}
          showProperty={showProperty}
          onApprove={props.onApprove}
          onReject={props.onReject}
          loading={feeds.content_proposals.loading}
          error={feeds.content_proposals.error}
          hasFeed={proposals != null}
          size={prompts.length ? 'wide' : 'full'}
          initialTab={props.initialTab}
          speech={firstBlock(proposals?.speech)}
          lanePositions={lanePositions}
        />
        <ThesisPrompts
          prompts={prompts}
          showProperty={showProperty}
          onMark={props.onPrompt}
          onSeed={seeds ? (t) => openComposer(draftFromPrompt(t, seedbank)) : undefined}
          seeded={props.seededPrompts}
        />
      </div>

      {thesisLanes.length > 0 && (
        <div className="grid grid-cols-12 gap-4 mb-4">
          <ThesisLane properties={thesisLanes} showProperty={showProperty} />
        </div>
      )}

      <div className="grid grid-cols-12 gap-4 mb-4">
        <PerformancePanel
          performance={feeds.content_performance.data}
          selectedProperty={selected}
          loading={feeds.content_performance.loading}
          error={feeds.content_performance.error}
        />
      </div>

      <div className="grid grid-cols-12 gap-4 mb-10">
        <WinnersPanel
          winners={feeds.content_winners.data}
          selectedProperty={selected}
          showProperty={showProperty}
          loading={feeds.content_winners.loading}
          error={feeds.content_winners.error}
        />
      </div>
    </div>
  );
}
