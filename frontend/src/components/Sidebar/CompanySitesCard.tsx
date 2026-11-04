import { Chip, Quiet } from '../shared/ui';
import { ago } from '../../lib/waiting-api';
import {
  HASH_CHARS,
  checkedStale,
  ga4Text,
  gscText,
  hostOf,
  type EntityWatch,
  type SiteRow,
} from '../../lib/sites-api';

function SiteCard({ row, now }: { row: SiteRow; now: number }) {
  const stale = checkedStale(row.checked_at, now);
  return (
    <li
      className="flex flex-col gap-1.5 rounded-lg px-2.5 py-2"
      style={{ background: 'var(--color-bg-secondary)' }}
      data-site={row.id}
    >
      <span className="flex flex-wrap items-center justify-between gap-1.5">
        <span className="font-mono text-[11.5px]" style={{ color: 'var(--color-text)' }}>
          {hostOf(row.apex) ?? row.id}
        </span>
        <span
          className="text-[11px] tabular-nums"
          style={{ color: stale ? 'var(--color-warning)' : 'var(--color-text-tertiary)' }}
          data-checked={stale ? 'stale' : 'fresh'}
          title={row.checked_at ?? undefined}
        >
          checked {row.checked_at ? ago(row.checked_at, now) : 'never'}
          {stale ? ' · stale' : ''}
        </span>
      </span>
      <ul className="flex flex-col gap-1">
        {row.serve.map((s) => (
          <li key={s.path} className="flex flex-wrap items-center gap-1.5 text-[11px]" data-serve={s.ok ? 'ok' : 'fail'}>
            <Chip tone={s.ok ? 'success' : 'error'} title={s.error ?? undefined}>
              {s.status ?? '—'}
            </Chip>
            <span className="font-mono" style={{ color: 'var(--color-text)' }}>
              {s.path}
            </span>
            {!s.ok && s.error && <span style={{ color: 'var(--color-error)' }}>{s.error}</span>}
            {s.last_modified && <span style={{ color: 'var(--color-text-tertiary)' }}>{s.last_modified}</span>}
          </li>
        ))}
      </ul>
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[11px]">
        <dt style={{ color: 'var(--color-text-tertiary)' }}>Privacy</dt>
        <dd className="font-mono" data-privacy>
          {row.privacy_sha256 ? row.privacy_sha256.slice(0, HASH_CHARS) : 'none'}
        </dd>
        <dt style={{ color: 'var(--color-text-tertiary)' }}>Search Console</dt>
        <dd data-gsc>{gscText(row.gsc)}</dd>
        <dt style={{ color: 'var(--color-text-tertiary)' }}>GA4</dt>
        <dd data-ga4>{ga4Text(row.ga4)}</dd>
      </dl>
    </li>
  );
}

/**
 * Company sites (contract v1.27): one card per entity from Hermes's daily
 * `entity_watch` read. Read-only: no button, no refresh. A `checked_at`
 * older than 36 h reads stale, in amber.
 */
export function CompanySitesCard({ sites, error, now }: { sites: EntityWatch | null; error?: string | null; now: number }) {
  if (!sites) return <Quiet>{error ?? 'Loading company sites…'}</Quiet>;
  return (
    <div className="flex flex-col gap-2" data-company-sites>
      {sites.stale && <Quiet>Hermes unavailable: the last copy, {ago(sites.generated_at, now)}.</Quiet>}
      {sites.entities.length === 0 ? (
        <Quiet>No company sites in the feed.</Quiet>
      ) : (
        <ul className="flex flex-col gap-2">
          {sites.entities.map((row) => (
            <SiteCard key={row.id} row={row} now={now} />
          ))}
        </ul>
      )}
    </div>
  );
}
