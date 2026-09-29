import { AlertTriangle, Info } from 'lucide-react';
import type { HealthAlert } from '../../lib/content-api';
import { Chip } from '../shared/ui';
import { humanize } from './format';

const RANK: Record<string, number> = { warn: 0, info: 1 };

/** Warnings first, then info; stable within a severity. */
export function sortAlerts(alerts: HealthAlert[]): HealthAlert[] {
  return alerts
    .map((a, i) => ({ a, i }))
    .sort((x, y) => (RANK[x.a.severity] ?? 2) - (RANK[y.a.severity] ?? 2) || x.i - y.i)
    .map(({ a }) => a);
}

/** Hermes's report on the pipeline (it never acts on it): a strip under the header. */
export function HealthStrip({ alerts, showProperty }: { alerts: HealthAlert[]; showProperty: boolean }) {
  if (alerts.length === 0) return null;
  return (
    <section
      aria-label="Content health"
      className="flex flex-col gap-1.5 rounded-xl px-4 py-3 mb-4"
      style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
    >
      {sortAlerts(alerts).map((a, i) => {
        const warn = a.severity === 'warn';
        const Icon = warn ? AlertTriangle : Info;
        return (
          <div key={i} className="flex items-start gap-2 text-[12px]" data-severity={a.severity}>
            <Icon
              size={13}
              style={{ color: warn ? 'var(--color-warning)' : 'var(--color-text-tertiary)', flexShrink: 0, marginTop: 2 }}
            />
            <span className="flex flex-wrap items-center gap-1.5" style={{ color: 'var(--color-text-secondary)' }}>
              {showProperty && a.property && <Chip tone="accent">{a.property}</Chip>}
              <Chip tone={warn ? 'warning' : 'muted'}>{humanize(a.kind)}</Chip>
              <span style={{ color: 'var(--color-text)' }}>{a.message}</span>
            </span>
          </div>
        );
      })}
    </section>
  );
}
