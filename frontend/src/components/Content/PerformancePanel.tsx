import { Activity } from 'lucide-react';
import type { ContentPerformance, PerformanceProperty, Post, RollupKey, RollupRow } from '../../lib/content-api';
import { DashboardPanel } from '../Dashboard/DashboardPanel';
import { num, shortDateTime } from '../shared/format';
import { Chip, Quiet, Tile, type Tone } from '../shared/ui';
import { humanize, matchesProperty, pct } from './format';
import { LanePagesTable, LongFormTable, MeasurementTiles, NotJoinedYet, SectionLabel, Td, Th, isLongForm } from './Measurement';

const RECENT_MAX = 30;

const ROLLUPS: { key: RollupKey; label: string }[] = [
  { key: 'pillar', label: 'By pillar' },
  { key: 'origin', label: 'By origin' },
  { key: 'content_type', label: 'By content type' },
];

const G1_TONE: Record<string, Tone> = { APPROVED: 'success', REJECTED: 'error', TIMED_OUT: 'warning' };

function G1Chip({ value }: { value?: string | null }) {
  if (!value) return <span>—</span>;
  return <Chip tone={G1_TONE[value] ?? 'neutral'}>{humanize(value.toLowerCase())}</Chip>;
}

/** "12 likes · 3 comments"; zeros and missing counts are left out. */
export function socialLine(social: Post['social']): string {
  const parts = (['likes', 'comments', 'shares', 'saves'] as const)
    .filter((k) => social?.[k])
    .map((k) => `${num(social?.[k])} ${social?.[k] === 1 ? k.slice(0, -1) : k}`);
  return parts.length ? parts.join(' · ') : '—';
}

function RollupTable({ label, dim, rows }: { label: string; dim: RollupKey; rows: RollupRow[] }) {
  // v1.9 rows carry a score (and sort by it); an older feed's rows don't.
  const scored = rows.some((r) => 'score' in r);
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <SectionLabel>{label}</SectionLabel>
      {rows.length === 0 ? (
        <Quiet>No posts yet.</Quiet>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[12px] tabular-nums">
            <thead>
              <tr style={{ color: 'var(--color-text-tertiary)' }}>
                <Th>{humanize(dim)}</Th>
                <Th right>Posts</Th>
                <Th right>Avg eng.</Th>
                <Th right>Clicks</Th>
                <Th right>Sessions</Th>
                {scored && <Th right>Score</Th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} style={{ borderTop: '1px solid var(--color-border)' }}>
                  <Td>{String(r[dim] ?? '—')}</Td>
                  <Td right>{num(r.posts)}</Td>
                  <Td right>{num(r.avg_engagement, 1)}</Td>
                  <Td right>{num(r.site_clicks)}</Td>
                  <Td right>{num(r.sessions)}</Td>
                  {scored && <Td right>{num(r.score as number | null, 1)}</Td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function RecentPosts({ posts, showProperty }: { posts: (Post & { property: string })[]; showProperty: boolean }) {
  const recent = [...posts].sort((a, b) => (b.distributed_at ?? '').localeCompare(a.distributed_at ?? '')).slice(0, RECENT_MAX);
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <SectionLabel>Recent posts{posts.length > RECENT_MAX ? ` (latest ${RECENT_MAX} of ${posts.length})` : ''}</SectionLabel>
      <div className="overflow-x-auto max-h-[60vh] overflow-y-auto">
        <table className="w-full text-[12px] tabular-nums">
          <thead>
            <tr style={{ color: 'var(--color-text-tertiary)' }}>
              <Th>Post</Th>
              <Th>Pillar</Th>
              <Th>Origin</Th>
              <Th>G1</Th>
              <Th right>Eng.</Th>
              <Th>Social</Th>
              <Th right>Clicks</Th>
              <Th right>Sessions</Th>
            </tr>
          </thead>
          <tbody>
            {recent.map((p) => (
              <tr key={`${p.property}:${p.post_id}`} style={{ borderTop: '1px solid var(--color-border)' }}>
                <Td title={p.excerpt ?? undefined}>
                  <div className="flex flex-col gap-0.5 max-w-[22rem]">
                    <span className="line-clamp-2" style={{ color: 'var(--color-text)' }}>
                      {p.excerpt || p.post_id}
                    </span>
                    <span className="text-[10.5px]" style={{ color: 'var(--color-text-tertiary)' }}>
                      {showProperty ? `${p.property} · ` : ''}
                      {p.content_type ? `${p.content_type} · ` : ''}
                      {shortDateTime(p.distributed_at)}
                    </span>
                  </div>
                </Td>
                <Td>{p.pillar ?? '—'}</Td>
                <Td>{p.origin}</Td>
                <Td>
                  <G1Chip value={p.g1} />
                </Td>
                <Td right>{num(p.engagement, 1)}</Td>
                <Td>{socialLine(p.social)}</Td>
                <Td right>{num(p.site?.clicks)}</Td>
                <Td right>{num(p.landing?.sessions ?? p.utm?.sessions)}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function G1Tiles({ property, label }: { property: PerformanceProperty; label?: string }) {
  const counts = property.g1?.counts ?? {};
  const decided = Object.values(counts).reduce((a, b) => a + b, 0);
  return (
    <Tile
      label={label ? `${label} · G1 approval` : 'G1 approval rate'}
      value={pct(property.g1?.approval_rate)}
      sub={
        decided
          ? Object.entries(counts)
              .map(([k, n]) => `${num(n)} ${humanize(k.toLowerCase())}`)
              .join(' · ')
          : 'no G1 outcomes yet'
      }
    />
  );
}

export function PerformancePanel({
  performance,
  selectedProperty,
  loading,
  error,
}: {
  performance: ContentPerformance | null;
  selectedProperty: string;
  loading?: boolean;
  error?: string | null;
}) {
  const properties = (performance?.properties ?? []).filter((p) => matchesProperty(selectedProperty, p.id));
  const posts = properties.flatMap((p) => p.posts.map((post) => ({ ...post, property: p.id })));
  const single = properties.length === 1 ? properties[0] : null;
  // v1.9: measured by page. An older feed has no `measurement` and shows none of this.
  const measured = properties.some((p) => p.measurement != null);
  const longForm = posts.filter(isLongForm);
  const lanePages = properties.flatMap((p) => (p.lane_pages ?? []).map((page) => ({ ...page, property: p.id })));

  return (
    <DashboardPanel icon={Activity} title="Performance" tag="Daily · 30 days" size="full" loading={loading} error={error}>
      {posts.length === 0 ? (
        <Quiet>Measurement starts when Foundry’s daily snapshot arrives.</Quiet>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
            {single ? (
              <>
                <G1Tiles property={single} />
                <Tile label="Posts (30 days)" value={num(single.posts.length)} />
                {single.measurement && <MeasurementTiles m={single.measurement} />}
              </>
            ) : (
              properties.map((p) => <G1Tiles key={p.id} property={p} label={p.id} />)
            )}
          </div>
          {measured &&
            (longForm.length || lanePages.length ? (
              <>
                {longForm.length > 0 && <LongFormTable posts={longForm} showProperty={!single} />}
                {lanePages.length > 0 && <LanePagesTable pages={lanePages} showProperty={!single} />}
              </>
            ) : (
              <NotJoinedYet />
            ))}
          {single ? (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              {ROLLUPS.map((r) => (
                <RollupTable key={r.key} label={r.label} dim={r.key} rows={single.rollups?.[r.key] ?? []} />
              ))}
            </div>
          ) : (
            <Quiet>Pick a property to see its rollups by pillar, origin and content type.</Quiet>
          )}
          <RecentPosts posts={posts} showProperty={!single} />
        </div>
      )}
    </DashboardPanel>
  );
}
