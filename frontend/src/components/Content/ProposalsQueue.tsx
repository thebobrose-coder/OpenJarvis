import { useState } from 'react';
import { Check, ClipboardList, Pencil, X } from 'lucide-react';
import { LIMITS, type ApprovalEdits, type Proposal } from '../../lib/content-api';
import { DashboardPanel } from '../Dashboard/DashboardPanel';
import { shortDateTime } from '../shared/format';
import { Chip, ExtIcon, ExtLink, Quiet, Segmented, SmallButton } from '../shared/ui';
import { PROPOSAL_STATUS, humanize, laneLabel } from './format';

const OTHER = '__other__';

const field = {
  background: 'var(--color-surface)',
  color: 'var(--color-text)',
  border: '1px solid var(--color-border)',
} as const;

/** What the operator changed, as the approve body: unchanged fields are left
 * out so an untouched approval isn't recorded as an edit. */
export function approvalEdits(
  proposal: Pick<Proposal, 'topic' | 'pillar_hint' | 'product_handle'>,
  form: { topic: string; pillar: string; product: string; note: string },
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
  return edits;
}

function Label({ children }: { children: string }) {
  return (
    <span className="text-[10.5px] uppercase tracking-wide" style={{ color: 'var(--color-text-tertiary)' }}>
      {children}
    </span>
  );
}

/** Inline edit before approving: topic, pillar, product and a note. */
export function ApproveEditor({
  proposal,
  pillars,
  onApprove,
  onCancel,
}: {
  proposal: Proposal;
  /** This property's pillars, from the proposals already present. */
  pillars: string[];
  onApprove: (edits: ApprovalEdits) => void;
  onCancel: () => void;
}) {
  const current = proposal.pillar_hint ?? '';
  const options = [...new Set([current, ...pillars].filter(Boolean))];
  const [topic, setTopic] = useState(proposal.topic);
  const [pillarChoice, setPillarChoice] = useState(current || OTHER);
  const [pillarText, setPillarText] = useState('');
  const [product, setProduct] = useState(proposal.product_handle ?? '');
  const [note, setNote] = useState('');
  const pillar = pillarChoice === OTHER ? pillarText : pillarChoice;

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
      <p className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
        Your edits are yours, not Hermes copy. Foundry’s compliance scan and G1 approval still apply.
      </p>
      <div className="flex gap-1.5">
        <SmallButton
          tone="accent"
          disabled={!topic.trim()}
          onClick={() => onApprove(approvalEdits(proposal, { topic, pillar, product, note }))}
        >
          <Check size={11} /> Approve
        </SmallButton>
        <SmallButton onClick={onCancel}>Cancel</SmallButton>
      </div>
    </div>
  );
}

/** Reject is final: ask for an optional note and say so. */
export function RejectConfirm({ onReject, onCancel }: { onReject: (note: string) => void; onCancel: () => void }) {
  const [note, setNote] = useState('');
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

function ProposalMeta({ proposal, showProperty }: { proposal: Proposal; showProperty: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {showProperty && <Chip tone="accent">{proposal.property_id}</Chip>}
      <Chip>{laneLabel(proposal.lane)}</Chip>
      {proposal.signal_type && <Chip tone="muted">{humanize(proposal.signal_type)}</Chip>}
      {proposal.pillar_hint && <Chip title="Pillar">{proposal.pillar_hint}</Chip>}
      {proposal.product_handle && (
        <Chip tone="muted" title="Product">
          {proposal.product_handle}
        </Chip>
      )}
      <span className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
        {shortDateTime(proposal.created_at)}
      </span>
    </div>
  );
}

export function ProposalCard({
  proposal,
  pillars,
  showProperty,
  onApprove,
  onReject,
  initialMode = 'idle',
}: {
  proposal: Proposal;
  pillars: string[];
  showProperty: boolean;
  onApprove: (edits: ApprovalEdits) => void;
  onReject: (note: string) => void;
  initialMode?: 'idle' | 'edit' | 'reject';
}) {
  const [mode, setMode] = useState(initialMode);
  const links = proposal.source_links ?? [];

  return (
    <article
      className="flex flex-col gap-2 rounded-lg p-3"
      style={{ background: 'var(--color-bg-secondary)', border: '1px solid var(--color-border-subtle, var(--color-border))' }}
    >
      <ProposalMeta proposal={proposal} showProperty={showProperty} />
      <h3 className="text-[13.5px] font-semibold leading-snug" style={{ color: 'var(--color-text)' }}>
        {proposal.topic}
      </h3>
      {proposal.rationale && <p>{proposal.rationale}</p>}
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
        <ApproveEditor proposal={proposal} pillars={pillars} onApprove={onApprove} onCancel={() => setMode('idle')} />
      ) : mode === 'reject' ? (
        <RejectConfirm onReject={onReject} onCancel={() => setMode('idle')} />
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          <SmallButton tone="accent" onClick={() => onApprove({})} title="Approve as proposed: Foundry's intake queues it">
            <Check size={11} /> Approve
          </SmallButton>
          <SmallButton onClick={() => setMode('edit')} title="Edit the topic, pillar or product, then approve">
            <Pencil size={11} /> Edit & approve
          </SmallButton>
          <SmallButton onClick={() => setMode('reject')} title="Reject (final)">
            <X size={11} /> Reject
          </SmallButton>
        </div>
      )}
    </article>
  );
}

function DecidedItem({ proposal, showProperty }: { proposal: Proposal; showProperty: boolean }) {
  const status = PROPOSAL_STATUS[proposal.status] ?? { label: proposal.status, tone: 'neutral' as const };
  const reasons = proposal.status === 'intake_rejected' ? proposal.result?.reasons ?? [] : [];
  return (
    <li className="flex flex-col gap-1 rounded-md p-2" style={{ background: 'var(--color-bg-secondary)' }}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip tone={status.tone}>{status.label}</Chip>
        {showProperty && <Chip tone="accent">{proposal.property_id}</Chip>}
        <Chip>{laneLabel(proposal.lane)}</Chip>
        {proposal.approval?.edited && <Chip tone="muted">edited</Chip>}
        <span className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
          {shortDateTime(proposal.decided_at ?? proposal.created_at)}
        </span>
      </div>
      <span style={{ color: 'var(--color-text)' }}>{proposal.topic}</span>
      {reasons.length > 0 && (
        <span className="text-[11.5px]" style={{ color: 'var(--color-error)' }}>
          Intake reasons: {reasons.map(humanize).join(', ')}
        </span>
      )}
      {proposal.note && <span className="italic">“{proposal.note}”</span>}
    </li>
  );
}

export type QueueTab = 'pending' | 'decided';

export function ProposalsQueue({
  pending,
  recent,
  pillarsByProperty,
  showProperty,
  onApprove,
  onReject,
  loading,
  error,
  hasFeed,
  size = 'wide',
  initialTab = 'pending',
}: {
  pending: Proposal[];
  recent: Proposal[];
  pillarsByProperty: Record<string, string[]>;
  showProperty: boolean;
  onApprove: (id: string, edits: ApprovalEdits) => void;
  onReject: (id: string, note: string) => void;
  loading?: boolean;
  error?: string | null;
  hasFeed: boolean;
  size?: 'wide' | 'full';
  initialTab?: QueueTab;
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
                    key={p.id}
                    proposal={p}
                    pillars={pillarsByProperty[p.property_id] ?? []}
                    showProperty={showProperty}
                    onApprove={(edits) => onApprove(p.id, edits)}
                    onReject={(note) => onReject(p.id, note)}
                  />
                ))}
              </div>
            )
          ) : recent.length === 0 ? (
            <Quiet>No decisions in the last 30 days.</Quiet>
          ) : (
            <ul className="flex flex-col gap-2 max-h-[75vh] overflow-y-auto pr-1">
              {recent.map((p) => (
                <DecidedItem key={p.id} proposal={p} showProperty={showProperty} />
              ))}
            </ul>
          )}
        </div>
      )}
    </DashboardPanel>
  );
}
