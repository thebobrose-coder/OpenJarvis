import { ScanSearch } from 'lucide-react';
import type { ComplianceFinding, ComplianceFindings } from '../../lib/commerce-api';
import { DashboardPanel } from '../Dashboard/DashboardPanel';
import { Quiet } from '../shared/ui';
import { CompliancePanel } from './CompliancePanel';
import { PrecheckWidget, type PrecheckProps } from './PrecheckWidget';

export interface ComplianceTabProps {
  findings: ComplianceFindings | null;
  loading?: boolean;
  error?: string | null;
  precheck?: PrecheckProps;
  onOpenFix?: (patchId: string) => void;
  onAskDesk?: (f?: ComplianceFinding) => void;
  /** A finding to show open (a patch card's chip): its rule group expands. */
  focusFinding?: string | null;
}

/**
 * The Compliance tab (widescreen plan 4.2): the compliance sentinel names its
 * properties independently of the store slugs, so this is property-wide and never
 * followed the store switcher; a tab says so better than a last row did. The
 * paste-and-check tool comes first, as its own card, instead of inside the findings.
 */
export function ComplianceTab({ findings, loading, error, precheck, onOpenFix, onAskDesk, focusFinding }: ComplianceTabProps) {
  return (
    <div id="commerce-compliance">
      <div className="grid grid-cols-12 gap-4 mb-4">
        <DashboardPanel icon={ScanSearch} title="Paste and check" tag="Foundry pre-check" size="full" band="short">
          {precheck ? (
            <PrecheckWidget {...precheck} />
          ) : (
            <Quiet>The pre-check needs the desks' data folder; it is not configured here.</Quiet>
          )}
        </DashboardPanel>
      </div>
      <div className="grid grid-cols-12 gap-4 mb-10">
        <CompliancePanel
          findings={findings}
          loading={loading}
          error={error}
          onOpenFix={onOpenFix}
          onAskDesk={onAskDesk}
          focusFinding={focusFinding}
        />
      </div>
    </div>
  );
}
