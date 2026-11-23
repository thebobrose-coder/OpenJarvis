import { Trophy } from 'lucide-react';
import type { ContentWinners, PageQuery, TargetsRollup, VideoWinners, WinnerPost, WinnersProperty } from '../../lib/content-api';
import { DashboardPanel } from '../Dashboard/DashboardPanel';
import { num, shortDateTime } from '../shared/format';
import { Chip, ExtLink, Quiet } from '../shared/ui';
import { matchesProperty, pct } from './format';
import { Purchases, SectionLabel, TargetsHitLine } from './Measurement';
import { ReelMarks } from './Video';

/** "4 of 9 queries shown (44%) · 2 in the top 20, across 3 posts". */
export function targetsLine(t: TargetsRollup): string {
  return `${num(t.hit)} of ${num(t.queries)} target queries shown (${pct(t.hit_rate)}) · ${num(t.top20)} in the top 20, across ${num(t.posts)} post${t.posts === 1 ? '' : 's'}`;
}

function Queries({ queries }: { queries?: PageQuery[] }) {
  if (!queries?.length) return null;
  return (
    <ul className="flex flex-col gap-0.5 pl-2 text-ui-11" style={{ color: 'var(--color-text-secondary)' }}>
      {queries.map((q) => (
        <li key={q.query} className="flex items-baseline gap-2 tabular-nums">
          <span className="truncate" style={{ color: 'var(--color-text)' }}>
            {q.query}
          </span>
          <span style={{ color: 'var(--color-text-tertiary)' }}>
            {num(q.clicks)} clicks · {num(q.impressions)} impr. · pos {num(q.position, 1)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Entry({ post, queries }: { post: WinnerPost; queries?: PageQuery[] }) {
  return (
    <li className="flex flex-col gap-1 rounded-md p-2" style={{ background: 'var(--color-bg-secondary)' }}>
      <div className="flex items-start justify-between gap-2">
        <span className="line-clamp-2" style={{ color: 'var(--color-text)' }} title={post.excerpt ?? undefined}>
          {post.excerpt || post.post_id}
        </span>
        <Chip tone="accent" title="Winner score">
          {num(post.score, 1)}
        </Chip>
      </div>
      <span className="text-ui-10-5 tabular-nums" style={{ color: 'var(--color-text-tertiary)' }}>
        {post.url ? <ExtLink url={post.url}>{post.site_path}</ExtLink> : post.site_path}
        {post.pillar ? ` · ${post.pillar}` : ''}
        {post.distributed_at ? ` · ${shortDateTime(post.distributed_at)}` : ''}
      </span>
      <span className="flex flex-wrap items-center gap-x-2 text-ui-11 tabular-nums" style={{ color: 'var(--color-text-secondary)' }}>
        <span>{num(post.site?.impressions)} impr.</span>
        <span>pos {num(post.site?.position, 1)}</span>
        <span>{num(post.site?.clicks)} clicks</span>
        <span>{num(post.landing?.sessions)} sessions</span>
        <span className="inline-flex items-center gap-1">
          <Purchases landing={post.landing} /> purchases
        </span>
      </span>
      <TargetsHitLine post={post} />
      <Queries queries={queries} />
      {post.video_key && (
        <span className="flex items-center gap-1">
          <ReelMarks videoKey={post.video_key} />
        </span>
      )}
    </li>
  );
}

/** "day 7", or "day 1": which checkpoint the reading was taken at. Null when
 * the feed gives none. */
export function checkpointLabel(day?: number | null): string | null {
  return day == null ? null : `day ${day}`;
}

/** Does the entry carry the v1.31.3 Instagram reading? A feed written before
 * Hermes ranked Reels by reach has entries with a page score and neither key. */
export const hasReading = (p: WinnerPost) => p.reach != null || p.checkpoint_day != null;

/** A ranked Reel (v1.31.3): its Instagram reach and shares at the latest
 * checkpoint, and which checkpoint that is. No page score, no search line. */
function ReelEntry({ post }: { post: WinnerPost }) {
  const day = checkpointLabel(post.checkpoint_day);
  const early = post.checkpoint_day === 1;
  const where = [post.pillar, post.distributed_at ? shortDateTime(post.distributed_at) : null].filter(Boolean).join(' · ');
  return (
    <li className="flex flex-col gap-1 rounded-md p-2" style={{ background: 'var(--color-bg-secondary)' }} data-reel={post.post_id}>
      <div className="flex items-start justify-between gap-2">
        <span className="line-clamp-2" style={{ color: 'var(--color-text)' }} title={post.excerpt ?? undefined}>
          {post.excerpt || post.post_id}
        </span>
        <Chip tone="accent" title="Instagram reach at the latest checkpoint">
          reach {num(post.reach)}
        </Chip>
      </div>
      {(post.site_path || where) && (
        <span className="text-ui-10-5 tabular-nums" style={{ color: 'var(--color-text-tertiary)' }}>
          {post.url ? <ExtLink url={post.url}>{post.site_path}</ExtLink> : post.site_path}
          {post.site_path && where ? ' · ' : ''}
          {where}
        </span>
      )}
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-ui-11 tabular-nums" style={{ color: 'var(--color-text-secondary)' }}>
        <span>{num(post.shares)} shares</span>
        {day &&
          (early ? (
            <Chip tone="warning" title="A first-day reading: not comparable with a day-7 or day-28 one">
              day 1 reading
            </Chip>
          ) : (
            <span title="The checkpoint this reading was taken at">read at {day}</span>
          ))}
        {post.video_key && <ReelMarks videoKey={post.video_key} />}
      </span>
    </li>
  );
}

function Column({
  label,
  posts,
  property,
  empty,
  reels = false,
}: {
  label: string;
  posts: WinnerPost[];
  property: WinnersProperty;
  empty: string;
  /** Draw each post as a ranked Reel instead of a long-form post. */
  reels?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5 min-w-0">
      <SectionLabel>{label}</SectionLabel>
      {posts.length === 0 ? (
        <Quiet>{empty}</Quiet>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {posts.map((p) =>
            reels && hasReading(p) ? (
              <ReelEntry key={p.post_id} post={p} />
            ) : (
              <Entry key={p.post_id} post={p} queries={p.site_path ? property.page_queries?.[p.site_path] : undefined} />
            ),
          )}
        </ul>
      )}
    </div>
  );
}

/** "3 Reels, 2 unmeasured". */
export function reelsLine(v: VideoWinners): string {
  return `${num(v.posts)} Reel${v.posts === 1 ? '' : 's'}${v.unmeasured ? `, ${num(v.unmeasured)} unmeasured` : ''}`;
}

/** Why no Reel is ranked yet: none has an Instagram reading. */
export function reelsEmptyLine(v: VideoWinners): string {
  const n = v.unmeasured ?? 0;
  return n > 0
    ? `No Reel has an Instagram reading yet (${num(n)} unmeasured). Reels are ranked by reach, then shares.`
    : 'No Reel has an Instagram reading yet. Reels are ranked by reach, then shares.';
}

/**
 * Reels, ranked among themselves by Instagram reach, then shares (v1.31.3,
 * hq 0031 D6): a Reel never displaces a long-form post. Until one has a
 * reading the lists are empty and engagement by pillar shows meanwhile.
 */
export function ReelsList({ video, property }: { video: VideoWinners; property: WinnersProperty }) {
  const top = video.top ?? [];
  const bottom = video.bottom ?? [];
  const pillars = video.by_pillar ?? [];
  // Until the first run that ranks by reach, a listed Reel is an older,
  // page-scored entry and is drawn as it was.
  const byReach = [...top, ...bottom].some(hasReading);
  return (
    <div className="flex flex-col gap-1.5" aria-label="Reels">
      <SectionLabel>Reels</SectionLabel>
      <span className="text-ui-11-5" style={{ color: 'var(--color-text-secondary)' }}>
        {reelsLine(video)}
      </span>
      {pillars.length > 0 && (
        <ul className="flex flex-col gap-0.5 pl-2 text-ui-11-5 tabular-nums" style={{ color: 'var(--color-text-tertiary)' }}>
          {pillars.map((r, i) => (
            <li key={i}>
              {String(r.pillar ?? '—')}: {num(r.posts)} Reel{r.posts === 1 ? '' : 's'} · avg eng. {num(r.avg_engagement, 1)}
            </li>
          ))}
        </ul>
      )}
      {top.length + bottom.length > 0 ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Column label={byReach ? 'Top Reels, by reach' : 'Top Reels'} posts={top} property={property} empty="No Reel with a reading yet." reels />
          <Column label="Bottom Reels" posts={bottom} property={property} empty="Not enough Reels with a reading yet." reels />
        </div>
      ) : (
        <Quiet>{reelsEmptyLine(video)}</Quiet>
      )}
    </div>
  );
}

function PropertyWinners({ property, showProperty }: { property: WinnersProperty; showProperty: boolean }) {
  const targets = property.targets;
  const lanePages = (property.lane_pages ?? []).filter((p) => property.page_queries?.[p.site_path]?.length);
  return (
    <section className="flex flex-col gap-3" aria-label={`Winners for ${property.id}`}>
      <div className="flex flex-wrap items-center gap-2 text-ui-11-5" style={{ color: 'var(--color-text-tertiary)' }}>
        {showProperty && <Chip tone="accent">{property.id}</Chip>}
        <span>
          {num(property.long_form)} long-form post{property.long_form === 1 ? '' : 's'}
          {property.unmeasured ? `, ${num(property.unmeasured)} not measured yet` : ''}
        </span>
        {property.regime && <Chip tone="muted">{property.regime} scoring</Chip>}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Column label="Winners" posts={property.top ?? []} property={property} empty="No scored long-form posts yet." />
        <Column label="Laggards" posts={property.bottom ?? []} property={property} empty="Not enough scored posts for laggards yet." />
      </div>
      {property.video && <ReelsList video={property.video} property={property} />}
      {lanePages.length > 0 && (
        <div className="flex flex-col gap-1">
          <SectionLabel>Feed pages: top queries</SectionLabel>
          {lanePages.map((p) => (
            <div key={p.site_path} className="flex flex-col gap-0.5">
              <span className="text-ui-11-5" style={{ color: 'var(--color-text)' }}>
                {p.site_path}
              </span>
              <Queries queries={property.page_queries?.[p.site_path]} />
            </div>
          ))}
        </div>
      )}
      {targets?.all && (
        <div className="flex flex-col gap-0.5 text-ui-11-5" style={{ color: 'var(--color-text-secondary)' }}>
          <SectionLabel>Did it rank?</SectionLabel>
          <span>{targetsLine(targets.all)}</span>
          {(targets.by_pillar ?? []).map((t) => (
            <span key={String(t.pillar)} className="pl-2" style={{ color: 'var(--color-text-tertiary)' }}>
              {String(t.pillar)}: {targetsLine(t)}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

/** Weekly winners and laggards by score, with the queries that bring each page its traffic (v1.9-v1.10). */
export function WinnersPanel({
  winners,
  selectedProperty,
  showProperty,
  loading,
  error,
}: {
  winners: ContentWinners | null;
  selectedProperty: string;
  showProperty: boolean;
  loading?: boolean;
  error?: string | null;
}) {
  const properties = (winners?.properties ?? []).filter((p) => matchesProperty(selectedProperty, p.id));
  return (
    <DashboardPanel
      icon={Trophy}
      title="Winners / laggards"
      tag={winners ? `Weekly · ${num(winners.window_days ?? 28)} days` : 'Weekly'}
      size="full"
      band="short"
      dim
      loading={loading}
      error={error}
    >
      {!winners ? (
        <Quiet>Hermes ranks long-form posts weekly, on Sunday mornings; the first ranking hasn’t run yet.</Quiet>
      ) : properties.length === 0 ? (
        <Quiet>Nothing ranked for this property this week.</Quiet>
      ) : (
        <div className="flex flex-col gap-5">
          {properties.map((p) => (
            <PropertyWinners key={p.id} property={p} showProperty={showProperty} />
          ))}
        </div>
      )}
    </DashboardPanel>
  );
}
