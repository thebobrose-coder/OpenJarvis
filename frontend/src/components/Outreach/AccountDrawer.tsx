import { useState } from 'react';
import { ExternalLink, X } from 'lucide-react';
import { Drawer } from '../shared/Drawer';
import { Chip, ExtLink, Select, SmallButton } from '../shared/ui';
import { shortDateTime } from '../shared/format';
import {
  COLLAB_STATES,
  LIMITS,
  STATUSES,
  TIERS,
  engagedWords,
  type Account,
  type AccountEdits,
  type AccountStatus,
  type CollabState,
  type Tier,
} from '../../lib/outreach-api';

const field = { background: 'var(--color-bg-secondary)', color: 'var(--color-text)', border: '1px solid var(--color-border)' };

const TIER_HELP: Record<Tier, string> = {
  peer: 'about your size',
  large: 'a big account in the niche',
  creator: 'a person who makes things in the niche',
};

/** What changed against the stored account, trimmed as the server trims it. */
export function accountEdits(account: Account, form: Required<AccountEdits>): AccountEdits {
  const edits: AccountEdits = {};
  for (const key of ['niche', 'why', 'notes'] as const) {
    if (form[key].trim() !== account[key]) edits[key] = form[key].trim();
  }
  if (form.tier !== account.tier) edits.tier = form.tier;
  if (form.status !== account.status) edits.status = form.status;
  if (form.collab_state !== account.collab_state) edits.collab_state = form.collab_state;
  return edits;
}

function Label({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-ui-10-5 font-semibold uppercase tracking-wide" style={{ color: 'var(--color-text-tertiary)' }}>
        {title}
      </span>
      {children}
    </label>
  );
}

/** One account's details (0031 C1), edited as the BizDev prospect drawer is:
 * the handle and the profile link are fixed; the rest is the operator's. */
export function AccountDrawer({
  account,
  now,
  onClose,
  onOpenProfile,
  onSave,
}: {
  account: Account;
  now: number;
  onClose: () => void;
  onOpenProfile: (url: string) => void;
  onSave: (edits: AccountEdits) => Promise<void>;
}) {
  const [form, setForm] = useState<Required<AccountEdits>>({
    niche: account.niche,
    tier: account.tier,
    why: account.why,
    status: account.status,
    collab_state: account.collab_state,
    notes: account.notes,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const edits = accountEdits(account, form);
  const dirty = Object.keys(edits).length > 0;
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(edits);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Not saved');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Drawer open onClose={onClose} label={`@${account.handle}`} width="narrow">
      <header className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h2 className="text-ui-15 font-semibold" style={{ color: 'var(--color-text)' }}>
            @{account.handle}
          </h2>
          <span>
            last engaged {engagedWords(account.last_engaged_at, now)} · added {shortDateTime(account.added_at)} · from {account.source === 'hermes' ? 'Hermes' : 'you'}
          </span>
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip>{account.tier}</Chip>
            <Chip tone={account.status === 'active' ? 'success' : account.status === 'paused' ? 'warning' : 'muted'}>{account.status}</Chip>
            {account.collab_state !== 'none' && <Chip tone="accent">collab {account.collab_state}</Chip>}
          </div>
        </div>
        <button onClick={onClose} aria-label="Close" className="cursor-pointer" style={{ background: 'transparent', border: 'none', color: 'inherit' }}>
          <X size={14} />
        </button>
      </header>

      <div>
        <SmallButton tone="accent" onClick={() => onOpenProfile(account.profile_url)} title={`Open ${account.profile_url} in your browser`}>
          <ExternalLink size={11} /> Open the profile
        </SmallButton>
      </div>
      {account.found_on && (
        <span className="text-ui-11" style={{ color: 'var(--color-text-tertiary)' }}>
          Hermes found it on <ExtLink url={account.found_on}>{account.found_on}</ExtLink>
        </span>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Select<Tier> label="Tier" value={form.tier} onChange={(tier) => setForm({ ...form, tier })} options={TIERS.map((t) => ({ value: t, label: `${t}: ${TIER_HELP[t]}` }))} />
        <Select<AccountStatus> label="Status" value={form.status} onChange={(status) => setForm({ ...form, status })} options={STATUSES.map((s) => ({ value: s, label: s }))} />
        <Select<CollabState> label="Collab" value={form.collab_state} onChange={(collab_state) => setForm({ ...form, collab_state })} options={COLLAB_STATES.map((s) => ({ value: s, label: s }))} />
      </div>
      <Label title="Niche">
        <input value={form.niche} maxLength={LIMITS.niche} onChange={(e) => setForm({ ...form, niche: e.target.value })} className="rounded-md px-2 py-1.5" style={field} placeholder="What the account is about" />
      </Label>
      <Label title="Why it is on the list">
        <textarea value={form.why} maxLength={LIMITS.why} rows={2} onChange={(e) => setForm({ ...form, why: e.target.value })} className="rounded-md px-2 py-1.5 resize-y" style={field} />
      </Label>
      <Label title="Notes">
        <textarea value={form.notes} maxLength={LIMITS.notes} rows={4} onChange={(e) => setForm({ ...form, notes: e.target.value })} className="rounded-md px-2 py-1.5 resize-y" style={field} placeholder="Yours only. The angles read the niche, the why and these notes." />
      </Label>
      <div className="flex flex-wrap items-center gap-2">
        <SmallButton tone="accent" disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save'}
        </SmallButton>
        <span className="text-ui-11" style={{ color: error ? 'var(--color-error)' : 'var(--color-text-tertiary)' }}>
          {error ?? (form.status !== 'active' ? 'Paused and dropped accounts stay out of the round.' : 'Active accounts rotate through the round.')}
        </span>
      </div>
    </Drawer>
  );
}
