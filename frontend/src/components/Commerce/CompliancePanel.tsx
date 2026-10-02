import { ShieldCheck } from 'lucide-react';
import type { ComplianceFinding, ComplianceFindings } from '../../lib/commerce-api';
import { DashboardPanel } from '../Dashboard/DashboardPanel';
import { SpeakButton } from '../shared/SpeakButton';
import { firstBlock } from '../../lib/voice-api';
import { num } from './format';
import { Chip, ExtLink, Quiet } from '../shared/ui';

/** The advisory reasons (v1.4, 0011 A12) in words; an unknown one shows as is. */
const ADVISORY_WORDS: Record<string, string> = {
  spec_carried_over: 'spec carried over',
};

/** "2 of 3 readings": a finding opened on writer copy by majority (A12). */
export const readingsLabel = (r: NonNullable<ComplianceFinding['readings']>) => `${r.flagged} of ${r.of} readings`;

function FindingLine({ f }: { f: ComplianceFinding }) {
  return (
    <>
      <span style={{ color: 'var(--color-text-tertiary)' }}>{f.property}</span>
      <ExtLink url={f.link} title="Open">
        {f.location ?? f.id.slice(0, 8)}
      </ExtLink>
      {f.field && <span style={{ color: 'var(--color-text-tertiary)' }}>{f.field}</span>}
      {f.quote && <span className="italic">“{f.quote}”</span>}
      {f.readings && (
        <Chip tone="muted" title="The judge took 3 readings on writer copy">
          {readingsLabel(f.readings)}
        </Chip>
      )}
    </>
  );
}

/**
 * Open compliance findings per property. The compliance sentinel names its
 * properties independently of the store slugs, so this panel always shows
 * every property rather than following the store switcher. Advisory
 * findings (v1.4) are listed collapsed and never count as open.
 */
export function CompliancePanel({
  findings,
  loading,
  error,
  onOpenFix,
}: {
  findings: ComplianceFindings | null;
  loading?: boolean;
  error?: string | null;
  /** Show a patch's card on the Fixes tab. */
  onOpenFix?: (patchId: string) => void;
}) {
  const byProperty = Object.entries(findings?.counts.open_by_property ?? {}).sort((a, b) => b[1] - a[1]);
  const advisory = findings?.advisory_findings ?? [];
  const majority = (findings?.open_findings ?? []).filter((f) => f.readings);
  return (
    <DashboardPanel
      icon={ShieldCheck}
      title="Compliance"
      tag="Daily"
      size="full"
      loading={loading}
      error={error}
      actions={<SpeakButton feed="compliance_findings" block={firstBlock(findings?.speech)} />}
    >
      {!findings ? (
        <Quiet>No compliance run yet.</Quiet>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12.5px]" data-open-count style={{ color: 'var(--color-text)' }}>
              {num(findings.counts.open)} open finding{findings.counts.open === 1 ? '' : 's'}
              {findings.counts.new ? ` · ${num(findings.counts.new)} new` : ''}
            </span>
            {byProperty.map(([property, n]) => (
              <Chip key={property} tone={n ? 'warning' : 'success'}>
                {property} · {num(n)}
              </Chip>
            ))}
          </div>
          {majority.length > 0 && (
            <details className="text-[11.5px]" data-majority style={{ color: 'var(--color-text-secondary)' }}>
              <summary className="cursor-pointer" style={{ color: 'var(--color-text-tertiary)' }}>
                Opened on writer copy by majority ({majority.length})
              </summary>
              <ul className="flex flex-col gap-1 mt-1">
                {majority.map((f) => (
                  <li key={f.id} className="flex flex-wrap items-center gap-1.5">
                    <FindingLine f={f} />
                  </li>
                ))}
              </ul>
            </details>
          )}
          {advisory.length > 0 && (
            <details className="text-[11.5px]" data-advisory style={{ color: 'var(--color-text-secondary)' }}>
              <summary className="cursor-pointer" style={{ color: 'var(--color-text-tertiary)' }}>
                Advisory ({advisory.length})
              </summary>
              <p className="mt-1" style={{ color: 'var(--color-text-tertiary)' }}>
                A spec quoted on the writer’s copy, unchanged from before the fix. Not counted as open; the fixer
                never sees these.
              </p>
              <ul className="flex flex-col gap-1 mt-1">
                {advisory.map((f) => (
                  <li key={f.id} className="flex flex-wrap items-center gap-1.5" data-advisory-id={f.id}>
                    <Chip tone="muted">advisory: {ADVISORY_WORDS[f.advisory_reason] ?? f.advisory_reason}</Chip>
                    <FindingLine f={f} />
                    {f.patch_id && onOpenFix && (
                      <button
                        onClick={() => onOpenFix(f.patch_id!)}
                        data-open-fix={f.patch_id}
                        className="cursor-pointer underline"
                        style={{ background: 'transparent', border: 'none', padding: 0, color: 'var(--color-accent)' }}
                      >
                        fix {f.patch_id.slice(0, 6)}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </DashboardPanel>
  );
}
