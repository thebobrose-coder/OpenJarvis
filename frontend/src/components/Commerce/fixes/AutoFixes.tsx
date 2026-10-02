import { useCallback, useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { fetchCatalogFixes, fixRequest, postFix, type AutoFix, type FixStatus } from '../../../lib/fixes-api';
import { runDecision } from '../../../hooks/useCatalogFixes';
import { Chip, ExtIcon, ExtLink, SmallButton } from '../../shared/ui';
import { shortDateTime } from '../format';
import { NoteConfirm, REVERT_QUESTION } from './PatchCard';

/** The statuses a fix can be reverted from (contract §2, revert route). */
export const REVERTABLE: FixStatus[] = ['applied', 'verified', 'failed-verify'];

const ruleWords = (rule: string) => (/^\d+$/.test(rule) ? `rule ${rule}` : rule);

/**
 * The catalog fixes the writer applied without asking since the previous
 * 06:00 digest (v1.4, 0011 A13), each with a Revert while its status in
 * catalog_fixes still allows one. Pure: statuses and the revert come in.
 */
export function AutoFixesList({
  fixes,
  statuses,
  onRevert,
  notes = {},
  pending = {},
}: {
  fixes: AutoFix[];
  /** Each patch's current status in catalog_fixes; missing: no Revert. */
  statuses: Record<string, FixStatus>;
  onRevert: (id: string, note: string) => void;
  notes?: Record<string, string>;
  pending?: Record<string, boolean>;
}) {
  const [asking, setAsking] = useState<string | null>(null);
  if (!fixes.length) return null;
  return (
    <section className="flex flex-col gap-1.5 text-[12px]" data-auto-fixes>
      <span className="text-[11px] font-medium" style={{ color: 'var(--color-text-tertiary)' }}>
        Fixes applied automatically ({fixes.length})
      </span>
      <ul className="flex flex-col gap-1.5">
        {fixes.map((f) => {
          const status = statuses[f.patch_id];
          const revertable = !!status && REVERTABLE.includes(status) && !pending[f.patch_id];
          return (
            <li key={f.patch_id} className="flex flex-col gap-1" data-auto-fix={f.patch_id} data-fix-status={status}>
              <span className="flex flex-wrap items-center gap-1.5" style={{ color: 'var(--color-text)' }}>
                <ExtLink url={f.admin_url} title="Open in Shopify admin">
                  {f.product_title}
                </ExtLink>
                <ExtIcon url={f.admin_url} title="Open in Shopify admin" />
                <Chip tone="muted">
                  {ruleWords(f.fix_class.rule)} · {f.fix_class.field}
                </Chip>
                <span className="tabular-nums text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
                  {shortDateTime(f.applied_at)}
                </span>
                {pending[f.patch_id] && <Chip tone="muted">revert requested · recording…</Chip>}
                {revertable && asking !== f.patch_id && (
                  <SmallButton tone="warning" onClick={() => setAsking(f.patch_id)} title={REVERT_QUESTION}>
                    <RotateCcw size={11} /> Revert
                  </SmallButton>
                )}
              </span>
              {revertable && asking === f.patch_id && (
                <div className="flex flex-col gap-1.5" data-revert-confirm>
                  <span style={{ color: 'var(--color-text)' }}>{REVERT_QUESTION}</span>
                  <NoteConfirm
                    label="Revert"
                    tone="warning"
                    onConfirm={(note) => {
                      setAsking(null);
                      onRevert(f.patch_id, note);
                    }}
                    onCancel={() => setAsking(null)}
                  />
                </div>
              )}
              {notes[f.patch_id] && (
                <span className="text-[11.5px]" role="status" style={{ color: 'var(--color-warning)' }}>
                  {notes[f.patch_id]}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** AutoFixesList wired to the live feed and the existing revert proxy. It
 * reads catalog_fixes only when the digest lists something. */
export function AutoFixes({ fixes }: { fixes?: AutoFix[] | null }) {
  const [statuses, setStatuses] = useState<Record<string, FixStatus>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const any = !!fixes?.length;

  const load = useCallback(async () => {
    try {
      const feed = await fetchCatalogFixes();
      setStatuses(Object.fromEntries((feed?.patches ?? []).map((p) => [p.id, p.status])));
    } catch {
      setStatuses({});
    }
  }, []);

  useEffect(() => {
    if (any) void load();
  }, [any, load]);

  if (!fixes?.length) return null;
  const revert = async (id: string, note: string) => {
    setNotes((n) => ({ ...n, [id]: '' }));
    const outcome = await runDecision(fixRequest('revert', { id, patch_sha256: '' }, { note }), postFix, load);
    if (outcome.ok) setPending((p) => ({ ...p, [id]: true }));
    else setNotes((n) => ({ ...n, [id]: outcome.message }));
  };
  return (
    <AutoFixesList
      fixes={fixes}
      statuses={statuses}
      notes={notes}
      pending={pending}
      onRevert={(id, note) => void revert(id, note)}
    />
  );
}
