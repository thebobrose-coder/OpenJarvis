import { useEffect, useState, type ReactNode } from 'react';
import { Drawer } from '../shared/Drawer';
import { X } from 'lucide-react';
import { Chip, Quiet } from '../shared/ui';
import { useWaiting } from '../../lib/WaitingContext';
import { ago, fetchReport, fetchReports, rowStatusText, type RowStatus, type WorkOrderReport } from '../../lib/waiting-api';
import { DismissControl } from './WaitingListView';

const STATUS_TONE: Record<string, 'success' | 'error' | 'warning'> = {
  done: 'success',
  failed: 'error',
  blocked: 'warning',
  rejected: 'warning',
};

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-ui-10-5 uppercase tracking-wide" style={{ color: 'var(--color-text-tertiary)' }}>
        {label}
      </span>
      {children}
    </div>
  );
}

/** Dismiss in the drawer (0024 J4): the row's state and the call. */
export interface ReportDismiss {
  status?: RowStatus;
  onDismiss: (id: string, note: string) => void;
}

const shortDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

/** One report, read-only but for Dismiss (0023 O4, 0024 J4). */
export function ReportView({
  report,
  now,
  dismiss,
}: {
  report: WorkOrderReport;
  now: number;
  dismiss?: ReportDismiss;
}) {
  return (
    <article className="flex flex-col gap-2" data-report={report.id}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-ui-11-5" style={{ color: 'var(--color-text)' }}>
          {report.id}
        </span>
        <Chip tone={STATUS_TONE[report.status] ?? 'muted'}>{report.status}</Chip>
        <span className="text-ui-10-5" style={{ color: 'var(--color-text-tertiary)' }}>
          {ago(report.finishedAt, now)}
        </span>
        {report.dismissedAt && (
          <span data-dismissed={report.id}>
            <Chip tone="muted" title={report.dismissNote ?? undefined}>
              dismissed {shortDate(report.dismissedAt)}
            </Chip>
          </span>
        )}
      </div>
      {report.dismissNote && (
        <span className="italic text-ui-11-5">“{report.dismissNote}”</span>
      )}
      {dismiss && !report.dismissedAt && dismiss.status?.kind !== 'dismissed' && (
        <DismissControl id={report.id} busy={dismiss.status?.kind === 'busy'} onDismiss={(note) => dismiss.onDismiss(report.id, note)} />
      )}
      {dismiss?.status && dismiss.status.kind !== 'busy' && (
        <span
          className="text-ui-11"
          data-row-status={dismiss.status.kind}
          style={{ color: dismiss.status.kind === 'error' ? 'var(--color-error)' : 'var(--color-text-secondary)' }}
        >
          {rowStatusText(dismiss.status)}
        </span>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Field label="Repo">{report.repo ?? '—'}</Field>
        <Field label="Scope">{report.scope ?? '—'}</Field>
        <Field label="Branch">{report.branch ?? '—'}</Field>
        <Field label="Cost">{report.costUsd == null ? '—' : `$${report.costUsd.toFixed(2)}`}</Field>
      </div>
      {report.needsHuman && (
        <Field label="Needs you">
          <span style={{ color: 'var(--color-warning)' }}>{report.needsHuman}</span>
        </Field>
      )}
      {report.reason && <Field label="Reason">{report.reason}</Field>}
      <Field label="Summary">
        <span className="whitespace-pre-wrap">{report.summary ?? 'No summary in the report.'}</span>
      </Field>
    </article>
  );
}

/** Pure: one report by id, or every report ('*'), newest first. */
export function ReportsView({
  reports,
  open,
  now,
  status = {},
  onDismiss,
}: {
  reports: WorkOrderReport[];
  open: string;
  now: number;
  /** Row states by `workorder:<id>`. */
  status?: Record<string, RowStatus>;
  onDismiss?: (id: string, note: string) => void;
}) {
  const shown = open === '*' ? reports : reports.filter((r) => r.id === open);
  if (shown.length === 0) return <Quiet>{open === '*' ? 'No work-order reports in the last 7 days.' : 'That report is gone.'}</Quiet>;
  return (
    <div className="flex flex-col gap-4">
      {shown.map((r) => (
        <ReportView
          key={r.id}
          report={r}
          now={now}
          dismiss={onDismiss ? { status: status[`workorder:${r.id}`], onDismiss } : undefined}
        />
      ))}
    </div>
  );
}

/** The drawer shell: reads the 7-day list ('*'), or one report by id at any age. */
export function ReportsDrawer() {
  const { reportOpen, setReportOpen, rowStatus, dismiss } = useWaiting();
  const [reports, setReports] = useState<WorkOrderReport[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!reportOpen) return;
    setError(null);
    (reportOpen === '*' ? fetchReports() : fetchReport(reportOpen)).then(setReports, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [reportOpen, reload]);

  useEffect(() => {
    if (reportOpen) setReports(null);
  }, [reportOpen]);

  const onDismiss = (id: string, note: string) => {
    void dismiss({ kind: 'workorder', id }, note).then((ok) => ok && setReload((n) => n + 1));
  };

  if (!reportOpen) return null;
  return (
    <Drawer open onClose={() => setReportOpen(null)} label="Work-order reports" width="narrow">
      <header className="flex items-center justify-between gap-2">
        <h2 className="text-ui-15 font-semibold" style={{ color: 'var(--color-text)' }}>
          {reportOpen === '*' ? 'Work-order reports (7 days)' : 'Work-order report'}
        </h2>
        <button onClick={() => setReportOpen(null)} aria-label="Close" className="cursor-pointer" style={{ background: 'transparent', border: 'none', color: 'inherit' }}>
          <X size={16} />
        </button>
      </header>
      {reports ? <ReportsView reports={reports} open={reportOpen} now={Date.now()} status={rowStatus} onDismiss={onDismiss} /> : <Quiet>{error ?? 'Loading…'}</Quiet>}
    </Drawer>
  );
}
