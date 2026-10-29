import { useState, type ReactNode } from 'react';
import type { LandingStats, LanePage, Measurement, Post, TargetsHit } from '../../lib/content-api';
import { num, shortDateTime } from '../shared/format';
import { Chip, ExtLink, Quiet, Tile } from '../shared/ui';
import { humanize } from './format';

/**
 * Measurement by page (contract v1.9-v1.10): Search Console and GA4 landing
 * numbers joined to each long-form post's own page, one row per short-form
 * lane's feed page, and "did it rank?" for a post's target queries. Hermes
 * does the joins and the score; this only shows them.
 */

export const isLongForm = (p: Pick<Post, 'site_path' | 'site_path_kind'>) => !!p.site_path && p.site_path_kind !== 'feed';

/** The reading at the latest checkpoint (day 28 over day 7), or null. */
export function latestCheck(hit?: TargetsHit | null): { day: number; queries: NonNullable<TargetsHit[string]['queries']> } | null {
  const days = Object.keys(hit ?? {})
    .map(Number)
    .filter((d) => Number.isFinite(d));
  if (!hit || !days.length) return null;
  const day = Math.max(...days);
  return { day, queries: hit[String(day)]?.queries ?? [] };
}

export type SortKey = 'score' | 'impressions' | 'position' | 'clicks' | 'sessions' | 'purchases' | 'signups';

const SORT_VALUE: Record<SortKey, (p: Post) => number | null | undefined> = {
  score: (p) => p.score,
  impressions: (p) => p.site?.impressions,
  position: (p) => p.site?.position,
  clicks: (p) => p.site?.clicks,
  sessions: (p) => p.landing?.sessions,
  purchases: (p) => p.landing?.ecommercePurchases,
  signups: (p) => p.signup_sessions,
};

/** Best first: highest, except position (lowest is best). Missing values go last. */
export function sortPosts<T extends Post>(posts: T[], key: SortKey): T[] {
  const value = SORT_VALUE[key];
  const sign = key === 'position' ? 1 : -1;
  return [...posts].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1;
    return sign * (x - y);
  });
}

export function Th({ children, right }: { children: ReactNode; right?: boolean }) {
  return <th className={`py-1 px-2 font-medium ${right ? 'text-right' : 'text-left'}`}>{children}</th>;
}

export function Td({ children, right, title }: { children: ReactNode; right?: boolean; title?: string }) {
  return (
    <td className={`py-1 px-2 align-top ${right ? 'text-right' : ''}`} title={title}>
      {children}
    </td>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <span className="text-[10.5px] uppercase tracking-wide" style={{ color: 'var(--color-text-tertiary)' }}>
      {children}
    </span>
  );
}

/** Purchases from content-site landings; unverified until the operator's cross-domain test. */
export function Purchases({ landing }: { landing?: LandingStats | null }) {
  return (
    <span className="inline-flex items-center justify-end gap-1">
      {num(landing?.ecommercePurchases)}
      {landing?.purchases_verified === false && (
        <Chip tone="warning" title="Not verified yet: the one-time apex → shop tagging test is still open">
          unverified
        </Chip>
      )}
    </span>
  );
}

/** "budget rig · pos 14 · 32 impr." per target query at the latest checkpoint, or the queries still waiting. */
export function TargetsHitLine({ post }: { post: Pick<Post, 'target_queries' | 'targets_hit'> }) {
  const check = latestCheck(post.targets_hit);
  if (!check && !post.target_queries?.length) return null;
  return (
    <span className="flex flex-wrap items-center gap-1 text-[10.5px]" style={{ color: 'var(--color-text-tertiary)' }}>
      {check ? (
        <>
          <span>Targets, day {check.day}:</span>
          {check.queries.map((q) => {
            const hit = (q.impressions ?? 0) > 0;
            return (
              <Chip key={q.query} tone={hit ? (q.position != null && q.position <= 20 ? 'success' : 'accent') : 'muted'}>
                {q.query}
                {hit ? ` · pos ${num(q.position, 1)} · ${num(q.impressions)} impr.` : ' · not shown'}
              </Chip>
            );
          })}
        </>
      ) : (
        <>
          <span>Targets (first check at day 7):</span>
          {post.target_queries!.map((q) => (
            <Chip key={q} tone="muted">
              {q}
            </Chip>
          ))}
        </>
      )}
    </span>
  );
}

/** The property's measurement at a glance (tiles beside the G1 rate). */
export function MeasurementTiles({ m }: { m: Measurement }) {
  const purchases = purchaseSplit(m.purchases_28d);
  return (
    <>
      <Tile label="Search clicks (28 days)" value={num(m.gsc_clicks_28d)} sub={m.regime ? `${m.regime} scoring` : undefined} />
      <Tile
        label="Purchases (28 days)"
        value={num(purchases.total)}
        sub={[
          purchases.paid ? `organic ${num(purchases.organic)}, paid ${num(purchases.paid)}` : null,
          m.purchases_verified === false ? 'unverified' : purchases.paid ? null : 'from content landings',
        ].filter(Boolean).join(' · ')}
        subTone={m.purchases_verified === false ? 'warning' : 'muted'}
      />
      {m.signup_sessions_28d != null && <Tile label="Sign-up sessions (28 days)" value={num(m.signup_sessions_28d)} />}
      <Tile
        label="Pages measured"
        value={`${num(m.with_gsc)} / ${num(m.posts_with_path)}`}
        sub={`${num(m.with_landing)} with landings${sourceGap(m)}`}
      />
    </>
  );
}

/** v1.21 reports purchases as {organic, paid}; older rows carry a plain number. */
export function purchaseSplit(value: Measurement['purchases_28d']): { total: number | null; organic: number | null; paid: number | null } {
  if (value == null) return { total: null, organic: null, paid: null };
  if (typeof value === 'number') return { total: value, organic: value, paid: null };
  const organic = typeof value.organic === 'number' ? value.organic : null;
  const paid = typeof value.paid === 'number' ? value.paid : null;
  return { total: organic == null && paid == null ? null : (organic ?? 0) + (paid ?? 0), organic, paid };
}

function sourceGap(m: Measurement): string {
  const down = (['gsc', 'ga4'] as const).filter((k) => m.sources && m.sources[k] === false);
  return down.length ? ` · ${down.map((k) => (k === 'gsc' ? 'Search Console' : 'GA4')).join(', ')} unavailable` : '';
}

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'impressions', label: 'Impr.' },
  { key: 'position', label: 'Avg pos.' },
  { key: 'clicks', label: 'Clicks' },
  { key: 'sessions', label: 'Sessions' },
  { key: 'purchases', label: 'Purchases' },
  { key: 'signups', label: 'Sign-ups' },
  { key: 'score', label: 'Score' },
];

function SortTh({ col, sort, onSort }: { col: (typeof COLUMNS)[number]; sort: SortKey; onSort: (k: SortKey) => void }) {
  const active = col.key === sort;
  return (
    <th className="py-1 px-2 font-medium text-right" aria-sort={active ? (col.key === 'position' ? 'ascending' : 'descending') : 'none'}>
      <button
        type="button"
        onClick={() => onSort(col.key)}
        className="cursor-pointer"
        style={{
          background: 'transparent',
          border: 'none',
          padding: 0,
          color: active ? 'var(--color-text)' : 'inherit',
          fontWeight: active ? 600 : 500,
        }}
        title={`Sort by ${col.label.toLowerCase()}`}
      >
        {col.label}
        {active ? ' ↓' : ''}
      </button>
    </th>
  );
}

/** One row per long-form post, measured on its own page; sortable, score first. */
export function LongFormTable({
  posts,
  showProperty,
  initialSort = 'score',
}: {
  posts: (Post & { property: string })[];
  showProperty: boolean;
  initialSort?: SortKey;
}) {
  const [sort, setSort] = useState<SortKey>(initialSort);
  const showSignups = posts.some((p) => p.signup_sessions != null);
  const cols = COLUMNS.filter((c) => c.key !== 'signups' || showSignups);
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <SectionLabel>Long-form pages ({posts.length})</SectionLabel>
      <div className="overflow-x-auto max-h-[60vh] overflow-y-auto">
        <table className="w-full text-[12px] tabular-nums">
          <thead>
            <tr style={{ color: 'var(--color-text-tertiary)' }}>
              <Th>Page</Th>
              {cols.map((c) => (
                <SortTh key={c.key} col={c} sort={sort} onSort={setSort} />
              ))}
            </tr>
          </thead>
          <tbody>
            {sortPosts(posts, sort).map((p) => (
              <tr key={`${p.property}:${p.post_id}`} style={{ borderTop: '1px solid var(--color-border)' }}>
                <Td title={p.excerpt ?? undefined}>
                  <div className="flex flex-col gap-0.5 max-w-[24rem]">
                    <span className="line-clamp-2" style={{ color: 'var(--color-text)' }}>
                      {p.excerpt || p.post_id}
                    </span>
                    <span className="text-[10.5px]" style={{ color: 'var(--color-text-tertiary)' }}>
                      {showProperty ? `${p.property} · ` : ''}
                      {p.url ? <ExtLink url={p.url}>{p.site_path}</ExtLink> : p.site_path}
                      {p.pillar ? ` · ${p.pillar}` : ''}
                      {p.distributed_at ? ` · ${shortDateTime(p.distributed_at)}` : ''}
                    </span>
                    <TargetsHitLine post={p} />
                  </div>
                </Td>
                <Td right>{num(p.site?.impressions)}</Td>
                <Td right>{num(p.site?.position, 1)}</Td>
                <Td right>{num(p.site?.clicks)}</Td>
                <Td right>{num(p.landing?.sessions)}</Td>
                <Td right>
                  <Purchases landing={p.landing} />
                </Td>
                {showSignups && <Td right>{num(p.signup_sessions)}</Td>}
                <Td right title={p.score == null ? 'No search, landing or sign-up data yet' : undefined}>
                  <strong style={{ color: 'var(--color-text)' }}>{num(p.score, 1)}</strong>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Short-form lanes link to a feed page, so their traffic is the lane's: one row per page. */
export function LanePagesTable({ pages, showProperty }: { pages: (LanePage & { property: string })[]; showProperty: boolean }) {
  const showSignups = pages.some((p) => p.signup_sessions != null);
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <SectionLabel>Short-form feed pages, per lane</SectionLabel>
      <div className="overflow-x-auto">
        <table className="w-full text-[12px] tabular-nums">
          <thead>
            <tr style={{ color: 'var(--color-text-tertiary)' }}>
              <Th>Feed page</Th>
              <Th right>Posts</Th>
              <Th right>Eng.</Th>
              <Th right>Impr.</Th>
              <Th right>Clicks</Th>
              <Th right>Sessions</Th>
              <Th right>Purchases</Th>
              {showSignups && <Th right>Sign-ups</Th>}
              <Th right>Score</Th>
            </tr>
          </thead>
          <tbody>
            {pages.map((p) => (
              <tr key={`${p.property}:${p.site_path}`} style={{ borderTop: '1px solid var(--color-border)' }}>
                <Td>
                  <span style={{ color: 'var(--color-text)' }}>{p.site_path}</span>
                  <span className="text-[10.5px]" style={{ color: 'var(--color-text-tertiary)' }}>
                    {' '}
                    {[showProperty ? p.property : null, humanize(p.content_type)].filter(Boolean).join(' · ')}
                  </span>
                </Td>
                <Td right>{num(p.posts)}</Td>
                <Td right>{num(p.engagement, 1)}</Td>
                <Td right>{num(p.site?.impressions)}</Td>
                <Td right>{num(p.site?.clicks)}</Td>
                <Td right>{num(p.landing?.sessions)}</Td>
                <Td right>
                  <Purchases landing={p.landing} />
                </Td>
                {showSignups && <Td right>{num(p.signup_sessions)}</Td>}
                <Td right>
                  <strong style={{ color: 'var(--color-text)' }}>{num(p.score, 1)}</strong>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Nothing joined yet, but the feed measures by page: say what's missing. */
export function NotJoinedYet() {
  return <Quiet>No post carries a page yet: page numbers start with the first Foundry snapshot that records each post’s page.</Quiet>;
}
