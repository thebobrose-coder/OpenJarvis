import { Pause, Play } from 'lucide-react';
import type { BreakingNewsAlert } from '../../lib/api';
import { alertAge, alertKind, LEVEL_COLOR, levelTone } from '../../lib/breaking-list';
import { FeedFreshness } from '../Dashboard/FeedFreshness';

function AlertMeta({ alert, now }: { alert: BreakingNewsAlert; now: number }) {
  const tone = levelTone(alert.level);
  return (
    <div className="flex items-center gap-1 text-[9px] min-w-0" style={{ color: 'var(--color-text-tertiary)' }}>
      <span
        className="px-1 rounded font-semibold uppercase tracking-wide shrink-0"
        style={{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text-secondary)' }}
      >
        {alertKind(alert)}
      </span>
      {alert.level && (
        <span className="font-semibold shrink-0" style={{ color: LEVEL_COLOR[tone] }}>
          {alert.level}
        </span>
      )}
      <span className="truncate">
        {alert.source ? `${alert.source} · ` : ''}
        {alertAge(alert.alerted_at, now)}
      </span>
    </div>
  );
}

function Headline({ alert, onOpen }: { alert: BreakingNewsAlert; onOpen: (url: string) => void }) {
  return (
    <button
      onClick={() => onOpen(alert.url)}
      className="text-left text-xs cursor-pointer hover:underline line-clamp-2"
      style={{ background: 'transparent', border: 'none', padding: 0, color: 'var(--color-text)' }}
      title={alert.headline}
    >
      {alert.headline}
    </button>
  );
}

/** The breaking section: pure, so it renders in tests without a DOM. */
export function BreakingListView({
  rows,
  latestAt,
  canPlay,
  playing,
  stale,
  now,
  onToggle,
  onOpen,
}: {
  /** From selectBreaking: newest first, already windowed and capped. */
  rows: BreakingNewsAlert[];
  /** alerted_at of the spoken alert: only that row gets the player. */
  latestAt: string | null;
  canPlay: boolean;
  playing: boolean;
  stale: boolean;
  now: number;
  onToggle: () => void;
  onOpen: (url: string) => void;
}) {
  const [lead, ...more] = rows;
  const showPlay = !!lead && lead.alerted_at === latestAt && canPlay;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-start gap-2">
        {showPlay && (
          <button
            onClick={onToggle}
            className="flex items-center justify-center w-5 h-5 rounded-full shrink-0 cursor-pointer mt-0.5"
            style={{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text-secondary)' }}
            title={playing ? 'Pause breaking news summary' : 'Play breaking news summary'}
          >
            {playing ? <Pause size={10} /> : <Play size={10} />}
          </button>
        )}
        <div className="min-w-0 flex-1">
          <div
            className="text-[9px] font-semibold uppercase tracking-wide mb-0.5"
            style={{ color: lead ? 'var(--color-accent)' : 'var(--color-text-tertiary)' }}
          >
            Breaking
          </div>
          {lead ? (
            <>
              <Headline alert={lead} onOpen={onOpen} />
              <AlertMeta alert={lead} now={now} />
            </>
          ) : (
            <span className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
              No current breaking news
            </span>
          )}
          {lead?.tickers && lead.tickers.length > 0 ? (
            <div className="flex flex-wrap gap-1 mt-1">
              {lead.tickers.map((t) => (
                <span
                  key={t}
                  className="text-[9px] px-1.5 py-0.5 rounded font-semibold"
                  style={{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text-secondary)' }}
                >
                  {t}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      {more.map((a) => (
        <div key={`${a.event_id ?? ''}${a.alerted_at}`} className={`min-w-0 ${showPlay ? 'pl-7' : ''}`}>
          <Headline alert={a} onOpen={onOpen} />
          <AlertMeta alert={a} now={now} />
        </div>
      ))}
      {stale && lead && (
        <FeedFreshness ageSeconds={Math.max(0, (now - Date.parse(lead.alerted_at)) / 1000)} stale />
      )}
    </div>
  );
}
