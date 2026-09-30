import { ShieldCheck } from 'lucide-react';
import type { ComplianceFindings } from '../../lib/commerce-api';
import { DashboardPanel } from '../Dashboard/DashboardPanel';
import { SpeakButton } from '../shared/SpeakButton';
import { firstBlock } from '../../lib/voice-api';
import { num } from './format';
import { Chip, Quiet } from '../shared/ui';

/**
 * Open compliance findings per property. The compliance sentinel names its
 * properties independently of the store slugs, so this panel always shows
 * every property rather than following the store switcher. (There's no
 * findings view in OpenJarvis yet to link to.)
 */
export function CompliancePanel({ findings, loading, error }: { findings: ComplianceFindings | null; loading?: boolean; error?: string | null }) {
  const byProperty = Object.entries(findings?.counts.open_by_property ?? {}).sort((a, b) => b[1] - a[1]);
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
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12.5px]" style={{ color: 'var(--color-text)' }}>
            {num(findings.counts.open)} open finding{findings.counts.open === 1 ? '' : 's'}
            {findings.counts.new ? ` · ${num(findings.counts.new)} new` : ''}
          </span>
          {byProperty.map(([property, n]) => (
            <Chip key={property} tone={n ? 'warning' : 'success'}>
              {property} · {num(n)}
            </Chip>
          ))}
        </div>
      )}
    </DashboardPanel>
  );
}
