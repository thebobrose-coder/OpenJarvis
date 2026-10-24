import { SpeakButton } from '../shared/SpeakButton';
import type { SpeechBlock } from '../../lib/voice-api';
import { useState } from 'react';
import { Check, ClipboardList, MessagesSquare, Pencil, Plus, X } from 'lucide-react';
import type { ProposalFields } from '../../lib/desk-cards';
import { LIMITS, type ApprovalEdits, type Proposal, type PropertyMotion } from '../../lib/content-api';
import { DashboardPanel } from '../Dashboard/DashboardPanel';
import { shortDateTime } from '../shared/format';
import { Chip, ExtIcon, ExtLink, Quiet, Segmented, SmallButton } from '../shared/ui';
import { PROPOSAL_STATUS, humanize, isRefusal, isSeedRefusal, laneLabel } from './format';
import { VideoChip, VideoFields, assetKeyProblem, beatEnabled, choiceOf, motionOf, videoAllowed, type MotionChoice } from './Video';

const OTHER = '__other__';
/** A proposal without a priority gets the default (v1.10). */
const DEFAULT_PRIORITY = 2;
const PRIORITIES = ['1', '2', '3'] as const;

const field = {
  background: 'var(--color-surface)',
  color: 'var(--color-text)',
  border: '1px solid var(--color-border)',
} as const;

/** Trimmed, lowercased (as Hermes stores them), de-duplicated, at most 3. */
export function cleanQueries(queries: string[]): string[] {
  const out: string[] = [];
  for (const q of queries) {
    const v = q.trim().toLowerCase().slice(0, LIMITS.target_query);
    if (v && !out.includes(v)) out.push(v);
  }
  return out.slice(0, LIMITS.target_queries);
}

/** Does the feed carry the v1.10 targeting keys for this proposal? */
export const hasTargeting = (p: Proposal) => 'target_queries' in p || 'priority' in p;

/** Target queries are long-form only (Hermes refuses them elsewhere). */
export const queriesEditable = (p: Proposal) => 'target_queries' in p && (p.lane === 'long' || !!p.target_queries?.length);

/** What the operator changed, as the approve body: unchanged fields are left
 * out so an untouched approval isn't recorded as an edit. */
export function approvalEdits(
  proposal: Pick<Proposal, 'topic' | 'pillar_hint' | 'product_handle' | 'target_queries' | 'priority' | 'motion' | 'motion_brief'>,
  form: {
    topic: string;
    pillar: string;
    product: string;
    note: string;
    queries?: string[];
    priority?: number;
    /** v1.14, only where the Video control shows. */
    video?: { choice: MotionChoice; beat: string; assetKey: string; removeKey?: boolean };
  },
): ApprovalEdits {
  const edits: ApprovalEdits = {};
  const topic = form.topic.trim();
  const pillar = form.pillar.trim();
  const product = form.product.trim();
  const note = form.note.trim();
  if (topic && topic !== proposal.topic.trim()) edits.topic = topic.slice(0, LIMITS.topic);
  if (pillar && pillar !== (proposal.pillar_hint ?? '').trim()) edits.pillar_hint = pillar.slice(0, LIMITS.pillar_hint);
  if (product && product !== (proposal.product_handle ?? '').trim()) edits.product_handle = product.slice(0, LIMITS.product_handle);
  if (note) edits.note = note.slice(0, LIMITS.note);
  if (form.queries) {
    const was = cleanQueries(proposal.target_queries ?? []);
    const now = cleanQueries(form.queries);
    if (now.join('\n') !== was.join('\n')) edits.target_queries = now;
  }
  if (form.priority != null && form.priority !== (proposal.priority ?? DEFAULT_PRIORITY)) edits.priority = form.priority;
  if (form.video) {
    const motion = motionOf(form.video.choice);
    if (motion !== (proposal.motion ?? null)) edits.motion = motion;
    // The beat is only sent while a clip can render; "" removes it.
    const beat = form.video.beat.trim().slice(0, LIMITS.motion_brief);
    if (beatEnabled(form.video.choice) && beat !== (proposal.motion_brief ?? '').trim()) edits.motion_brief = beat;
    // The key is never prefilled: a typed one is sent, "" only to remove the current one.
    const key = form.video.assetKey.trim();
    if (key) edits.video_asset_key = key.slice(0, LIMITS.video_asset_key);
    else if (form.video.removeKey) edits.video_asset_key = '';
  }
  return edits;
}

function Label({ children }: { children: string }) {
  return (
    <span className="text-[10.5px] uppercase tracking-wide" style={{ color: 'var(--color-text-tertiary)' }}>
      {children}
    </span>
  );
}

/** Target queries as chips: remove one, or type one and add it (at most 3). */
export function QueryChips({ queries, onChange }: { queries: string[]; onChange: (q: string[]) => void }) {
  const [draft, setDraft] = useState('');
  const full = queries.length >= LIMITS.target_queries;
  const add = () => {
    const next = cleanQueries([...queries, draft]);
    if (next.length > queries.length) onChange(next);
    setDraft('');
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {queries.map((q) => (
        <span
          key={q}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11.5px]"
          style={{ border: '1px solid var(--color-border)', background: 'var(--color-surface)', color: 'var(--color-text)' }}
        >
          {q}
          <button
            type="button"
            aria-label={`Remove ${q}`}
            onClick={() => onChange(queries.filter((x) => x !== q))}
            className="cursor-pointer"
            style={{ background: 'transparent', border: 'none', color: 'var(--color-text-tertiary)', padding: 0 }}
          >
            <X size={10} />
          </button>
        </span>
      ))}
      {full ? (
        <span className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
          3 at most
        </span>
      ) : (
        <span className="inline-flex items-center gap-1">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value.slice(0, LIMITS.target_query))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
            placeholder={queries.length ? 'Add a query' : 'Search query (optional)'}
            aria-label="Add a target query"
            className="rounded-md px-2 py-0.5 text-[12px] w-44"
            style={field}
          />
          <SmallButton onClick={add} disabled={draft.trim().length < 2} title="Add this query">
            <Plus size={11} />
          </SmallButton>
        </span>
      )}
    </div>
  );
}

/** Inline edit before approving: topic, pillar, product, target queries,
 * priority, video (v1.14, where the property's lane allows a clip) and a note. */
/** A desk's proposal_decision card, opened here filled in (hq 0020 P2). The
 * operator's own submit still sends it. */
export interface DeskDecision {
  id: string;
  decision: 'approve' | 'reject';
  fields: ProposalFields;
  /** Changes per click, so a second card on the same proposal refills it. */
  nonce: number;
}

export function ApproveEditor({
  proposal,
  pillars,
  motion = null,
  initial,
  onApprove,
  onCancel,
}: {
  proposal: Proposal;
  /** This property's pillars, from the proposals already present. */
  pillars: string[];
  /** The property's seedbank `motion`; null shows no Video control. */
  motion?: PropertyMotion | null;
  /** A desk card's suggested values, shown for the operator to check. */
  initial?: ProposalFields;
  onApprove: (edits: ApprovalEdits) => void;
  onCancel: () => void;
}) {
  const current = proposal.pillar_hint ?? '';
  const options = [...new Set([current, ...pillars].filter(Boolean))];
  const startPillar = initial?.pillar_hint ?? current;
  const [topic, setTopic] = useState(initial?.topic ?? proposal.topic);
  const [pillarChoice, setPillarChoice] = useState(options.includes(startPillar) ? startPillar : OTHER);
  const [pillarText, setPillarText] = useState(options.includes(startPillar) ? '' : startPillar);
  const [product, setProduct] = useState(initial?.product_handle ?? proposal.product_handle ?? '');
  const [note, setNote] = useState(initial?.note ?? '');
  const [queries, setQueries] = useState(() => cleanQueries(initial?.target_queries ?? proposal.target_queries ?? []));
  const [priority, setPriority] = useState(initial?.priority ?? proposal.priority ?? DEFAULT_PRIORITY);
  const pillar = pillarChoice === OTHER ? pillarText : pillarChoice;
  const editQueries = queriesEditable(proposal);
  const editPriority = 'priority' in proposal;
  const editVideo = videoAllowed(motion, proposal.lane, proposal.content_type);
  const [choice, setChoice] = useState<MotionChoice>(choiceOf(proposal.motion));
  const [beat, setBeat] = useState(proposal.motion_brief ?? '');
  const [assetKey, setAssetKey] = useState('');
  const [removeKey, setRemoveKey] = useState(false);
  const keyBad = editVideo && assetKeyProblem(assetKey, proposal.property_id) != null;

  return (
    <div
      role="group"
      aria-label="Edit before approving"
      className="flex flex-col gap-2 rounded-lg p-3"
      style={{ border: '1px solid var(--color-accent-subtle)', background: 'var(--color-bg)' }}
    >
      <label className="flex flex-col gap-1">
        <Label>Topic</Label>
        <textarea
          value={topic}
          onChange={(e) => setTopic(e.target.value.slice(0, LIMITS.topic))}
          rows={3}
          className="w-full rounded-md px-2 py-1.5 text-[12.5px] resize-y"
          style={field}
        />
      </label>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <label className="flex flex-col gap-1">
          <Label>Pillar</Label>
          <select
            value={pillarChoice}
            onChange={(e) => setPillarChoice(e.target.value)}
            className="rounded-md px-1.5 py-1 text-[12px] cursor-pointer"
            style={field}
          >
            {options.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
            <option value={OTHER}>Other…</option>
          </select>
          {pillarChoice === OTHER && (
            <input
              value={pillarText}
              onChange={(e) => setPillarText(e.target.value.slice(0, LIMITS.pillar_hint))}
              placeholder="Pillar"
              className="rounded-md px-2 py-1 text-[12px]"
              style={field}
            />
          )}
        </label>
        <label className="flex flex-col gap-1">
          <Label>Product</Label>
          <input
            value={product}
            onChange={(e) => setProduct(e.target.value.slice(0, LIMITS.product_handle))}
            placeholder="Product handle (optional)"
            className="rounded-md px-2 py-1 text-[12px]"
            style={field}
          />
        </label>
      </div>
      {(editQueries || editPriority) && (
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2">
          {editQueries ? (
            <div className="flex flex-col gap-1">
              <Label>Target queries</Label>
              <QueryChips queries={queries} onChange={setQueries} />
            </div>
          ) : (
            <span />
          )}
          {editPriority && (
            <div className="flex flex-col gap-1">
              <Label>Priority</Label>
              <Segmented
                ariaLabel="Priority"
                value={String(priority) as (typeof PRIORITIES)[number]}
                onChange={(v) => setPriority(Number(v))}
                options={PRIORITIES.map((v) => ({ value: v, label: v === '1' ? '1 low' : v === '3' ? '3 high' : v }))}
              />
            </div>
          )}
        </div>
      )}
      {editVideo && (
        <VideoFields
          propertyId={proposal.property_id}
          release={motion?.release}
          choice={choice}
          onChoice={setChoice}
          beat={beat}
          onBeat={setBeat}
          assetKey={assetKey}
          onAssetKey={setAssetKey}
          currentKey={proposal.video_key}
          removeKey={removeKey}
          onRemoveKey={setRemoveKey}
        />
      )}
      <label className="flex flex-col gap-1">
        <Label>Note</Label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value.slice(0, LIMITS.note))}
          rows={2}
          placeholder="Optional note (kept with the decision)"
          className="w-full rounded-md px-2 py-1.5 text-[12px] resize-y"
          style={field}
        />
      </label>
      {initial && (
        <p role="note" className="text-[11px]" style={{ color: 'var(--color-accent)' }}>
          Filled in from the Content desk’s card. Check it, then approve or cancel.
        </p>
      )}
      <p className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
        Your edits are yours, not Hermes copy. Hermes checks edited queries with Foundry’s intake rules; Foundry’s
        compliance scan and G1 approval still apply.
      </p>
      <div className="flex gap-1.5">
        <SmallButton
          tone="accent"
          disabled={!topic.trim() || keyBad}
          onClick={() =>
            onApprove(
              approvalEdits(proposal, {
                topic,
                pillar,
                product,
                note,
                queries: editQueries ? queries : undefined,
                priority: editPriority ? priority : undefined,
                video: editVideo ? { choice, beat, assetKey, removeKey } : undefined,
              }),
            )
          }
        >
          <Check size={11} /> Approve
        </SmallButton>
        <SmallButton onClick={onCancel}>Cancel</SmallButton>
      </div>
    </div>
  );
}

/** Reject is final: ask for an optional note and say so. */
export function RejectConfirm({
  onReject,
  onCancel,
  initialNote = '',
}: {
  onReject: (note: string) => void;
  onCancel: () => void;
  initialNote?: string;
}) {
  const [note, setNote] = useState(initialNote);
  return (
    <div
      role="alertdialog"
      aria-label="Confirm reject"
      className="flex flex-col gap-2 rounded-lg p-3"
      style={{ border: '1px solid var(--color-warning)', background: 'var(--color-bg)' }}
    >
      <p style={{ color: 'var(--color-text)' }}>
        <strong>Final:</strong> Hermes won’t propose this again.
      </p>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value.slice(0, LIMITS.note))}
        rows={2}
        placeholder="Optional note: why not? (helps the next round)"
        className="w-full rounded-md px-2 py-1.5 text-[12px] resize-y"
        style={field}
      />
      <div className="flex gap-1.5">
        <SmallButton tone="warning" onClick={() => onReject(note)}>
          Reject permanently
        </SmallButton>
        <SmallButton onClick={onCancel}>Cancel</SmallButton>
      </div>
    </div>
  );
}

function Evidence({ proposal }: { proposal: Proposal }) {
  const candidates = proposal.evidence?.candidates ?? [];
  if (!candidates.length) return null;
  return (
    <details>
      <summary className="cursor-pointer text-[11.5px]" style={{ color: 'var(--color-text-tertiary)' }}>
        Evidence ({candidates.length})
      </summary>
      <ul className="mt-1.5 flex flex-col gap-1.5 pl-3">
        {candidates.map((c, i) => (
          <li key={i} className="flex items-start gap-1.5">
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="flex flex-wrap items-center gap-1.5">
                {c.kind && <Chip tone="muted">{humanize(c.kind)}</Chip>}
                {c.fit != null && <Chip tone={c.fit >= 4 ? 'success' : 'neutral'}>fit {c.fit}</Chip>}
              </span>
              {c.text && <span style={{ color: 'var(--color-text)' }}>{c.text}</span>}
            </div>
            <ExtIcon url={c.link} title="Open source" />
          </li>
        ))}
      </ul>
    </details>
  );
}

function PriorityChip({ priority }: { priority?: number | null }) {
  const p = priority ?? DEFAULT_PRIORITY;
  return (
    <Chip tone={p >= 3 ? 'accent' : 'muted'} title={priority == null ? 'Priority (default)' : 'Priority'}>
      priority {p}
    </Chip>
  );
}

/** The proposal's target queries, read-only. */
export function TargetQueries({ queries }: { queries?: string[] | null }) {
  if (!queries?.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
      <span style={{ color: 'var(--color-text-tertiary)' }}>Target queries</span>
      {queries.map((q) => (
        <Chip key={q}>{q}</Chip>
      ))}
    </div>
  );
}

/** v1.16: the operator's own seeds carry `proposed_by: "operator"`. */
export function OriginChip({ proposal }: { proposal: Proposal }) {
  if (proposal.proposed_by !== 'operator') return null;
  return (
    <Chip tone="accent" title={proposal.source_prompt_id ? 'Your seed, from a thesis prompt' : 'Your seed'}>
      operator
    </Chip>
  );
}

function ProposalMeta({ proposal, showProperty }: { proposal: Proposal; showProperty: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {showProperty && <Chip tone="accent">{proposal.property_id}</Chip>}
      <OriginChip proposal={proposal} />
      <Chip>{laneLabel(proposal.lane)}</Chip>
      {proposal.signal_type && <Chip tone="muted">{humanize(proposal.signal_type)}</Chip>}
      {proposal.pillar_hint && <Chip title="Pillar">{proposal.pillar_hint}</Chip>}
      {proposal.product_handle && (
        <Chip tone="muted" title="Product">
          {proposal.product_handle}
        </Chip>
      )}
      {'priority' in proposal && <PriorityChip priority={proposal.priority} />}
      <VideoChip motion={proposal.motion} brief={proposal.motion_brief} />
      <span className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
        {shortDateTime(proposal.created_at)}
      </span>
    </div>
  );
}

export function ProposalCard({
  proposal,
  pillars,
  motion = null,
  showProperty,
  onApprove,
  onReject,
  initialMode,
  onAskDesk,
  deskDecision,
}: {
  proposal: Proposal;
  pillars: string[];
  /** The property's seedbank `motion` (v1.14). */
  motion?: PropertyMotion | null;
  showProperty: boolean;
  onApprove: (edits: ApprovalEdits) => void;
  onReject: (note: string) => void;
  initialMode?: 'idle' | 'edit' | 'reject';
  /** "Ask the desk": open a Content desk thread with this proposal as context. */
  onAskDesk?: () => void;
  /** A desk card for this proposal: opens its editor filled in. */
  deskDecision?: DeskDecision | null;
}) {
  const [mode, setMode] = useState(
    initialMode ?? (deskDecision ? (deskDecision.decision === 'approve' ? 'edit' : 'reject') : 'idle'),
  );
  const links = proposal.source_links ?? [];

  return (
    <article
      id={`proposal-${proposal.id}`}
      className="flex flex-col gap-2 rounded-lg p-3"
      style={{ background: 'var(--color-bg-secondary)', border: '1px solid var(--color-border-subtle, var(--color-border))' }}
    >
      <ProposalMeta proposal={proposal} showProperty={showProperty} />
      <h3 className="text-[13.5px] font-semibold leading-snug" style={{ color: 'var(--color-text)' }}>
        {proposal.topic}
      </h3>
      {proposal.rationale && <p>{proposal.rationale}</p>}
      <TargetQueries queries={proposal.target_queries} />
      {isRefusal(proposal.note) && (
        <p role="note" className="text-[11.5px]" style={{ color: 'var(--color-error)' }}>
          {proposal.note}
        </p>
      )}
      {links.length > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]" style={{ color: 'var(--color-accent)' }}>
          {links.map((url, i) => (
            <ExtLink key={i} url={url}>
              Source {links.length > 1 ? i + 1 : ''}
            </ExtLink>
          ))}
        </div>
      )}
      <Evidence proposal={proposal} />

      {mode === 'edit' ? (
        <ApproveEditor
          proposal={proposal}
          pillars={pillars}
          motion={motion}
          initial={deskDecision?.decision === 'approve' ? deskDecision.fields : undefined}
          onApprove={onApprove}
          onCancel={() => setMode('idle')}
        />
      ) : mode === 'reject' ? (
        <RejectConfirm
          onReject={onReject}
          onCancel={() => setMode('idle')}
          initialNote={deskDecision?.decision === 'reject' ? deskDecision.fields.note : undefined}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          <SmallButton tone="accent" onClick={() => onApprove({})} title="Approve as proposed: Foundry's intake queues it">
            <Check size={11} /> Approve
          </SmallButton>
          <SmallButton
            onClick={() => setMode('edit')}
            title={
              hasTargeting(proposal)
                ? 'Edit the topic, pillar, product, target queries or priority, then approve'
                : 'Edit the topic, pillar or product, then approve'
            }
          >
            <Pencil size={11} /> Edit & approve
          </SmallButton>
          <SmallButton onClick={() => setMode('reject')} title="Reject (final)">
            <X size={11} /> Reject
          </SmallButton>
          {onAskDesk && (
            <SmallButton onClick={onAskDesk} title="Open a Content desk thread with this proposal as context">
              <MessagesSquare size={11} /> Ask the desk
            </SmallButton>
          )}
        </div>
      )}
    </article>
  );
}

/** A queued item's place in its lane, from the thesis lane's queue (v1.16). */
export function lanePositionOf(proposal: Proposal, positions?: Record<string, number>): number | null {
  if (proposal.status !== 'queued' || !positions) return null;
  const signalId = proposal.result?.signalId;
  return typeof signalId === 'string' ? positions[signalId] ?? null : null;
}

export function DecidedItem({
  proposal,
  showProperty,
  lanePositions,
}: {
  proposal: Proposal;
  showProperty: boolean;
  lanePositions?: Record<string, number>;
}) {
  const status = PROPOSAL_STATUS[proposal.status] ?? { label: proposal.status, tone: 'neutral' as const };
  const reasons = proposal.status === 'intake_rejected' ? proposal.result?.reasons ?? [] : [];
  const position = lanePositionOf(proposal, lanePositions);
  const refused = proposal.status === 'rejected' && isSeedRefusal(proposal.note);
  return (
    <li className="flex flex-col gap-1 rounded-md p-2" style={{ background: 'var(--color-bg-secondary)' }}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip tone={status.tone}>{refused ? 'seed refused' : status.label}</Chip>
        {position != null && <Chip tone="accent">lane position {position}</Chip>}
        {showProperty && <Chip tone="accent">{proposal.property_id}</Chip>}
        <OriginChip proposal={proposal} />
        <Chip>{laneLabel(proposal.lane)}</Chip>
        {proposal.approval?.edited && <Chip tone="muted">edited</Chip>}
        <VideoChip motion={proposal.motion} brief={proposal.motion_brief} />
        <span className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
          {shortDateTime(proposal.decided_at ?? proposal.created_at)}
        </span>
      </div>
      <span style={{ color: 'var(--color-text)' }}>{proposal.topic}</span>
      <TargetQueries queries={proposal.target_queries} />
      {reasons.length > 0 && (
        <span className="text-[11.5px]" style={{ color: 'var(--color-error)' }}>
          Intake reasons: {reasons.map(humanize).join(', ')}
        </span>
      )}
      {refused ? (
        <span role="note" className="text-[11.5px]" style={{ color: 'var(--color-error)' }}>
          {proposal.note}
        </span>
      ) : (
        proposal.note && <span className="italic">“{proposal.note}”</span>
      )}
    </li>
  );
}

export type QueueTab = 'pending' | 'decided';

export function ProposalsQueue({
  pending,
  recent,
  pillarsByProperty,
  motionByProperty = {},
  showProperty,
  onApprove,
  onReject,
  loading,
  error,
  hasFeed,
  size = 'wide',
  initialTab = 'pending',
  speech = null,
  lanePositions,
  onAskDesk,
  deskDecision = null,
}: {
  pending: Proposal[];
  recent: Proposal[];
  pillarsByProperty: Record<string, string[]>;
  /** v1.14: each property's seedbank `motion`, for the Video control. */
  motionByProperty?: Record<string, PropertyMotion | null>;
  showProperty: boolean;
  onApprove: (id: string, edits: ApprovalEdits) => void;
  onReject: (id: string, note: string) => void;
  loading?: boolean;
  error?: string | null;
  hasFeed: boolean;
  size?: 'wide' | 'full';
  initialTab?: QueueTab;
  /** The content_proposals feed's spoken summary, if any. */
  speech?: SpeechBlock | null;
  /** Thesis-lane positions by Foundry signal id, for queued items. */
  lanePositions?: Record<string, number>;
  onAskDesk?: (proposal: Proposal) => void;
  deskDecision?: DeskDecision | null;
}) {
  const [tab, setTab] = useState<QueueTab>(initialTab);
  const newest = [...pending].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));

  return (
    <DashboardPanel
      icon={ClipboardList}
      title="Proposals"
      tag={hasFeed ? `${pending.length} pending` : undefined}
      size={size}
      priority
      loading={loading}
      error={error}
      actions={<SpeakButton feed="content_proposals" block={speech} />}
    >
      {!hasFeed ? (
        <Quiet>No proposals yet -- Hermes proposes seed topics daily.</Quiet>
      ) : (
        <div className="flex flex-col gap-3">
          <Segmented
            ariaLabel="Proposals"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'pending', label: `Pending (${pending.length})` },
              { value: 'decided', label: `Recently decided (${recent.length})` },
            ]}
          />
          {tab === 'pending' ? (
            newest.length === 0 ? (
              <Quiet>Nothing waiting for you. New proposals arrive with the daily ideation run.</Quiet>
            ) : (
              // Its own scroll, so a long queue doesn't push the rest of the page away.
              <div className="flex flex-col gap-2.5 max-h-[75vh] overflow-y-auto pr-1">
                {newest.map((p) => (
                  <ProposalCard
                    key={deskDecision?.id === p.id ? `${p.id}:${deskDecision.nonce}` : p.id}
                    proposal={p}
                    pillars={pillarsByProperty[p.property_id] ?? []}
                    motion={motionByProperty[p.property_id] ?? null}
                    showProperty={showProperty}
                    onApprove={(edits) => onApprove(p.id, edits)}
                    onReject={(note) => onReject(p.id, note)}
                    onAskDesk={onAskDesk ? () => onAskDesk(p) : undefined}
                    deskDecision={deskDecision?.id === p.id ? deskDecision : null}
                  />
                ))}
              </div>
            )
          ) : recent.length === 0 ? (
            <Quiet>No decisions in the last 30 days.</Quiet>
          ) : (
            <ul className="flex flex-col gap-2 max-h-[75vh] overflow-y-auto pr-1">
              {recent.map((p) => (
                <DecidedItem key={p.id} proposal={p} showProperty={showProperty} lanePositions={lanePositions} />
              ))}
            </ul>
          )}
        </div>
      )}
    </DashboardPanel>
  );
}
