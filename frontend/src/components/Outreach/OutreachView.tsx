import { useState } from 'react';
import { CalendarCheck, Check, Copy, ExternalLink, ListChecks, Sparkles, Undo2, Users, X } from 'lucide-react';
import { DashboardPanel } from '../Dashboard/DashboardPanel';
import { FeedFreshnessLine } from '../Dashboard/FeedFreshnessLine';
import { Chip, ExtLink, Quiet, Segmented, SmallButton, Tile, type Tone } from '../shared/ui';
import { shortDateTime } from '../shared/format';
import {
  CHECK_ITEMS,
  CHECK_LABEL,
  LIMITS,
  engagedWords,
  figure,
  logWords,
  openCandidates,
  roundLine,
  rowKey,
  sortAccounts,
  verdict,
  type Account,
  type AccountEdits,
  type AddResult,
  type BrandState,
  type Candidate,
  type CheckItem,
  type IgCandidates,
  type IgReach,
  type OutreachState,
  type ReachProperty,
  type RoundRow,
  type Verdict,
} from '../../lib/outreach-api';
import { AccountDrawer } from './AccountDrawer';

/** A row's drafted angles: asked for, shown, or why not. */
export type AngleState =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; angles: string[]; screenedOut: number; used: string | null };

export interface FeedState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

export type ListTab = 'targets' | 'candidates';

export interface OutreachViewProps {
  state: OutreachState | null;
  loading?: boolean;
  error?: string | null;
  reach: FeedState<IgReach>;
  candidates: FeedState<IgCandidates>;
  selectedBrand: string | null;
  onSelectBrand: (brand: string) => void;
  now: number;
  /** `brand:handle` of rows with a write in flight. */
  busy?: Record<string, boolean>;
  angles?: Record<string, AngleState>;
  notice?: string | null;
  onClearNotice?: () => void;
  /** Hands the profile link to the operator's browser. The app opens nothing else. */
  onOpenProfile: (url: string) => void;
  onAngles: (brand: string, handle: string, about: string) => void;
  /** Copies one angle and remembers it as the one used on Done. */
  onCopyAngle: (brand: string, handle: string, angle: string) => void;
  onMark: (brand: string, handle: string, action: 'done' | 'skip' | 'undo') => void;
  onCheck: (brand: string, item: CheckItem, checked: boolean) => void;
  onAdd: (brand: string, text: string) => Promise<AddResult>;
  onEdit: (brand: string, handle: string, edits: AccountEdits) => Promise<void>;
  onCandidate: (brand: string, handle: string, action: 'accept' | 'dismiss') => void;
  openHandle?: string | null;
  onOpenAccount?: (handle: string | null) => void;
  tab?: ListTab;
  onTab?: (tab: ListTab) => void;
}

const TIER_TONE: Record<string, Tone> = { peer: 'neutral', large: 'accent', creator: 'success' };
const STATUS_TONE: Record<string, Tone> = { active: 'success', paused: 'warning', dropped: 'muted' };
const VERDICT_TONE: Record<Verdict, Tone> = { meets: 'success', short: 'warning', unread: 'muted' };
const VERDICT_WORDS: Record<Verdict, string> = { meets: 'meets the pass line', short: 'short of the pass line', unread: 'not read' };

const input = { background: 'var(--color-bg-secondary)', color: 'var(--color-text)', border: '1px solid var(--color-border)' };

// ---------- the results strip (ig_reach, §6.7) ----------

export function ReachStrip({ reach, brand }: { reach: FeedState<IgReach>; brand: string }) {
  if (!reach.data) {
    return (
      <div data-reach="none">
        <Quiet>
          {reach.loading
            ? 'Reading the weekly Instagram read…'
            : reach.error ?? 'Results: not yet. Hermes publishes the weekly Instagram read on Mondays once it is built.'}
        </Quiet>
      </div>
    );
  }
  const p: ReachProperty | undefined = reach.data.properties?.find((x) => x.id === brand);
  if (!p) {
    return (
      <div data-reach="none">
        <Quiet>Results: Hermes’s weekly read has no row for this brand yet.</Quiet>
      </div>
    );
  }
  const week = p.week ?? {};
  const line = p.pass_line ?? {};
  const base = p.baseline ?? {};
  const meets = p.meets;
  const sub = (v: Verdict | null, text: string) => (v ? `${text} · ${VERDICT_WORDS[v]}` : text);
  const reachV = meets ? verdict(meets.median_reach) : null;
  const sharesV = meets ? verdict(meets.shares_per_reel) : null;
  const followV = meets ? verdict(meets.followers) : null;
  const change = week.followers_change;
  return (
    <div className="flex flex-col gap-2" data-reach={brand}>
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-2">
        <Tile label="Reels this week" value={figure(week.reels)} sub={week.from && week.to ? `${week.from} to ${week.to}` : undefined} />
        <Tile
          label="Median reach"
          value={figure(week.median_reach)}
          sub={sub(reachV, `baseline ${figure(base.median_reach)}, pass ${figure(line.median_reach_min)}`)}
          subTone={reachV ? VERDICT_TONE[reachV] : 'muted'}
        />
        <Tile
          label="Shares per Reel"
          value={figure(week.shares_per_reel, 2)}
          sub={sub(sharesV, `baseline ${figure(base.shares_per_reel, 2)}, pass ${figure(line.shares_per_reel_min, 2)}`)}
          subTone={sharesV ? VERDICT_TONE[sharesV] : 'muted'}
        />
        <Tile
          label="Followers"
          value={figure(week.followers)}
          sub={
            week.followers == null
              ? 'counted by hand in the app'
              : sub(followV, change == null ? 'change not read' : `${change >= 0 ? '+' : ''}${figure(change)} on last week`)
          }
          subTone={followV && week.followers != null ? VERDICT_TONE[followV] : 'muted'}
        />
        <Tile label="Bio-link sessions" value={figure(week.bio_sessions)} sub={`saves ${figure(week.saves)}, comments ${figure(week.comments)}`} />
        <Tile
          label="The test"
          value={p.test ? `Day ${figure(p.test.day)} of 14` : 'Not started'}
          sub={
            p.test
              ? `read on ${p.test.read_on ?? '?'}${meets ? ` · ${meets.all ? 'passing' : meets.all === false ? 'not passing' : 'not read'}` : ''}`
              : 'starts when every post is a Reel with a hook'
          }
          subTone={p.test && meets?.all ? 'success' : 'muted'}
        />
      </div>
      {p.test?.median_reach_day7 != null && (
        <Quiet>
          Read on Reels at day 7 or later: median reach {figure(p.test.median_reach_day7)} over {figure(p.test.reels_at_day7)} Reels.
        </Quiet>
      )}
    </div>
  );
}

// ---------- today's round (C3) ----------

function AngleList({ state, onCopy }: { state: AngleState | undefined; onCopy: (angle: string) => void }) {
  if (!state) return null;
  if (state.status === 'loading') return <Quiet>Drafting on this machine…</Quiet>;
  if (state.status === 'error') {
    return (
      <p className="text-ui-11-5" style={{ color: 'var(--color-warning)' }} data-angle-error>
        {state.error}
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-1.5" data-angles>
      {state.angles.map((a) => (
        <li key={a} className="flex items-start gap-2" data-used={state.used === a ? 'yes' : undefined}>
          <SmallButton tone={state.used === a ? 'accent' : 'neutral'} onClick={() => onCopy(a)} title="Copy it; Done keeps it as the angle used">
            {state.used === a ? <Check size={11} /> : <Copy size={11} />} {state.used === a ? 'Copied' : 'Copy'}
          </SmallButton>
          <span className="text-ui-12-5" style={{ color: 'var(--color-text)' }}>
            {a}
          </span>
        </li>
      ))}
      {state.screenedOut > 0 && (
        <li>
          <Quiet>
            {state.screenedOut} drafted {state.screenedOut === 1 ? 'angle was' : 'angles were'} not shown: the brand’s compliance screen refused them.
          </Quiet>
        </li>
      )}
    </ul>
  );
}

function RoundRowView({
  brand,
  row,
  now,
  busy,
  angles,
  props,
}: {
  brand: string;
  row: RoundRow;
  now: number;
  busy: boolean;
  angles: AngleState | undefined;
  props: OutreachViewProps;
}) {
  const [about, setAbout] = useState('');
  const open = row.state === 'open';
  return (
    <li
      className="flex flex-col gap-2 rounded-lg px-3 py-2.5"
      style={{ background: 'var(--color-bg-secondary)', opacity: open ? 1 : 0.7 }}
      data-round-row={row.handle}
      data-state={row.state}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <button
            onClick={() => props.onOpenAccount?.(row.handle)}
            className="text-ui-13 font-semibold cursor-pointer hover:underline"
            style={{ background: 'transparent', border: 'none', padding: 0, color: 'var(--color-text)' }}
            title="Open the account’s details"
          >
            @{row.handle}
          </button>
          <Chip tone={TIER_TONE[row.tier] ?? 'neutral'}>{row.tier}</Chip>
          {row.collab_state !== 'none' && <Chip tone="accent">collab {row.collab_state}</Chip>}
          <span className="text-ui-11" style={{ color: 'var(--color-text-tertiary)' }}>
            {open ? `last engaged ${engagedWords(row.last_engaged_at, now)}` : row.state === 'done' ? 'done today' : 'skipped today'}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <SmallButton tone="accent" onClick={() => props.onOpenProfile(row.profile_url)} title={`Open ${row.profile_url} in your browser`}>
            <ExternalLink size={11} /> Open
          </SmallButton>
          {open ? (
            <>
              <SmallButton disabled={busy || angles?.status === 'loading'} onClick={() => props.onAngles(brand, row.handle, about)} title="Three comment angles from the local model, screened against the brand’s compliance phrases">
                <Sparkles size={11} /> {angles?.status === 'ready' ? 'New angles' : 'Angles'}
              </SmallButton>
              <span data-done={row.handle}>
                <SmallButton tone="success" disabled={busy} onClick={() => props.onMark(brand, row.handle, 'done')} title="You engaged with this account: write it to the log">
                  <Check size={11} /> Done
                </SmallButton>
              </span>
              <span data-skip={row.handle}>
                <SmallButton disabled={busy} onClick={() => props.onMark(brand, row.handle, 'skip')} title="Not today: write the skip to the log">
                  Skip
                </SmallButton>
              </span>
            </>
          ) : (
            <span data-undo={row.handle}>
              <SmallButton disabled={busy} onClick={() => props.onMark(brand, row.handle, 'undo')} title="Take today’s mark back">
                <Undo2 size={11} /> Undo
              </SmallButton>
            </span>
          )}
        </div>
      </div>
      {(row.niche || row.why) && (
        <p className="text-ui-12" style={{ color: 'var(--color-text-secondary)' }}>
          {[row.niche, row.why].filter(Boolean).join(' · ')}
        </p>
      )}
      {open && (
        <input
          aria-label={`What @${row.handle}'s post is about (optional)`}
          placeholder="What their post is about (optional, makes the angles specific)"
          value={about}
          maxLength={LIMITS.about}
          onChange={(e) => setAbout(e.target.value)}
          className="rounded-md px-2 py-1 text-ui-11-5 w-full"
          style={input}
        />
      )}
      {open && <AngleList state={angles} onCopy={(a) => props.onCopyAngle(brand, row.handle, a)} />}
      {!open && row.angle && (
        <p className="text-ui-12" style={{ color: 'var(--color-text-secondary)' }} data-angle-used>
          Angle used: “{row.angle}”
        </p>
      )}
    </li>
  );
}

export function RoundPanel({ brand, props }: { brand: BrandState; props: OutreachViewProps }) {
  const active = brand.accounts.filter((a) => a.status === 'active').length;
  return (
    <DashboardPanel icon={CalendarCheck} title="Today’s round" tag={roundLine(brand.round, active)} size="wide" priority={!brand.round.complete && brand.round.rows.length > 0}>
      {brand.round.rows.length === 0 ? (
        <Quiet>{roundLine(brand.round, active)}.</Quiet>
      ) : (
        <ul className="flex flex-col gap-2" data-round={brand.id}>
          {brand.round.rows.map((row) => {
            const key = rowKey(brand.id, row.handle);
            return <RoundRowView key={row.handle} brand={brand.id} row={row} now={props.now} busy={!!props.busy?.[key]} angles={props.angles?.[key]} props={props} />;
          })}
        </ul>
      )}
      <Quiet>
        Open goes to your browser; you comment by hand. The app never posts, likes, follows or messages.
      </Quiet>
    </DashboardPanel>
  );
}

// ---------- the daily checklist (C4) and the log ----------

export function ChecklistPanel({ brand, props }: { brand: BrandState; props: OutreachViewProps }) {
  const c = brand.checklist;
  return (
    <DashboardPanel icon={ListChecks} title="Daily checklist" tag={`${c.days_kept} ${c.days_kept === 1 ? 'day' : 'days'} kept`} size="third">
      <ul className="flex flex-col gap-2" data-checklist={brand.id}>
        {CHECK_ITEMS.map((item) => (
          <li key={item}>
            <label className="flex items-start gap-2 cursor-pointer text-ui-12-5" style={{ color: 'var(--color-text)' }}>
              <input type="checkbox" checked={c[item]} data-check={item} onChange={(e) => props.onCheck(brand.id, item, e.target.checked)} className="mt-0.5" />
              {CHECK_LABEL[item]}
            </label>
          </li>
        ))}
        <li className="flex items-start gap-2 text-ui-12-5" style={{ color: c.round_done ? 'var(--color-text)' : 'var(--color-text-secondary)' }} data-check-round={c.round_done ? 'done' : 'open'}>
          <input type="checkbox" checked={c.round_done} readOnly disabled className="mt-0.5" aria-label="The round done" />
          The round done <span style={{ color: 'var(--color-text-tertiary)' }}>(ticks itself)</span>
        </li>
      </ul>
      <Quiet>
        {c.streak > 0 ? `${c.streak} ${c.streak === 1 ? 'day' : 'days'} in a row.` : 'A day is kept when all three are done.'}
      </Quiet>
      <details data-log={brand.id}>
        <summary className="cursor-pointer text-ui-10-5 font-semibold uppercase tracking-wide" style={{ color: 'var(--color-text-tertiary)' }}>
          The log ({brand.log.length} latest)
        </summary>
        {brand.log.length === 0 ? (
          <Quiet>Nothing logged yet.</Quiet>
        ) : (
          <ul className="flex flex-col gap-1 mt-1.5">
            {brand.log.map((line, i) => (
              <li key={`${line.at}-${i}`} className="text-ui-11-5 flex gap-2">
                <span className="tabular-nums shrink-0" style={{ color: 'var(--color-text-tertiary)' }}>
                  {shortDateTime(line.at)}
                </span>
                <span style={{ color: 'var(--color-text-secondary)' }}>{logWords(line)}</span>
              </li>
            ))}
          </ul>
        )}
      </details>
    </DashboardPanel>
  );
}

// ---------- the target list (C1), adding (C2) and candidates ----------

export function AddAccounts({ brand, onAdd }: { brand: string; onAdd: OutreachViewProps['onAdd'] }) {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<AddResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    setSaving(true);
    setError(null);
    try {
      const r = await onAdd(brand, text);
      setResult(r);
      if (r.added.length && !r.invalid.length) setText('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Not added');
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="flex flex-col gap-1.5" data-add={brand}>
      <textarea
        aria-label="Handles or profile links to add"
        placeholder="Paste handles or profile links, one or many (@name, name, https://www.instagram.com/name/)"
        value={text}
        rows={2}
        onChange={(e) => setText(e.target.value)}
        className="rounded-md px-2 py-1.5 resize-y text-ui-12"
        style={input}
      />
      <div className="flex flex-wrap items-center gap-2">
        <SmallButton tone="accent" disabled={saving || !text.trim()} onClick={() => void add()}>
          <Users size={11} /> {saving ? 'Adding…' : 'Add to the list'}
        </SmallButton>
        {result && <AddSummary result={result} />}
        {error && (
          <span className="text-ui-11-5" style={{ color: 'var(--color-error)' }}>
            {error}
          </span>
        )}
      </div>
    </div>
  );
}

export function AddSummary({ result }: { result: AddResult }) {
  const parts = [
    result.added.length ? `${result.added.length} added` : null,
    result.duplicates.length ? `already on the list: ${result.duplicates.map((h) => `@${h}`).join(', ')}` : null,
    result.invalid.length ? `not a handle: ${result.invalid.join(', ')}` : null,
  ].filter(Boolean);
  return (
    <span className="text-ui-11-5" style={{ color: result.duplicates.length || result.invalid.length ? 'var(--color-warning)' : 'var(--color-text-secondary)' }} data-add-result>
      {parts.length ? parts.join(' · ') : 'Nothing to add'}
    </span>
  );
}

function TargetTable({ accounts, now, onOpen }: { accounts: Account[]; now: number; onOpen: (handle: string) => void }) {
  if (!accounts.length) return <Quiet>No accounts yet. Paste a few above to start the list.</Quiet>;
  const head = 'text-left font-medium px-2 py-1.5 text-ui-10-5 uppercase tracking-wide';
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-ui-12" data-targets>
        <thead>
          <tr style={{ color: 'var(--color-text-tertiary)' }}>
            {['Account', 'Tier', 'Niche', 'Why', 'Status', 'Last engaged', 'Collab', 'Source'].map((h) => (
              <th key={h} className={head}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sortAccounts(accounts).map((a) => (
            <tr
              key={a.handle}
              onClick={() => onOpen(a.handle)}
              className="cursor-pointer"
              style={{ borderTop: '1px solid var(--color-border)', color: 'var(--color-text-secondary)', opacity: a.status === 'active' ? 1 : 0.65 }}
              data-account={a.handle}
            >
              <td className="px-2 py-1.5 font-medium whitespace-nowrap" style={{ color: 'var(--color-text)' }}>
                @{a.handle}
              </td>
              <td className="px-2 py-1.5">
                <Chip tone={TIER_TONE[a.tier] ?? 'neutral'}>{a.tier}</Chip>
              </td>
              <td className="px-2 py-1.5">{a.niche}</td>
              <td className="px-2 py-1.5 max-w-[28rem] truncate" title={a.why}>
                {a.why}
              </td>
              <td className="px-2 py-1.5">
                <Chip tone={STATUS_TONE[a.status] ?? 'neutral'}>{a.status}</Chip>
              </td>
              <td className="px-2 py-1.5 whitespace-nowrap">{engagedWords(a.last_engaged_at, now)}</td>
              <td className="px-2 py-1.5">{a.collab_state === 'none' ? '' : <Chip tone="accent">{a.collab_state}</Chip>}</td>
              <td className="px-2 py-1.5">{a.source}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CandidateList({
  feed,
  brand,
  busy,
  onCandidate,
}: {
  feed: FeedState<IgCandidates>;
  brand: BrandState;
  busy?: Record<string, boolean>;
  onCandidate: OutreachViewProps['onCandidate'];
}) {
  if (!feed.data) {
    return (
      <div data-candidates="none">
        <Quiet>{feed.loading ? 'Reading Hermes’s candidates…' : feed.error ?? 'Candidates: not yet. Hermes proposes accounts weekly once that run is built.'}</Quiet>
      </div>
    );
  }
  const rows: Candidate[] = openCandidates(feed.data, brand);
  if (!rows.length) return <Quiet>No new candidates this week.</Quiet>;
  return (
    <ul className="flex flex-col gap-2" data-candidates={brand.id}>
      {rows.map((c) => {
        const handle = c.handle.toLowerCase().replace(/^@/, '');
        const waiting = !!busy?.[rowKey(brand.id, handle)];
        return (
          <li key={handle} className="flex flex-wrap items-start justify-between gap-2 rounded-lg px-3 py-2" style={{ background: 'var(--color-bg-secondary)' }} data-candidate={handle}>
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="text-ui-12-5 font-semibold" style={{ color: 'var(--color-text)' }}>
                @{handle}
              </span>
              {c.why && <span className="text-ui-12">{c.why}</span>}
              {c.found_on && (
                <span className="text-ui-11" style={{ color: 'var(--color-text-tertiary)' }}>
                  found on <ExtLink url={c.found_on}>{c.found_on}</ExtLink>
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <SmallButton tone="accent" disabled={waiting} onClick={() => onCandidate(brand.id, handle, 'accept')} title="Add it to the list">
                <Check size={11} /> Accept
              </SmallButton>
              <SmallButton disabled={waiting} onClick={() => onCandidate(brand.id, handle, 'dismiss')} title="Hermes will not offer it again">
                <X size={11} /> Dismiss
              </SmallButton>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function ListPanel({ brand, props }: { brand: BrandState; props: OutreachViewProps }) {
  const [localTab, setLocalTab] = useState<ListTab>('targets');
  const tab = props.tab ?? localTab;
  const setTab = props.onTab ?? setLocalTab;
  const waiting = openCandidates(props.candidates.data, brand).length;
  const active = brand.accounts.filter((a) => a.status === 'active').length;
  return (
    <DashboardPanel
      icon={Users}
      title="Target accounts"
      tag={`${active} active of ${brand.accounts.length}`}
      size="full"
      headerExtra={
        <Segmented
          ariaLabel="Target list"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'targets', label: `Targets (${brand.accounts.length})` },
            { value: 'candidates', label: `Candidates${waiting ? ` (${waiting})` : ''}`, title: 'Accounts Hermes found on the open web' },
          ]}
        />
      }
    >
      {tab === 'targets' ? (
        <>
          <AddAccounts brand={brand.id} onAdd={props.onAdd} />
          <TargetTable accounts={brand.accounts} now={props.now} onOpen={(h) => props.onOpenAccount?.(h)} />
        </>
      ) : (
        <CandidateList feed={props.candidates} brand={brand} busy={props.busy} onCandidate={props.onCandidate} />
      )}
    </DashboardPanel>
  );
}

// ---------- the page ----------

/**
 * The Outreach page (hq 0031 Part C). The header carries the brand switch and
 * Hermes's weekly read as the results strip. Row 1, the act band: today's round
 * (wide) and the daily checklist with the log (third). Row 2, the work: the
 * target list with its paste box, and Hermes's candidates on the second tab.
 * An account's details open in the drawer. Pure: everything comes in through
 * props (see OutreachPage).
 */
export function OutreachView(props: OutreachViewProps) {
  const { state } = props;
  const brands = state?.brands ?? [];
  const brandId = props.selectedBrand && brands.some((b) => b.id === props.selectedBrand) ? props.selectedBrand : brands[0]?.id ?? null;
  const brand = brands.find((b) => b.id === brandId);
  const open = brand && props.openHandle ? brand.accounts.find((a) => a.handle === props.openHandle) : undefined;

  return (
    <div>
      <header className="flex flex-col gap-3 mb-6">
        <div>
          <h1 className="text-lg font-semibold" style={{ color: 'var(--color-text)' }}>
            Outreach
          </h1>
          <p className="text-sm mt-1" style={{ color: 'var(--color-text-secondary)' }}>
            Who to visit on Instagram today, something to say, and a record of what you did. You do the visiting; the app keeps the list.
          </p>
        </div>
        {brands.length > 1 && (
          <div>
          <Segmented
            ariaLabel="Brand"
            value={brandId ?? ''}
            onChange={props.onSelectBrand}
            options={brands.map((b) => ({
              value: b.id,
              label: (
                <span data-brand-tab={b.id}>
                  {b.id}
                  {b.round.open > 0 ? ` · ${b.round.open} left` : b.round.complete ? ' · done' : ''}
                </span>
              ),
            }))}
          />
          </div>
        )}
        {brands.length === 1 && (
          <div className="text-ui-12 font-medium" style={{ color: 'var(--color-text-secondary)' }}>
            {brands[0].id}
          </div>
        )}
        {brandId && <ReachStrip reach={props.reach} brand={brandId} />}
        <FeedFreshnessLine
          feeds={[
            { label: 'Weekly read', ageSeconds: props.reach.data?.age_seconds, stale: props.reach.data?.stale, staleAfterSeconds: 8 * 24 * 3600 },
            { label: 'Candidates', ageSeconds: props.candidates.data?.age_seconds, stale: props.candidates.data?.stale, staleAfterSeconds: 8 * 24 * 3600 },
          ]}
        />
      </header>

      {props.notice && (
        <div className="flex items-center justify-between gap-2 rounded-lg px-3 py-2 mb-4 text-ui-12" style={{ border: '1px solid var(--color-warning)', color: 'var(--color-text-secondary)' }} role="status">
          <span>{props.notice}</span>
          {props.onClearNotice && (
            <button onClick={props.onClearNotice} aria-label="Dismiss" className="cursor-pointer" style={{ background: 'transparent', border: 'none', color: 'inherit' }}>
              <X size={12} />
            </button>
          )}
        </div>
      )}

      {!state ? (
        <Quiet>{props.error ?? (props.loading ? 'Loading the outreach list…' : 'The outreach list is unavailable.')}</Quiet>
      ) : !state.configured || !brand ? (
        <div data-unconfigured>
          <Quiet>
            Outreach is not set up on this machine yet: the workspace data folder and the brand list (OUTREACH_BRANDS) go in the local config’s [desks] section.
          </Quiet>
        </div>
      ) : (
        <>
          {props.error && (
            <p className="text-ui-12 mb-3" style={{ color: 'var(--color-warning)' }}>
              {props.error} Showing the last copy.
            </p>
          )}
          <div className="grid grid-cols-12 gap-4 mb-4">
            <RoundPanel brand={brand} props={props} />
            <ChecklistPanel brand={brand} props={props} />
          </div>
          <div className="grid grid-cols-12 gap-4">
            <ListPanel brand={brand} props={props} />
          </div>
          {open && (
            <AccountDrawer
              key={open.handle}
              account={open}
              now={props.now}
              onClose={() => props.onOpenAccount?.(null)}
              onOpenProfile={props.onOpenProfile}
              onSave={(edits) => props.onEdit(brand.id, open.handle, edits)}
            />
          )}
        </>
      )}
    </div>
  );
}
