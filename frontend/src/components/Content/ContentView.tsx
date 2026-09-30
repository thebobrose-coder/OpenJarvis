import { firstBlock } from '../../lib/voice-api';
import { X } from 'lucide-react';
import type { ApprovalEdits, PromptAction } from '../../lib/content-api';
import { applyDecisions, type ContentFeedStates, type PendingDecision } from '../../hooks/useContentData';
import { ContentHeader } from './ContentHeader';
import { ALL_PROPERTIES, matchesProperty } from './format';
import { HealthStrip } from './HealthStrip';
import { PerformancePanel } from './PerformancePanel';
import { ProposalsQueue, type QueueTab } from './ProposalsQueue';
import { SeedbankStrip } from './SeedbankStrip';
import { ThesisPrompts } from './ThesisPrompts';

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
}

/**
 * The Content page: the Foundry content loop per property. Header, health
 * alerts, the seedbank, the proposals queue (with thesis prompts beside it
 * when there are any) and performance. Generic by property. Pure:
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
  const alerts = (feeds.content_health.data?.alerts ?? []).filter((a) => !a.property || matchesProperty(selected, a.property));

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
        />
        <ThesisPrompts prompts={prompts} showProperty={showProperty} onMark={props.onPrompt} />
      </div>

      <div className="grid grid-cols-12 gap-4 mb-10">
        <PerformancePanel
          performance={feeds.content_performance.data}
          selectedProperty={selected}
          loading={feeds.content_performance.loading}
          error={feeds.content_performance.error}
        />
      </div>
    </div>
  );
}
