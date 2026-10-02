import { useMemo, useState, type ReactNode } from 'react';
import { Chip, Segmented } from '../../shared/ui';
import type { SpecDrops } from '../../../lib/fixes-api';
import { NUMERIC, diffWords, droppedNumbers, htmlToText, normNum, type DiffOp } from './diff';

type Mode = 'text' | 'html';

// An unchanged stretch longer than this many words is folded to its ends.
const FOLD_WORDS = 60;
const KEEP_WORDS = 14;

const STYLE: Record<DiffOp['type'], React.CSSProperties> = {
  eq: { color: 'var(--color-text-secondary)' },
  del: {
    color: 'var(--color-error)',
    background: 'color-mix(in srgb, var(--color-error) 12%, transparent)',
    textDecoration: 'line-through',
  },
  ins: {
    color: 'var(--color-success)',
    background: 'color-mix(in srgb, var(--color-success) 14%, transparent)',
  },
};

/** Why the specs check let a figure go (0011 A4, A7), by normalized figure. */
type DropMarks = Map<string, 'finding' | 'judge'>;

export function dropMarks(drops?: SpecDrops): DropMarks {
  const marks: DropMarks = new Map();
  for (const f of drops?.finding ?? []) marks.set(normNum(f), 'finding');
  for (const f of drops?.judge ?? []) marks.set(normNum(f), 'judge');
  return marks;
}

const DROP_TITLE = {
  finding: 'Dropped because a linked finding quotes it',
  judge: 'Dropped under a judge flag: this fix is review-only',
};

/** Changed words that carry a figure get a box, so a dropped spec shows.
 * A figure dropped under a judge flag gets a dashed box and says so. */
function withFigures(text: string, type: DiffOp['type'], marks: DropMarks): ReactNode {
  if (type === 'eq' || !NUMERIC.test(text)) return text;
  return text.split(/(\s+)/).map((t, i) => {
    if (!NUMERIC.test(t)) return t;
    const why = type === 'del' ? marks.get(normNum(t)) : undefined;
    return (
      <strong
        key={i}
        className="rounded px-0.5"
        data-drop={why}
        title={why && DROP_TITLE[why]}
        style={{
          outline: `1.5px ${why === 'judge' ? 'dashed' : 'solid'} ${
            why === 'judge' ? 'var(--color-warning)' : type === 'del' ? 'var(--color-error)' : 'var(--color-success)'
          }`,
        }}
      >
        {t}
      </strong>
    );
  });
}

function Folded({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const words = text.split(/(\s+)/);
  const count = words.filter((w) => w.trim()).length;
  if (open || count <= FOLD_WORDS) return <span style={STYLE.eq}>{text}</span>;
  // words alternates word/space; keep KEEP_WORDS words at each end
  const head = words.slice(0, KEEP_WORDS * 2).join('');
  const tail = words.slice(-KEEP_WORDS * 2).join('');
  return (
    <span style={STYLE.eq}>
      {head}
      <button
        onClick={() => setOpen(true)}
        className="mx-1 px-1.5 rounded text-[10.5px] cursor-pointer"
        style={{ background: 'var(--color-bg-secondary)', border: '1px solid var(--color-border)', color: 'var(--color-text-tertiary)' }}
      >
        … {count - KEEP_WORDS * 2} unchanged words …
      </button>
      {tail}
    </span>
  );
}

/** Before vs after as one inline word diff. Text is never rendered as HTML. */
export function DiffBody({
  before,
  after,
  mode,
  drops,
}: {
  before: string;
  after: string;
  mode: Mode;
  drops?: SpecDrops;
}) {
  const marks = useMemo(() => dropMarks(drops), [drops]);
  const ops = useMemo(
    () => (mode === 'text' ? diffWords(htmlToText(before), htmlToText(after)) : diffWords(before, after)),
    [before, after, mode],
  );
  const changed = ops.some((o) => o.type !== 'eq');
  return (
    <div
      className={`text-[12.5px] leading-relaxed whitespace-pre-wrap break-words rounded-md p-2 ${mode === 'html' ? 'font-mono text-[11.5px]' : ''}`}
      style={{ background: 'var(--color-bg-secondary)', maxHeight: '28rem', overflowY: 'auto' }}
      data-diff={mode}
    >
      {!changed ? (
        <span style={{ color: 'var(--color-text-tertiary)' }}>
          {mode === 'text' ? 'No change to the visible text (markup only; see HTML source).' : 'No change.'}
        </span>
      ) : (
        ops.map((op, i) =>
          op.type === 'eq' ? (
            <Folded key={i} text={op.text} />
          ) : (
            <span key={i} style={STYLE[op.type]}>
              {withFigures(op.text, op.type, marks)}
            </span>
          ),
        )
      )}
    </div>
  );
}

/** Figures in the old visible text that the new one no longer has. */
export function DroppedFigures({ before, after }: { before: string; after: string }) {
  const dropped = useMemo(() => droppedNumbers(htmlToText(before), htmlToText(after)), [before, after]);
  if (!dropped.length) return null;
  return (
    <Chip tone="warning" title="Figures in the current copy that the new copy no longer contains">
      Drops {dropped.slice(0, 6).join(', ')}
      {dropped.length > 6 ? ` +${dropped.length - 6}` : ''}
    </Chip>
  );
}

/** One field of a patch: its rationale, figure warning, and the diff with
 * a visible-text / HTML-source toggle. */
export function FieldDiff({
  field,
  before,
  after,
  rationale,
  drops,
}: {
  field: string;
  before: string;
  after: string;
  rationale?: string;
  drops?: SpecDrops;
}) {
  const isHtml = field === 'descriptionHtml';
  const [mode, setMode] = useState<Mode>('text');
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-medium" style={{ color: 'var(--color-text-secondary)' }}>
          {field}
        </span>
        <DroppedFigures before={before} after={after} />
        {isHtml && (
          <span className="ml-auto">
            <Segmented
              ariaLabel="Diff view"
              value={mode}
              onChange={setMode}
              options={[
                { value: 'text', label: 'Text' },
                { value: 'html', label: 'HTML source' },
              ]}
            />
          </span>
        )}
      </div>
      {rationale && (
        <p className="text-[11.5px] italic" style={{ color: 'var(--color-text-tertiary)' }}>
          {rationale}
        </p>
      )}
      <DiffBody before={before} after={after} mode={isHtml ? mode : 'html'} drops={drops} />
    </div>
  );
}
