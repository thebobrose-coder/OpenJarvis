/**
 * Word-level diffs for the Fixes tab. The store's HTML is untrusted (the app
 * has shell tools in its process), so it is never rendered: `htmlToText`
 * turns it into plain text with string operations only (no DOM), and the
 * result is shown as React text, which escapes it.
 */

const DROP_WITH_CONTENT = /<(script|style|template|noscript|iframe|object|svg|head|title)\b[\s\S]*?<\/\1\s*>/gi;
const BLOCK = /<\/?(p|div|section|article|header|footer|h[1-6]|ul|ol|table|thead|tbody|tr|blockquote|pre|br|hr)\b[^>]*>/gi;

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
  deg: '°',
  trade: '™',
  reg: '®',
  copy: '©',
  times: '×',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
  micro: 'µ',
  plusmn: '±',
  bull: '•',
  middot: '·',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** The visible text of an HTML fragment, one line per block. */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(DROP_WITH_CONTENT, '')
    // an unterminated script/style hides the rest of the fragment
    .replace(/<(script|style)\b[\s\S]*$/i, '')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(BLOCK, '\n')
    .replace(/<\/?[a-z!][^>]*>?/gi, ' ');
  return decodeEntities(text)
    .replace(/[ \t\r\f\v ]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter((l, i, all) => l || (i > 0 && all[i - 1]))
    .join('\n')
    .trim();
}

export type DiffOp = { type: 'eq' | 'del' | 'ins'; text: string };

// Words (with inner separators, so "1,000" and "98-99" stay whole),
// whitespace runs, and single punctuation marks.
const TOKEN = /[\p{L}\p{N}]+(?:[.,'’\-/][\p{L}\p{N}]+)*|\s+|[^\s\p{L}\p{N}]/gu;
const tokenize = (s: string) => s.match(TOKEN) ?? [];
// Matching a word counts more than matching a space or a comma, so the
// diff anchors on shared words rather than shared whitespace.
const weight = (t: string) => (/[\p{L}\p{N}]/u.test(t) ? 3 : 1);

// Above this many pairs a stretch is shown as one replacement rather than
// spending seconds on the table.
const MAX_CELLS = 4_000_000;

// Sentences, lines and tags: the coarse units matched before words.
const SEGMENT = /[^.!?\n>]*(?:[.!?]+\s*|\n+|>|$)/g;
const segment = (s: string) => (s.match(SEGMENT) ?? []).filter(Boolean);

function push(ops: DiffOp[], type: DiffOp['type'], text: string) {
  if (!text) return;
  const last = ops[ops.length - 1];
  if (last && last.type === type) last.text += text;
  else ops.push({ type, text });
}

/** Weighted LCS of two unit lists. Matched units go out as "eq"; each run of
 * unmatched units is handed to `gap` (or written as del + ins). */
function lcsDiff(
  a: string[],
  b: string[],
  weightOf: (t: string) => number,
  ops: DiffOp[],
  gap?: (delText: string, insText: string) => void,
) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  push(ops, 'eq', a.slice(0, start).join(''));

  let del = '';
  let ins = '';
  const flush = () => {
    if (!del && !ins) return;
    if (gap && del && ins) gap(del, ins);
    else {
      push(ops, 'del', del);
      push(ops, 'ins', ins);
    }
    del = '';
    ins = '';
  };

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  if (n * m > MAX_CELLS) {
    del = midA.join('');
    ins = midB.join('');
    if (gap) {
      push(ops, 'del', del);
      push(ops, 'ins', ins);
      del = ins = '';
    }
  } else if (n || m) {
    // lcs[i][j] = best weight matching midA[i..] with midB[j..], flattened.
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] =
          midA[i] === midB[j]
            ? lcs[(i + 1) * w + j + 1] + weightOf(midA[i])
            : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j] && lcs[i * w + j] === lcs[(i + 1) * w + j + 1] + weightOf(midA[i])) {
        flush();
        push(ops, 'eq', midA[i]);
        i++;
        j++;
      } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) {
        del += midA[i++];
      } else {
        ins += midB[j++];
      }
    }
    while (i < n) del += midA[i++];
    while (j < m) ins += midB[j++];
  }
  flush();
  push(ops, 'eq', a.slice(endA).join(''));
}

/** A word-level diff. Sentences (or tags, in HTML source) are matched
 * first, then words inside each changed stretch, so a long description
 * with a few edits far apart still diffs quickly and precisely. */
export function diffWords(before: string, after: string): DiffOp[] {
  const ops: DiffOp[] = [];
  lcsDiff(segment(before), segment(after), () => 1, ops, (del, ins) =>
    lcsDiff(tokenize(del), tokenize(ins), weight, ops),
  );
  return absorbWhitespace(ops);
}

/** Merge each run of changes (with only whitespace between them) into one
 * deletion followed by one insertion, so a rewritten phrase reads as a
 * phrase rather than word/space/word. */
function absorbWhitespace(ops: DiffOp[]): DiffOp[] {
  const out: DiffOp[] = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k].type === 'eq') {
      out.push(ops[k++]);
      continue;
    }
    let del = '';
    let ins = '';
    while (k < ops.length) {
      const op = ops[k];
      if (op.type === 'del') del += op.text;
      else if (op.type === 'ins') ins += op.text;
      else if (/^\s+$/.test(op.text) && ops[k + 1] && ops[k + 1].type !== 'eq') {
        del += op.text;
        ins += op.text;
      } else break;
      k++;
    }
    if (del) out.push({ type: 'del', text: del });
    if (ins) out.push({ type: 'ins', text: ins });
  }
  return out;
}

/** A token carrying a figure: a digit, possibly with a unit or separators. */
export const NUMERIC = /\d/;

const normNum = (t: string) => t.replace(/^[^\w]+|[^\w%°″"]+$/g, '').replace(/(\d),(?=\d{3}\b)/g, '$1').toLowerCase();

/** Figures in `before` that appear nowhere in `after` -- a dropped spec is
 * the main way a rewrite goes wrong, so these are called out. */
export function droppedNumbers(before: string, after: string): string[] {
  const afterSet = new Set(tokenize(after).filter((t) => NUMERIC.test(t)).map(normNum));
  const out: string[] = [];
  for (const t of tokenize(before)) {
    if (!NUMERIC.test(t)) continue;
    const n = normNum(t);
    if (n && !afterSet.has(n) && !out.includes(n)) out.push(n);
  }
  return out;
}
