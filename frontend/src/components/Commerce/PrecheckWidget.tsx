import { useState } from 'react';
import { Loader2, MessagesSquare, ScanSearch } from 'lucide-react';
import { PRECHECK_MAX, type PrecheckHit, type PrecheckResult } from '../../lib/desks-api';
import { Chip, Quiet, Select, SmallButton } from '../shared/ui';

/** The pre-check's kinds in words (Foundry's Result lists them); an unknown
 * kind shows by its own name. */
export const KIND_WORDS: Record<string, string> = {
  'prohibited-phrase': 'prohibited phrase',
  guard: 'guard',
  'banned-word': 'banned word',
  ticker: 'ticker',
  'sales-line': 'sales line',
  product: 'product',
  'web-address': 'web address',
  'store-mechanics': 'store mechanics',
  judge: 'judge',
  'judge-error': 'judge error',
};

/** The sentence with the matched text marked (the first match, any case). */
export function Highlighted({ sentence, match }: { sentence: string; match?: string }) {
  const at = match ? sentence.toLowerCase().indexOf(match.toLowerCase()) : -1;
  if (!match || at < 0) return <>{sentence}</>;
  return (
    <>
      {sentence.slice(0, at)}
      <mark data-match style={{ background: 'color-mix(in srgb, var(--color-warning) 35%, transparent)', color: 'inherit' }}>
        {sentence.slice(at, at + match.length)}
      </mark>
      {sentence.slice(at + match.length)}
    </>
  );
}

/** The hits grouped by kind, each with its rule verbatim. Pure. */
export function PrecheckResultView({ result }: { result: PrecheckResult }) {
  if (result.unavailable || (result.error && !result.hits.length)) {
    return (
      <p data-precheck-error className="text-[12px]" style={{ color: 'var(--color-error)' }}>
        {result.error ?? 'pre-check unavailable'}
        {result.unavailable && ' Not a pass: nothing was checked.'}
      </p>
    );
  }
  if (result.ok) {
    return (
      <p data-precheck-ok className="text-[12px]" style={{ color: 'var(--color-success)' }}>
        No hits{result.judged ? ', judge included' : ' (deterministic checks; the judge adds compliance.md)'}.
      </p>
    );
  }
  const groups = new Map<string, PrecheckHit[]>();
  for (const h of result.hits) groups.set(h.kind, [...(groups.get(h.kind) ?? []), h]);
  return (
    <div className="flex flex-col gap-2" data-precheck-hits>
      <span className="text-[12px]" style={{ color: 'var(--color-text)' }}>
        {result.hits.length} hit{result.hits.length === 1 ? '' : 's'}
        {result.judged ? ', judge included' : ''}
      </span>
      {[...groups].map(([kind, hits]) => (
        <section key={kind} className="flex flex-col gap-1" data-kind={kind}>
          <div>
            <Chip tone={kind === 'judge-error' ? 'error' : 'warning'}>
              {KIND_WORDS[kind] ?? kind} · {hits.length}
            </Chip>
          </div>
          <ul className="flex flex-col gap-1.5 pl-1">
            {hits.map((h, i) => (
              <li key={i} className="flex flex-col gap-0.5 text-[12px]">
                <span style={{ color: 'var(--color-text)' }}>
                  “<Highlighted sentence={h.sentence} match={h.match} />”
                </span>
                <span className="text-[11.5px]" data-rule style={{ color: 'var(--color-text-tertiary)' }}>
                  {h.rule}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export interface PrecheckProps {
  /** The property ids from Foundry's bundle. */
  properties: string[];
  /** The one pre-check backend (the Compliance desk's tool uses it too). */
  onCheck: (propertyId: string, text: string, judge: boolean) => Promise<PrecheckResult>;
  /** Open a Compliance desk thread with the pasted text and its hits. */
  onAskDesk?: (propertyId: string, text: string, result: PrecheckResult | null) => void;
}

/**
 * Paste-and-check (0020 P3): a property, a text, "check" (deterministic, a
 * few seconds) or "check with judge" (qwen against compliance.md, up to three
 * minutes). It checks and shows; it never dismisses or approves anything.
 */
export function PrecheckWidget({ properties, onCheck, onAskDesk }: PrecheckProps) {
  const [property, setProperty] = useState(properties[0] ?? '');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<'check' | 'judge' | null>(null);
  const [result, setResult] = useState<PrecheckResult | null>(null);
  const chosen = property || properties[0] || '';
  const tooLong = text.length > PRECHECK_MAX;
  const canCheck = !!chosen && text.trim().length > 0 && !tooLong && busy === null;

  const run = async (judge: boolean) => {
    setBusy(judge ? 'judge' : 'check');
    setResult(null);
    try {
      setResult(await onCheck(chosen, text, judge));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      data-precheck
      className="flex flex-col gap-2 rounded-lg p-3 mb-3"
      style={{ background: 'var(--color-bg-secondary)', border: '1px solid var(--color-border-subtle, var(--color-border))' }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1.5 text-[12.5px] font-medium" style={{ color: 'var(--color-text)' }}>
          <ScanSearch size={13} /> Paste and check
        </span>
        {properties.length > 0 && (
          <Select
            label="Property"
            value={chosen}
            options={properties.map((p) => ({ value: p, label: p }))}
            onChange={setProperty}
          />
        )}
      </div>
      {properties.length === 0 ? (
        <Quiet>Foundry’s bundle isn’t readable here, so there’s no property to check against.</Quiet>
      ) : (
        <>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Paste copy to check against this property’s rules…"
            rows={4}
            className="w-full rounded-md p-2 text-[12.5px] resize-y"
            style={{ background: 'var(--color-surface)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
          />
          <div className="flex flex-wrap items-center gap-2">
            <SmallButton tone="accent" onClick={() => void run(false)} disabled={!canCheck} title="The deterministic checks: a few seconds">
              {busy === 'check' ? <Loader2 size={11} className="animate-spin" /> : null} Check
            </SmallButton>
            <SmallButton onClick={() => void run(true)} disabled={!canCheck} title="Adds qwen's judgment against compliance.md: up to 3 minutes">
              {busy === 'judge' ? <Loader2 size={11} className="animate-spin" /> : null} Check with judge
            </SmallButton>
            {onAskDesk && (
              <SmallButton
                onClick={() => onAskDesk(chosen, text, result)}
                disabled={!text.trim() || busy !== null}
                title="Open a Compliance desk thread with this text and its hits"
              >
                <MessagesSquare size={11} /> Ask the desk
              </SmallButton>
            )}
            <span className="text-[11px]" style={{ color: tooLong ? 'var(--color-error)' : 'var(--color-text-tertiary)' }}>
              {text.length.toLocaleString()} / {PRECHECK_MAX.toLocaleString()}
            </span>
          </div>
          {result && <PrecheckResultView result={result} />}
        </>
      )}
    </div>
  );
}
