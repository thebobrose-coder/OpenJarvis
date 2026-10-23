import { useState } from 'react';
import { PackageCheck, Send, Sprout, X } from 'lucide-react';
import {
  HANDLE_RE,
  SEED_LIMITS,
  type ContentSeedbank,
  type Lane,
  type Proposal,
  type SeedBody,
  type SeedbankProperty,
  type ThesisPrompt,
  type VerifyResult,
} from '../../lib/content-api';
import { DashboardPanel } from '../Dashboard/DashboardPanel';
import { Chip, Segmented, SmallButton } from '../shared/ui';
import { PROPOSAL_STATUS, humanize, isSeedRefusal, laneLabel } from './format';
import { QueryChips, cleanQueries } from './ProposalsQueue';

const PRIORITIES = ['1', '2', '3'] as const;
const DEFAULT_PRIORITY = 2;

const field = {
  background: 'var(--color-surface)',
  color: 'var(--color-text)',
  border: '1px solid var(--color-border)',
} as const;

/** What the composer opens with: empty ("New seed") or from a thesis prompt. */
export interface SeedDraft {
  property_id: string;
  lane: string;
  text: string;
  url: string;
  source_prompt_id?: string;
}

/** A property's lanes a seed may target: seedable or operator-only, never a feed lane. */
export const seedableLanes = (p: SeedbankProperty): Lane[] =>
  p.lanes.filter((l) => (l.seedable || l.operator_only) && !l.feed_lane && !l.lane.startsWith('feed:'));

export const seedProperties = (seedbank: ContentSeedbank | null): SeedbankProperty[] =>
  (seedbank?.properties ?? []).filter((p) => p.active !== false && seedableLanes(p).length > 0);

export const isShortForm = (lane: Lane) => lane.lane === 'short' || lane.content_type === 'short';

/** Target queries: long-form only, and never on an operator-only thesis (v1.10, 0008 A1 D6). */
export const queriesAllowed = (lane: Lane) => !isShortForm(lane) && !lane.operator_only;

/** The title Foundry's intake takes for a long-form seed: line 1, at most 120 characters. */
export function seedTitle(text: string): string {
  const first = text.trim().split(/\r?\n/)[0] ?? '';
  return first.trim().slice(0, SEED_LIMITS.title);
}

export function emptyDraft(seedbank: ContentSeedbank | null, propertyId?: string): SeedDraft {
  const props = seedProperties(seedbank);
  const prop = props.find((p) => p.id === propertyId) ?? props[0];
  return { property_id: prop?.id ?? '', lane: prop ? seedableLanes(prop)[0]?.lane ?? '' : '', text: '', url: '' };
}

/** "Seed this": the prompt's property and its thesis lane, signal + why it matters, the first link. */
export function draftFromPrompt(prompt: ThesisPrompt, seedbank: ContentSeedbank | null): SeedDraft {
  const prop = seedProperties(seedbank).find((p) => p.id === prompt.property_id);
  const lanes = prop ? seedableLanes(prop) : [];
  const lane =
    lanes.find((l) => l.content_type === 'thesis' && l.operator_only) ??
    lanes.find((l) => l.content_type === 'thesis') ??
    lanes.find((l) => !isShortForm(l)) ??
    lanes[0];
  const text = [prompt.signal.trim(), (prompt.why_it_matters ?? '').trim()].filter(Boolean).join('\n\n');
  return {
    property_id: prompt.property_id,
    lane: lane?.lane ?? '',
    text: text.slice(0, SEED_LIMITS.text),
    url: (prompt.links ?? []).find((u) => u.startsWith('https://')) ?? '',
    source_prompt_id: prompt.id,
  };
}

export interface SeedForm {
  property_id: string;
  text: string;
  pillar: string;
  product: string;
  url: string;
  queries: string[];
  priority: number;
  source_prompt_id?: string;
}

/** The body Queue sends: only the bridge's keys, empty fields left out. */
export function seedBody(form: SeedForm, lane: Lane): SeedBody {
  const body: SeedBody = { property_id: form.property_id, content_type: lane.content_type, text: form.text.trim() };
  if (form.pillar) body.pillar_hint = form.pillar;
  if (form.product.trim()) body.product_handle = form.product.trim();
  if (form.url.trim()) body.url = form.url.trim();
  const queries = queriesAllowed(lane) ? cleanQueries(form.queries) : [];
  if (queries.length) body.target_queries = queries;
  body.priority = form.priority;
  if (form.source_prompt_id) body.source_prompt_id = form.source_prompt_id;
  return body;
}

/** What stops Queue, checked as the bridge checks it. */
export function seedProblems(form: SeedForm, lane: Lane | undefined, verify: VerifyResult | null): string[] {
  const out: string[] = [];
  if (!form.property_id || !lane) out.push('Pick a property and a lane.');
  const text = form.text.trim();
  if (!text) out.push('Write the seed text.');
  if (text.length > SEED_LIMITS.text) out.push(`Text is over ${SEED_LIMITS.text} characters.`);
  const product = form.product.trim();
  if (product && !HANDLE_RE.test(product)) out.push('Product handle: lowercase letters, digits and hyphens only.');
  if (product && verify?.state === 'not_found') out.push('That product handle is not in the store.');
  const url = form.url.trim();
  if (url && (!url.startsWith('https://') || url.length > SEED_LIMITS.url)) {
    out.push(`URL must start https:// and be at most ${SEED_LIMITS.url} characters.`);
  }
  return out;
}

function Label({ children }: { children: string }) {
  return (
    <span className="text-[10.5px] uppercase tracking-wide" style={{ color: 'var(--color-text-tertiary)' }}>
      {children}
    </span>
  );
}

export function VerifyLine({ verify }: { verify: VerifyResult | 'checking' | null }) {
  if (verify == null) return null;
  const [color, text] =
    verify === 'checking'
      ? ['var(--color-text-tertiary)', 'Checking…']
      : verify.state === 'found'
        ? ['var(--color-success)', `Found${verify.title ? `: ${verify.title}` : ''}${verify.source ? ` (${verify.source})` : ''}`]
        : verify.state === 'not_found'
          ? ['var(--color-error)', 'Not found in the store']
          : ['var(--color-warning)', `Couldn’t check (${verify.reason}); you can still queue, the intake checks again`];
  return (
    <span role="status" className="text-[11px]" style={{ color }}>
      {text}
    </span>
  );
}

/** After Queue: the proposal id, then the item's progress as Hermes reports it. */
export function SeedSent({
  proposalId,
  proposal,
  lanePositions,
}: {
  proposalId: string;
  /** The item in `content_proposals`, once Hermes has picked the seed up. */
  proposal?: Proposal | null;
  lanePositions?: Record<string, number>;
}) {
  const status = proposal ? PROPOSAL_STATUS[proposal.status] ?? { label: proposal.status, tone: 'neutral' as const } : null;
  const signalId = typeof proposal?.result?.signalId === 'string' ? (proposal.result.signalId as string) : null;
  const position = signalId ? lanePositions?.[signalId] : undefined;
  const reasons = proposal?.status === 'intake_rejected' ? proposal.result?.reasons ?? [] : [];
  return (
    <div role="status" className="flex flex-col gap-1.5 rounded-lg p-3" style={{ border: '1px solid var(--color-accent-subtle)', background: 'var(--color-bg)' }}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip tone="success">sent</Chip>
        <span className="text-[11.5px]" style={{ color: 'var(--color-text-secondary)' }}>
          Proposal <code>{proposalId}</code>
        </span>
        {status && <Chip tone={status.tone}>{status.label}</Chip>}
        {position != null && <Chip tone="accent">lane position {position}</Chip>}
      </div>
      {!proposal && (
        <span className="text-[11.5px]" style={{ color: 'var(--color-text-tertiary)' }}>
          Hermes checks it within about 2 minutes; Foundry’s intake queues it at :20, or now with Run intake now.
        </span>
      )}
      {proposal && isSeedRefusal(proposal.note) && (
        <span className="text-[11.5px]" style={{ color: 'var(--color-error)' }}>
          {proposal.note}
        </span>
      )}
      {reasons.length > 0 && (
        <span className="text-[11.5px]" style={{ color: 'var(--color-error)' }}>
          Intake reasons: {reasons.map(humanize).join(', ')}
        </span>
      )}
    </div>
  );
}

/**
 * The operator's own seed for any active property and any seedable or
 * operator-only lane (contract v1.16). Hermes carries it to Foundry's outbox;
 * it is born approved, so the only checks left are Hermes's and the intake's.
 * Opened empty from the header or pre-filled by a thesis prompt's "Seed this".
 */
export function SeedComposer({
  seedbank,
  draft,
  proposals = [],
  lanePositions,
  onQueue,
  onVerify,
  onClose,
  initialSent = null,
  initialVerify = null,
}: {
  seedbank: ContentSeedbank | null;
  draft: SeedDraft;
  /** Pending and recently decided proposals, to follow a sent seed. */
  proposals?: Proposal[];
  lanePositions?: Record<string, number>;
  /** Resolves to the proposal id Hermes minted. */
  onQueue: (body: SeedBody) => Promise<string>;
  onVerify: (property: string, handle: string) => Promise<VerifyResult>;
  onClose: () => void;
  /** For tests. */
  initialSent?: string | null;
  initialVerify?: VerifyResult | null;
}) {
  const props = seedProperties(seedbank);
  const [propertyId, setPropertyId] = useState(draft.property_id);
  const [laneKey, setLaneKey] = useState(draft.lane);
  const [text, setText] = useState(draft.text);
  const [pillar, setPillar] = useState('');
  const [product, setProduct] = useState('');
  const [verify, setVerify] = useState<VerifyResult | 'checking' | null>(initialVerify);
  const [url, setUrl] = useState(draft.url);
  const [queries, setQueries] = useState<string[]>([]);
  const [priority, setPriority] = useState(DEFAULT_PRIORITY);
  const [phase, setPhase] = useState<'editing' | 'sending' | 'sent'>(initialSent ? 'sent' : 'editing');
  const [sentId, setSentId] = useState<string | null>(initialSent);
  const [error, setError] = useState<string | null>(null);

  const prop = props.find((p) => p.id === propertyId);
  const lanes = prop ? seedableLanes(prop) : [];
  const lane = lanes.find((l) => l.lane === laneKey);
  const pillars = prop?.pillars ?? [];
  const fromPrompt = !!draft.source_prompt_id && propertyId === draft.property_id;
  const form: SeedForm = {
    property_id: propertyId,
    text,
    pillar,
    product,
    url,
    queries,
    priority,
    source_prompt_id: fromPrompt ? draft.source_prompt_id : undefined,
  };
  const checked = verify === 'checking' ? null : verify;
  const problems = seedProblems(form, lane, checked);
  const body = lane ? seedBody(form, lane) : null;
  const longForm = lane ? !isShortForm(lane) : false;
  const handleOk = HANDLE_RE.test(product.trim());

  const pickProperty = (id: string) => {
    setPropertyId(id);
    const next = props.find((p) => p.id === id);
    setLaneKey(next ? seedableLanes(next)[0]?.lane ?? '' : '');
    setPillar('');
    setVerify(null);
  };

  const check = async () => {
    setVerify('checking');
    setVerify(await onVerify(propertyId, product.trim()));
  };

  const queue = async () => {
    if (!body || problems.length) return;
    setPhase('sending');
    setError(null);
    try {
      setSentId(await onQueue(body));
      setPhase('sent');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Not queued; try again.');
      setPhase('editing');
    }
  };

  const sentProposal = sentId ? proposals.find((p) => p.id === sentId) ?? null : null;

  return (
    <DashboardPanel
      icon={Sprout}
      title={fromPrompt ? 'Seed this prompt' : 'New seed'}
      tag={prop ? prop.id : undefined}
      size="full"
      actions={
        <SmallButton onClick={onClose} title="Close the composer">
          <X size={11} /> Close
        </SmallButton>
      }
    >
      {phase === 'sent' && sentId ? (
        <SeedSent proposalId={sentId} proposal={sentProposal} lanePositions={lanePositions} />
      ) : props.length === 0 ? (
        <p className="text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>
          No seedable property in the seedbank yet.
        </p>
      ) : (
        <div role="group" aria-label="Compose a seed" className="flex flex-col gap-2.5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <label className="flex flex-col gap-1">
              <Label>Property</Label>
              <select value={propertyId} onChange={(e) => pickProperty(e.target.value)} className="rounded-md px-1.5 py-1 text-[12px] cursor-pointer" style={field}>
                {props.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex flex-col gap-1">
              <Label>Lane</Label>
              <div className="flex flex-wrap items-center gap-1.5">
                <Segmented
                  ariaLabel="Lane"
                  value={laneKey}
                  onChange={setLaneKey}
                  options={lanes.map((l) => ({ value: l.lane, label: `${laneLabel(l.lane)} · ${l.content_type}` }))}
                />
                {lane?.operator_only && (
                  <Chip tone="warning" title="Only you seed this lane; Hermes never proposes it">
                    operator-only
                  </Chip>
                )}
              </div>
            </div>
          </div>

          <label className="flex flex-col gap-1">
            <span className="flex items-center justify-between gap-2">
              <Label>Text</Label>
              <span className="text-[10.5px]" style={{ color: text.trim().length > SEED_LIMITS.text ? 'var(--color-error)' : 'var(--color-text-tertiary)' }}>
                {text.trim().length} / {SEED_LIMITS.text}
              </span>
            </span>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value.slice(0, SEED_LIMITS.text + 200))}
              rows={longForm ? 10 : 4}
              placeholder={longForm ? 'Title on the first line, then the seed' : 'The seed topic'}
              className="w-full rounded-md px-2 py-1.5 text-[12.5px] resize-y"
              style={field}
            />
            {longForm && seedTitle(text) && (
              <span className="text-[11.5px]" style={{ color: 'var(--color-text-secondary)' }}>
                Title: <strong style={{ color: 'var(--color-text)' }}>{seedTitle(text)}</strong>
              </span>
            )}
          </label>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <label className="flex flex-col gap-1">
              <Label>Pillar</Label>
              <select value={pillar} onChange={(e) => setPillar(e.target.value)} className="rounded-md px-1.5 py-1 text-[12px] cursor-pointer" style={field}>
                <option value="">None</option>
                {pillars.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex flex-col gap-1">
              <Label>Product</Label>
              <span className="flex items-center gap-1.5">
                <input
                  value={product}
                  onChange={(e) => {
                    setProduct(e.target.value.slice(0, 120));
                    setVerify(null);
                  }}
                  placeholder="Product handle (optional)"
                  aria-label="Product handle"
                  className="flex-1 min-w-0 rounded-md px-2 py-1 text-[12px]"
                  style={field}
                />
                <SmallButton onClick={() => void check()} disabled={!handleOk || verify === 'checking'} title="Is this handle in the property's store?">
                  <PackageCheck size={11} /> Verify
                </SmallButton>
              </span>
              <VerifyLine verify={verify} />
            </div>
          </div>

          <label className="flex flex-col gap-1">
            <Label>URL</Label>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value.slice(0, SEED_LIMITS.url))}
              placeholder="https:// source link (optional)"
              className="rounded-md px-2 py-1 text-[12px]"
              style={field}
            />
          </label>

          <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2">
            {lane && queriesAllowed(lane) ? (
              <div className="flex flex-col gap-1">
                <Label>Target queries</Label>
                <QueryChips queries={queries} onChange={setQueries} />
              </div>
            ) : (
              <span />
            )}
            <div className="flex flex-col gap-1">
              <Label>Priority</Label>
              <Segmented
                ariaLabel="Priority"
                value={String(priority) as (typeof PRIORITIES)[number]}
                onChange={(v) => setPriority(Number(v))}
                options={PRIORITIES.map((v) => ({ value: v, label: v === '1' ? '1 low' : v === '3' ? '3 high' : v }))}
              />
            </div>
          </div>

          <details>
            <summary className="cursor-pointer text-[11.5px]" style={{ color: 'var(--color-text-tertiary)' }}>
              What Queue sends
            </summary>
            <pre
              aria-label="Seed JSON"
              className="mt-1.5 rounded-md p-2 text-[11px] whitespace-pre-wrap break-words max-h-64 overflow-y-auto"
              style={{ background: 'var(--color-bg-secondary)', color: 'var(--color-text-secondary)' }}
            >
              {JSON.stringify(body, null, 2)}
            </pre>
          </details>

          {problems.length > 0 && text.trim() && (
            <ul className="text-[11.5px] pl-4 list-disc" style={{ color: 'var(--color-warning)' }}>
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          {error && (
            <p role="alert" className="text-[11.5px]" style={{ color: 'var(--color-error)' }}>
              {error}
            </p>
          )}
          <p className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
            Your seed, born approved. Hermes checks the lane, pillar and wording; Foundry’s intake, compliance scan and G1 still apply.
            {fromPrompt ? ' The prompt is marked used once the seed reaches the outbox.' : ''}
          </p>
          <div className="flex gap-1.5">
            <SmallButton tone="accent" onClick={() => void queue()} disabled={problems.length > 0 || phase === 'sending'}>
              <Send size={11} /> {phase === 'sending' ? 'Queueing…' : 'Queue'}
            </SmallButton>
            <SmallButton onClick={onClose}>Cancel</SmallButton>
          </div>
        </div>
      )}
    </DashboardPanel>
  );
}
