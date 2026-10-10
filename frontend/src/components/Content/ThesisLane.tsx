import { ListOrdered } from 'lucide-react';
import type { SeedbankProperty, ThesisFlag, ThesisLane as Lane, ThesisPost, ThesisQueueItem } from '../../lib/content-api';
import { DashboardPanel } from '../Dashboard/DashboardPanel';
import { num } from '../shared/format';
import { Chip, Quiet, type Tone } from '../shared/ui';
import { humanize } from './format';

/** Queue in `lane_position` order; items without a position keep feed order, last. */
export function laneQueue(items: ThesisQueueItem[]): ThesisQueueItem[] {
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => (a.item.lane_position ?? Infinity) - (b.item.lane_position ?? Infinity) || a.i - b.i)
    .map(({ item }) => item);
}

/** Groups by `template_id` in order of first appearance, lane order inside each; null is its own group. */
export function queueGroups(items: ThesisQueueItem[]): { template: string | null; items: ThesisQueueItem[] }[] {
  const groups: { template: string | null; items: ThesisQueueItem[] }[] = [];
  for (const item of laneQueue(items)) {
    const template = item.template_id || null;
    const group = groups.find((g) => g.template === template);
    if (group) group.items.push(item);
    else groups.push({ template, items: [item] });
  }
  return groups;
}

/** An estimate, never a date: fire-now bypasses the schedule. */
export function weeksOut(n: number | null | undefined): string | null {
  if (n == null) return null;
  return n <= 1 ? 'about 1 week out' : `about ${num(n)} weeks out`;
}

const day = (iso?: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

const FLAG_TONE: Record<string, Tone> = { warn: 'warning', info: 'neutral' };

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span>
      <span style={{ color: 'var(--color-text-tertiary)' }}>{label} </span>
      <span className="tabular-nums" style={{ color: 'var(--color-text)' }}>
        {value}
      </span>
    </span>
  );
}

const count = (n: number | null | undefined) => (n == null ? 'unknown' : num(n));

function runwayText(lane: Lane): string {
  if (lane.runway_days == null) return 'unknown';
  const days = `${num(lane.runway_days, 1)} days`;
  return lane.cadence_per_week == null ? days : `${days} at ${num(lane.cadence_per_week, 1)} a week`;
}

/** A highlighted row's left border; the rest stay on the panel's quiet background. */
const rowStyle = (repeat: boolean) => ({
  background: 'var(--color-bg-secondary)',
  borderLeft: `3px solid ${repeat ? 'var(--color-warning)' : 'transparent'}`,
});

function QueueRow({ item, repeat }: { item: ThesisQueueItem; repeat: boolean }) {
  const est = weeksOut(item.est_weeks_out);
  return (
    <li className="flex gap-2 rounded-lg px-2.5 py-2" style={rowStyle(repeat)} data-thesis-queue={item.signal_id ?? ''} data-repeat={repeat || undefined}>
      <span className="tabular-nums text-[11px] w-5 shrink-0 pt-px" style={{ color: 'var(--color-text-tertiary)' }}>
        {item.lane_position ?? '·'}
      </span>
      <div className="flex flex-col gap-1 min-w-0">
        <span style={{ color: 'var(--color-text)' }}>{item.title || item.summary || 'Untitled'}</span>
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
          {item.pillar_hint && <Chip>{humanize(item.pillar_hint)}</Chip>}
          {item.product_handle && <span>{item.product_handle}</span>}
          {est && <span title="Estimate from lane position and cadence; firing now skips the schedule">{est}</span>}
          {repeat && <Chip tone="warning">possible repeat</Chip>}
        </div>
      </div>
    </li>
  );
}

function PostRow({ post, repeat }: { post: ThesisPost; repeat: boolean }) {
  return (
    <li className="flex flex-col gap-1 rounded-lg px-2.5 py-2" style={rowStyle(repeat)} data-thesis-post={post.post_id ?? ''} data-repeat={repeat || undefined}>
      <span className={post.title ? '' : 'line-clamp-2'} style={{ color: post.title ? 'var(--color-text)' : 'var(--color-text-secondary)' }}>
        {post.title || post.excerpt || 'Untitled'}
      </span>
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
        {post.pillar && <Chip>{humanize(post.pillar)}</Chip>}
        <span>{day(post.distributed_at)}</span>
        {repeat && <Chip tone="warning">possible repeat</Chip>}
      </div>
    </li>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--color-text-secondary)' }}>
      {children}
    </span>
  );
}

function LanePanel({ propertyId, lane, showProperty }: { propertyId: string; lane: Lane; showProperty: boolean }) {
  const flags: ThesisFlag[] = lane.flags ?? [];
  const repeats = flags.filter((f) => f.kind === 'possible_repeat');
  const repeatSignals = new Set(repeats.map((f) => f.signal_id).filter(Boolean));
  const repeatPosts = new Set(repeats.map((f) => f.post_id).filter(Boolean));
  const groups = queueGroups(lane.queue ?? []);
  const grouped = groups.some((g) => g.template != null);
  const posts = lane.posts ?? [];
  const next = lane.next_up;

  return (
    <DashboardPanel icon={ListOrdered} title="Thesis lane" tag={showProperty ? propertyId : undefined} size="full">
      <div className="flex flex-col gap-3" data-thesis-lane={propertyId}>
        <p className="text-[11.5px]" style={{ color: 'var(--color-text-tertiary)' }}>
          Read-only: you queue theses; G1 approves them on Telegram.
        </p>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[12px]">
          <Stat label="Runway" value={runwayText(lane)} />
          <Stat label="Queued" value={count(lane.queued)} />
          <Stat label="In flight" value={count(lane.in_flight)} />
          <Stat label="G1 waiting (all lanes):" value={count(lane.approvals_pending)} />
        </div>
        {flags.length > 0 && (
          <ul className="flex flex-col gap-1">
            {flags.map((f, i) => (
              <li key={i} className="flex items-center gap-1.5 text-[11.5px]" data-flag={f.kind}>
                <Chip tone={FLAG_TONE[f.severity] ?? 'neutral'}>{humanize(f.kind)}</Chip>
                <span>{f.message}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="text-[12px]">
          <span style={{ color: 'var(--color-text-tertiary)' }}>Next up: </span>
          <span style={{ color: 'var(--color-text)' }}>{next ? next.title || next.summary || 'Untitled' : 'nothing queued'}</span>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          <div className="flex flex-col gap-2 lg:col-span-7 min-w-0" data-section="queue">
            <SectionLabel>Queue</SectionLabel>
            {groups.length === 0 ? (
              <Quiet>Nothing queued</Quiet>
            ) : (
              groups.map((g, gi) => (
                <div key={g.template ?? `none-${gi}`} className="flex flex-col gap-1.5" data-template={g.template ?? ''}>
                  {grouped && (
                    <span className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
                      {g.template ?? 'No template'}
                    </span>
                  )}
                  <ul className="flex flex-col gap-1.5">
                    {g.items.map((item, i) => (
                      <QueueRow key={item.signal_id ?? i} item={item} repeat={!!item.signal_id && repeatSignals.has(item.signal_id)} />
                    ))}
                  </ul>
                </div>
              ))
            )}
          </div>
          <div className="flex flex-col gap-2 lg:col-span-5 min-w-0" data-section="posts">
            <SectionLabel>{`Posted (90 days) · ${posts.length}`}</SectionLabel>
            {posts.length === 0 ? (
              <Quiet>No thesis posts in the last 90 days.</Quiet>
            ) : (
              <ul className="flex flex-col gap-1.5 max-h-[60vh] overflow-y-auto pr-1">
                {posts.map((p, i) => (
                  <PostRow key={p.post_id ?? i} post={p} repeat={!!p.post_id && repeatPosts.has(p.post_id)} />
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </DashboardPanel>
  );
}

/**
 * The operator-only thesis lane (contract v1.8), one panel per property
 * whose `thesis_lane` is set. A mirror: no queue, approve or fire control.
 */
export function ThesisLane({ properties, showProperty }: { properties: SeedbankProperty[]; showProperty: boolean }) {
  const lanes = properties.filter((p) => p.thesis_lane != null);
  if (lanes.length === 0) return null;
  return (
    <>
      {lanes.map((p) => (
        <LanePanel key={p.id} propertyId={p.id} lane={p.thesis_lane as Lane} showProperty={showProperty} />
      ))}
    </>
  );
}
