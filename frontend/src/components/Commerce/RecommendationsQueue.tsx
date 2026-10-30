import { useState } from 'react';
import { Check, CheckCheck, ClipboardList, History, MessageSquarePlus, Wrench, X } from 'lucide-react';
import type { Decision, EcomRecommendations, LedgerItem, RecCategory } from '../../lib/commerce-api';
import type { PendingDecision } from '../../hooks/useCommerceData';
import { applyDecisions } from '../../hooks/useCommerceData';
import { FIX_NOTE } from '../../lib/waiting-api';
import { DashboardPanel } from '../Dashboard/DashboardPanel';
import { ALL_STORES, num, shortDateTime } from './format';
import { MessagesSquare } from 'lucide-react';
import { Chip, ExtLink, Quiet, Select, SmallButton, Tile, type Tone } from '../shared/ui';

export const CATEGORY_LABELS: Record<RecCategory, string> = {
  spend: 'Spend',
  content: 'Content',
  seo_technical: 'SEO · technical',
  seo_page: 'SEO · page',
  merchandising: 'Merchandising',
  tracking: 'Tracking',
  compliance: 'Compliance',
};

const PRIORITY: Record<number, { label: string; tone: Tone }> = {
  1: { label: 'P1', tone: 'warning' },
  2: { label: 'P2', tone: 'accent' },
  3: { label: 'P3', tone: 'muted' },
};

const STATUS_TONE: Record<string, Tone> = {
  accepted: 'accent',
  done: 'success',
  rejected: 'muted',
  expired: 'muted',
};

function Meta({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <span>
      <span style={{ color: 'var(--color-text-tertiary)' }}>{label} </span>
      {value}
    </span>
  );
}

function DecisionControls({
  onDecide,
  allowed,
  fix = false,
}: {
  onDecide: (d: Decision, note: string) => void;
  allowed: Decision[];
  /** A product-copy rec (0024 J1): Fix it takes Accept's place. */
  fix?: boolean;
}) {
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const decide = (d: Decision) => onDecide(d, note);

  return (
    <div className="flex flex-col gap-2">
      {noteOpen && (
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value.slice(0, 500))}
          rows={2}
          placeholder="Optional note (kept with the decision)"
          className="w-full rounded-md px-2 py-1.5 text-[12px] resize-y"
          style={{ background: 'var(--color-bg-secondary)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
        />
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {allowed.includes('accepted') && fix && (
          <span data-fix>
            <SmallButton
              tone="accent"
              onClick={() => onDecide('accepted', FIX_NOTE)}
              title="The catalog fixer writes the copy as a patch in Fixes; you tick it there"
            >
              <Wrench size={11} /> Fix it
            </SmallButton>
          </span>
        )}
        {allowed.includes('accepted') && !fix && (
          <SmallButton tone="accent" onClick={() => decide('accepted')} title="Accept: you intend to act on it">
            <Check size={11} /> Accept
          </SmallButton>
        )}
        {allowed.includes('rejected') && (
          <SmallButton onClick={() => decide('rejected')} title="Reject (final)">
            <X size={11} /> Reject
          </SmallButton>
        )}
        {allowed.includes('done') && (
          <SmallButton tone="success" onClick={() => decide('done')} title="Done: it has been carried out (final)">
            <CheckCheck size={11} /> Done
          </SmallButton>
        )}
        {!noteOpen && (
          <button
            onClick={() => setNoteOpen(true)}
            className="inline-flex items-center gap-1 text-[11px] cursor-pointer ml-1"
            style={{ background: 'transparent', border: 'none', color: 'var(--color-text-tertiary)' }}
          >
            <MessageSquarePlus size={11} /> Add note
          </button>
        )}
      </div>
    </div>
  );
}

/** "patch ready" (v1.23): the catalog fixer has a patch for this rec. */
function PatchReady({ id, onOpenFix }: { id?: string | null; onOpenFix?: (patchId: string) => void }) {
  if (!id) return null;
  return onOpenFix ? (
    <button
      onClick={() => onOpenFix(id)}
      data-patch-ready={id}
      title="Open the patch on the Fixes tab"
      className="cursor-pointer underline text-[11px]"
      style={{ background: 'transparent', border: 'none', padding: 0, color: 'var(--color-accent)' }}
    >
      patch ready
    </button>
  ) : (
    <span data-patch-ready={id}>
      <Chip tone="accent">patch ready</Chip>
    </span>
  );
}

export function RecommendationCard({
  item,
  storeName,
  productTitles,
  onDecide,
  onAskDesk,
  onOpenFix,
  fix = false,
}: {
  item: LedgerItem;
  storeName: string;
  /** Product id -> title, so product and page targets read as names. */
  productTitles: Record<string, string>;
  onDecide: (d: Decision, note: string) => void;
  /** "Ask the desk" (0020 P3): a Commerce desk thread with this card as context. */
  onAskDesk?: () => void;
  /** Show a patch's card on the Fixes tab ("patch ready", v1.23). */
  onOpenFix?: (patchId: string) => void;
  /** The waiting feed marks this rec `fix: true`. */
  fix?: boolean;
}) {
  const r = item.detail;
  const p = PRIORITY[item.priority] ?? PRIORITY[3];
  const target = r.target;
  const targetLabel = (target?.ref && productTitles[target.ref]) || target?.ref;

  return (
    <article
      id={`rec-${item.id}`}
      className="flex flex-col gap-2 rounded-lg p-3"
      style={{ background: 'var(--color-bg-secondary)', border: '1px solid var(--color-border-subtle, var(--color-border))' }}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip tone={p.tone}>{p.label}</Chip>
        <Chip>{CATEGORY_LABELS[item.category] ?? item.category}</Chip>
        <span className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
          {storeName} · {shortDateTime(item.created_at)}
        </span>
        {r.note && (
          <span data-rec-note>
            <Chip tone="muted" title="Filed: no action here">
              {r.note}
            </Chip>
          </span>
        )}
        <PatchReady id={item.fix_patch_id} onOpenFix={onOpenFix} />
        {onAskDesk && (
          <span className="ml-auto">
            <SmallButton onClick={onAskDesk} title="Open a Commerce desk thread with this recommendation as context">
            <MessagesSquare size={11} /> Ask the desk
          </SmallButton>
          </span>
        )}
      </div>

      <h3 className="text-[13.5px] font-semibold leading-snug" style={{ color: 'var(--color-text)' }}>
        {item.title}
      </h3>

      {target?.ref && (
        <div className="text-[11.5px]" style={{ color: 'var(--color-accent)' }}>
          <span style={{ color: 'var(--color-text-tertiary)' }}>{target.type ?? 'target'}: </span>
          <ExtLink url={target.url} title={target.ref}>{targetLabel}</ExtLink>
        </div>
      )}

      {r.action && <p style={{ color: 'var(--color-text)' }}>{r.action}</p>}
      {r.rationale && <p>{r.rationale}</p>}
      {r.expected_impact && (
        <p>
          <span style={{ color: 'var(--color-text-tertiary)' }}>Expected impact: </span>
          {r.expected_impact}
        </p>
      )}

      {r.spend && (
        <div>
          <Chip tone="warning" title="Suggested daily budget change">
            ${num(r.spend.daily_budget_usd, 2)}/day · {r.spend.change}
          </Chip>
        </div>
      )}

      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]">
        <Meta label="Confidence" value={r.confidence} />
        <Meta label="Effort" value={r.effort} />
        <Meta label="Owner" value={r.owner} />
      </div>

      <DecisionControls onDecide={onDecide} allowed={['accepted', 'rejected', 'done']} fix={fix} />
    </article>
  );
}

function LedgerStats({ ledger }: { ledger: EcomRecommendations }) {
  const c = ledger.counts;
  const rate = ledger.acceptance_rate;
  return (
    <div className="grid grid-cols-3 gap-2">
      <Tile label="Open" value={num(c.open)} />
      <Tile label="Accepted" value={num(c.accepted)} />
      <Tile label="Done" value={num(c.done)} />
      <Tile label="Rejected" value={num(c.rejected)} />
      <Tile label="Expired" value={num(c.expired)} />
      <Tile label="Accept rate" value={rate == null ? '—' : `${Math.round(rate * 100)}%`} />
    </div>
  );
}

function RecentlyDecided({
  items,
  storeNames,
  onDecide,
  onOpenFix,
}: {
  items: LedgerItem[];
  storeNames: Record<string, string>;
  onDecide: (id: string, d: Decision, note: string) => void;
  onOpenFix?: (patchId: string) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="flex flex-col gap-2">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide cursor-pointer"
        style={{ background: 'transparent', border: 'none', padding: 0, color: 'var(--color-text-tertiary)' }}
        aria-expanded={open}
      >
        <History size={11} /> Recently decided ({items.length}) {open ? '▾' : '▸'}
      </button>
      {open &&
        (items.length === 0 ? (
          <Quiet>No decisions yet. Every accept, reject and done is recorded here.</Quiet>
        ) : (
          <ul className="flex flex-col gap-2">
            {items.map((i) => (
              <li key={i.id} id={`rec-${i.id}`} className="flex flex-col gap-1 rounded-md p-2" style={{ background: 'var(--color-bg-secondary)' }}>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Chip tone={STATUS_TONE[i.status] ?? 'neutral'}>{i.status}</Chip>
                  <span className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
                    {storeNames[i.store] ?? i.store} · {shortDateTime(i.decided_at)}
                  </span>
                  <PatchReady id={i.fix_patch_id} onOpenFix={onOpenFix} />
                </div>
                <span style={{ color: 'var(--color-text)' }}>{i.title}</span>
                {i.note && <span className="italic">“{i.note}”</span>}
                {i.status === 'accepted' && (
                  <DecisionControls allowed={['done']} onDecide={(d, note) => onDecide(i.id, d, note)} />
                )}
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}

export function RecommendationsQueue({
  ledger,
  pending,
  selectedStore,
  onSelectStore,
  stores,
  storeNames,
  productTitles,
  onDecide,
  onAskDesk,
  onOpenFix,
  fixRecs,
  loading,
  error,
}: {
  ledger: EcomRecommendations | null;
  pending: Record<string, PendingDecision>;
  selectedStore: string;
  onSelectStore: (slug: string) => void;
  stores: { slug: string; display_name: string }[];
  storeNames: Record<string, string>;
  productTitles: Record<string, string>;
  onDecide: (id: string, d: Decision, note: string) => void;
  onAskDesk?: (item: LedgerItem) => void;
  onOpenFix?: (patchId: string) => void;
  /** Rec ids the waiting feed marks `fix: true` (0024 J1). */
  fixRecs?: ReadonlySet<string>;
  loading?: boolean;
  error?: string | null;
}) {
  const [category, setCategory] = useState<'all' | RecCategory>('all');
  const [owner, setOwner] = useState('all');
  const { open, recent } = applyDecisions(ledger, pending);

  const owners = [...new Set(open.map((i) => i.detail.owner).filter(Boolean) as string[])].sort();
  const categories = [...new Set(open.map((i) => i.category))].sort();
  const visible = open.filter(
    (i) =>
      (selectedStore === ALL_STORES || i.store === selectedStore) &&
      (category === 'all' || i.category === category) &&
      (owner === 'all' || i.detail.owner === owner),
  );
  const recentVisible = recent.filter((i) => selectedStore === ALL_STORES || i.store === selectedStore);

  return (
    <div className="col-span-12 grid grid-cols-12 gap-4">
      <DashboardPanel
        icon={ClipboardList}
        title="Recommendations"
        tag={ledger ? `${visible.length} open` : undefined}
        size="wide"
        priority
        loading={loading}
        error={error}
      >
        {!ledger ? (
          <Quiet>No recommendations yet -- they come with the daily briefing.</Quiet>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <Select
                label="Store"
                value={selectedStore}
                onChange={onSelectStore}
                options={[{ value: ALL_STORES, label: 'All' }, ...stores.map((s) => ({ value: s.slug, label: s.display_name }))]}
              />
              <Select
                label="Category"
                value={category}
                onChange={setCategory}
                options={[{ value: 'all', label: 'All' }, ...categories.map((c) => ({ value: c, label: CATEGORY_LABELS[c] ?? c }))]}
              />
              <Select
                label="Owner"
                value={owner}
                onChange={setOwner}
                options={[{ value: 'all', label: 'All' }, ...owners.map((o) => ({ value: o, label: o }))]}
              />
            </div>
            {visible.length === 0 ? (
              <Quiet>Nothing open for this filter.</Quiet>
            ) : (
              // Its own scroll, so a long queue doesn't push the rest of the page away.
              <div className="flex flex-col gap-2.5 max-h-[70vh] overflow-y-auto pr-1">
                {visible.map((item) => (
                  <RecommendationCard
                    key={item.id}
                    item={item}
                    storeName={storeNames[item.store] ?? item.store}
                    productTitles={productTitles}
                    onDecide={(d, note) => onDecide(item.id, d, note)}
                    onAskDesk={onAskDesk ? () => onAskDesk(item) : undefined}
                    onOpenFix={onOpenFix}
                    fix={fixRecs?.has(item.id) ?? false}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </DashboardPanel>

      <DashboardPanel icon={History} title="Decision ledger" tag="Track record" size="tall" loading={loading}>
        {!ledger ? (
          <Quiet>No ledger yet.</Quiet>
        ) : (
          <div className="flex flex-col gap-3">
            <LedgerStats ledger={ledger} />
            <RecentlyDecided items={recentVisible} storeNames={storeNames} onDecide={onDecide} onOpenFix={onOpenFix} />
          </div>
        )}
      </DashboardPanel>
    </div>
  );
}
