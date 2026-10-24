import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, Film, RotateCcw, Save, X } from 'lucide-react';
import {
  G0_NOTE_MAX,
  MAX_REWRITES,
  type Claim,
  type EpisodeDetail,
  type G0Body,
  type G0File,
  type PlanBeat,
  type PublishFile,
  type SourceCopyHit,
} from '../../lib/studio-api';
import { ago } from '../../lib/waiting-api';
import { Chip, ExtLink, Quiet, SmallButton } from '../shared/ui';
import {
  fmtBytes,
  fmtDuration,
  fmtMinutes,
  fmtUsd,
  g0Notes,
  needsRuling,
  parseTags,
  publishEditable,
  publishProblems,
  scriptSections,
  stageInfo,
  stageNotes,
} from './episodes';

const field = {
  background: 'var(--color-surface)',
  color: 'var(--color-text)',
  border: '1px solid var(--color-border)',
} as const;

export interface EpisodeActions {
  /** Resolves when saved; the page reloads the episode. */
  onSaveScript: (edit: { script?: string; claims?: Claim[] }) => Promise<void>;
  onG0: (body: G0Body) => Promise<G0File>;
  onSavePublish: (body: PublishFile) => Promise<void>;
  /** A media file of this episode as an object URL (the caller revokes it on close). */
  loadMedia: (name: string) => Promise<string>;
}

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--color-text-tertiary)' }}>
          {title}
        </h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Problems({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <ul className="text-[11.5px] pl-4 list-disc" style={{ color: 'var(--color-warning)' }}>
      {items.map((p) => (
        <li key={p}>{p}</li>
      ))}
    </ul>
  );
}

function beatVisual(b: PlanBeat): string {
  const v = b.visual;
  if (!v) return '—';
  if (v.prompt) return v.prompt;
  if (v.lines?.length) return v.lines.join(' / ');
  if (v.timeline?.events?.length) return v.timeline.events.map((e) => `${e.label}: ${e.text}`).join(' · ');
  return '';
}

/** The sentence with the shared words marked, when they appear in it as written. */
function Marked({ sentence, run }: { sentence: string; run: string }) {
  const at = run ? sentence.toLowerCase().indexOf(run.toLowerCase()) : -1;
  if (at < 0) return <>{sentence}</>;
  return (
    <>
      {sentence.slice(0, at)}
      <mark style={{ background: 'var(--color-accent-subtle)', color: 'var(--color-text)' }}>{sentence.slice(at, at + run.length)}</mark>
      {sentence.slice(at + run.length)}
    </>
  );
}

/**
 * The studio's source-copy check (v0.1.4), by beat: each sentence that
 * follows a source's wording, the shared words, and the source. A note for
 * the operator, never a block on Approve. A draft written before the check
 * carries no `sourceCopy` key and reads "not checked".
 */
export function SourceCopy({
  hits,
  beats,
  index,
  sources,
}: {
  hits: SourceCopyHit[] | undefined;
  beats: PlanBeat[];
  index: { n: number; url: string }[] | null;
  /** The manifest's source list, the fallback name when the snapshot is missing. */
  sources: string[];
}) {
  if (hits === undefined) {
    return <Quiet>Not checked: this draft was written before the studio’s source-copy check. Its next script pass runs it.</Quiet>;
  }
  if (hits.length === 0) return <Quiet>No sentence follows a source’s wording.</Quiet>;
  const byBeat = new Map<number, SourceCopyHit[]>();
  for (const h of hits) byBeat.set(h.beat, [...(byBeat.get(h.beat) ?? []), h]);
  const sourceUrl = (n: number) => index?.find((e) => e.n === n)?.url ?? (index ? null : sources[n - 1] ?? null);
  return (
    <ol className="flex flex-col gap-2">
      {[...byBeat.entries()]
        .sort(([a], [b]) => a - b)
        .map(([beat, list]) => (
          <li key={beat} className="flex flex-col gap-1.5 rounded-md px-2 py-1.5" style={{ background: 'var(--color-bg-secondary)' }} data-copy-beat={beat}>
            <span className="font-medium" style={{ color: 'var(--color-text)' }}>
              Beat {beat}
              {beats.find((b) => b.beat === beat)?.heading ? `: ${beats.find((b) => b.beat === beat)?.heading}` : ''} · {list.length} hit{list.length > 1 ? 's' : ''}
            </span>
            {list.map((h, i) => {
              const url = sourceUrl(h.sourceN);
              return (
                <div key={i} className="flex flex-col gap-0.5">
                  <span style={{ color: 'var(--color-text)' }}>
                    <Marked sentence={h.sentence} run={h.run} />
                  </span>
                  <span className="flex flex-wrap items-center gap-1.5 text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
                    <Chip tone={h.kind === 'run' ? 'warning' : 'muted'}>{h.kind === 'run' ? 'copied run' : 'dense overlap'}</Chip>
                    <span>shared: “{h.run}”</span>
                    {url ? (
                      <span style={{ color: 'var(--color-accent)' }}>
                        <ExtLink url={url}>source {h.sourceN}</ExtLink>
                      </span>
                    ) : (
                      <span>source {h.sourceN}</span>
                    )}
                  </span>
                </div>
              );
            })}
          </li>
        ))}
    </ol>
  );
}

/** The visual plan per beat: kind, what it shows, the sound line, the claims it carries. */
export function PlanTable({ beats, copyHits }: { beats: PlanBeat[]; copyHits?: Record<number, number> }) {
  return (
    <ol className="flex flex-col gap-1.5">
      {beats.map((b) => (
        <li key={b.beat} className="flex flex-col gap-0.5 rounded-md px-2 py-1.5" style={{ background: 'var(--color-bg-secondary)' }}>
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium" style={{ color: 'var(--color-text)' }}>
              {b.beat}. {b.heading}
            </span>
            {b.visual?.kind && <Chip tone="accent">{b.visual.kind}</Chip>}
            {b.words != null && <Chip tone="muted">{b.words} words</Chip>}
            {b.sound && <Chip tone="muted">{b.sound}</Chip>}
            {(b.claimIds ?? []).length > 0 && <Chip tone="muted">{(b.claimIds ?? []).join(', ')}</Chip>}
            {copyHits?.[b.beat] ? <Chip tone="warning">{copyHits[b.beat]} source-copy hit{copyHits[b.beat] > 1 ? 's' : ''}</Chip> : null}
          </span>
          {beatVisual(b) && (
            <span className="text-[11.5px]" style={{ color: 'var(--color-text-secondary)' }}>
              {beatVisual(b)}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

/** The claims, one check box each; Approve waits for all of them. */
export function ClaimsTable({
  claims,
  checked,
  onCheck,
  editing,
  onEdit,
  disabled,
}: {
  claims: Claim[];
  checked: Set<string>;
  onCheck: (id: string, on: boolean) => void;
  editing: boolean;
  onEdit: (claim: Claim) => void;
  disabled?: boolean;
}) {
  return (
    <ul className="flex flex-col gap-1.5" aria-label="Claims">
      {claims.map((c) => (
        <li key={c.id} className="flex items-start gap-2 rounded-md px-2 py-1.5" style={{ background: 'var(--color-bg-secondary)' }} data-claim={c.id}>
          <input
            type="checkbox"
            aria-label={`Checked ${c.id}`}
            checked={checked.has(c.id)}
            disabled={disabled}
            onChange={(e) => onCheck(c.id, e.target.checked)}
            className="mt-0.5 cursor-pointer"
          />
          <div className="flex flex-col gap-1 flex-1 min-w-0">
            <span className="flex flex-wrap items-center gap-1.5">
              <code className="text-[11px]">{c.id}</code>
              <Chip tone="muted">beat {c.beat}</Chip>
              {editing ? (
                <select value={c.kind} onChange={(e) => onEdit({ ...c, kind: e.target.value as Claim['kind'] })} className="rounded px-1 text-[11px]" style={field} aria-label={`Kind ${c.id}`}>
                  <option value="fact">fact</option>
                  <option value="lore">lore</option>
                </select>
              ) : (
                <Chip tone={c.kind === 'lore' ? 'accent' : 'neutral'}>{c.kind}</Chip>
              )}
              {needsRuling(c) && (
                <Chip tone="error" title="The studio's audit found this fact uncited: rule on it (edit the source, make it lore, or rewrite)">
                  unsourced: needs a ruling
                </Chip>
              )}
            </span>
            {editing ? (
              <>
                <textarea value={c.text} onChange={(e) => onEdit({ ...c, text: e.target.value })} rows={2} className="w-full rounded px-1.5 py-1 text-[12px] resize-y" style={field} aria-label={`Text ${c.id}`} />
                <input
                  value={c.source}
                  onChange={(e) => onEdit({ ...c, source: e.target.value.trim() })}
                  placeholder="https:// source, unsourced, or empty for lore"
                  className="w-full rounded px-1.5 py-1 text-[11.5px]"
                  style={field}
                  aria-label={`Source ${c.id}`}
                />
              </>
            ) : (
              <>
                <span style={{ color: 'var(--color-text)' }}>{c.text}</span>
                {c.source.startsWith('https://') && (
                  <span className="text-[11px] truncate" style={{ color: 'var(--color-accent)' }}>
                    <ExtLink url={c.source}>{c.source}</ExtLink>
                  </span>
                )}
              </>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

type Arm = 'approve' | 'rewrite' | 'reject' | null;

/**
 * G0 (foundry-studio.md `g0.json`): the script with inline edit, every claim
 * checked by the operator, the visual plan, Omni (default off), and Approve,
 * Request rewrite or Reject, each with a confirm step. The decision is a file
 * the studio reads on its next run; nothing here narrates or publishes.
 */
export function G0Review({ detail, actions, now }: { detail: EpisodeDetail; actions: EpisodeActions; now: number }) {
  const m = detail.manifest;
  const plan = detail.plan?.beats ?? [];
  const [script, setScript] = useState(detail.script ?? '');
  const [claims, setClaims] = useState<Claim[]>(detail.claims ?? []);
  const [editing, setEditing] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [omni, setOmni] = useState(false);
  const [note, setNote] = useState('');
  const [arm, setArm] = useState<Arm>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [savedEdit, setSavedEdit] = useState(false);
  const [sent, setSent] = useState<G0File | null>(null);

  const dirty = script !== (detail.script ?? '') || JSON.stringify(claims) !== JSON.stringify(detail.claims ?? []);
  const sections = scriptSections(script);
  const unchecked = claims.filter((c) => !checked.has(c.id));
  const rewrites = m.rewrites ?? 0;
  const notes = g0Notes(m);
  const copyHits: Record<number, number> = {};
  for (const h of m.sourceCopy ?? []) copyHits[h.beat] = (copyHits[h.beat] ?? 0) + 1;
  const refusals = stageNotes(m).filter((n) => /refused|waits|unknown/i.test(n));
  const approveProblems = [
    ...(unchecked.length ? [`Check every claim: ${unchecked.length} of ${claims.length} not checked.`] : []),
    ...(plan.length && sections !== plan.length ? [`The script has ${sections} beat headings and the plan ${plan.length}: the studio approves only one heading per beat.`] : []),
    ...(dirty ? ['Save or discard your edits first.'] : []),
  ];

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await actions.onSaveScript({
        ...(script !== (detail.script ?? '') ? { script } : {}),
        ...(JSON.stringify(claims) !== JSON.stringify(detail.claims ?? []) ? { claims } : {}),
      });
      setSavedEdit(true);
      setEditing(false);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const discard = () => {
    setScript(detail.script ?? '');
    setClaims(detail.claims ?? []);
    setEditing(false);
  };

  const decide = async (decision: NonNullable<Arm>) => {
    setBusy(true);
    setMessage(null);
    try {
      setSent(
        await actions.onG0({
          decision,
          note: note.trim() || undefined,
          omni: decision === 'approve' ? omni : false,
          claimsChecked: [...checked],
          edited: savedEdit || detail.edited,
        }),
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setArm(null);
    }
  };

  if (sent) {
    return (
      <p role="status" className="rounded-lg p-3" style={{ border: '1px solid var(--color-accent-subtle)' }}>
        <Chip tone="success">{sent.decision}</Chip> written. The studio applies it on its next run (every 10 minutes, or Run studio now).
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <Section title="For G0">
        <div className="flex flex-wrap gap-1.5">
          <Chip tone={rewrites >= MAX_REWRITES ? 'warning' : 'muted'}>
            rewrites {rewrites} / {MAX_REWRITES}
          </Chip>
          {m.prescreen && <Chip tone={m.prescreen.verdict === 'pass' ? 'success' : 'error'}>pre-screen {m.prescreen.verdict}</Chip>}
          {(detail.edited || m.operatorEdited) && <Chip tone="accent">edited by you</Chip>}
          <span className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
            at G0 {ago(detail.summary.since, now)}
          </span>
        </div>
        {notes.length > 0 && <Problems items={notes} />}
        {refusals.length > 0 && (
          <ul className="text-[11.5px] pl-4 list-disc" style={{ color: 'var(--color-error)' }}>
            {refusals.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title={`Script (${sections} beats)`}
        aside={
          editing ? (
            <span className="flex gap-1.5">
              <SmallButton tone="accent" onClick={() => void save()} disabled={!dirty || busy}>
                <Save size={11} /> Save edits
              </SmallButton>
              <SmallButton onClick={discard} disabled={busy}>
                Discard
              </SmallButton>
            </span>
          ) : (
            <SmallButton onClick={() => setEditing(true)}>Edit script and claims</SmallButton>
          )
        }
      >
        {editing ? (
          <textarea
            value={script}
            onChange={(e) => setScript(e.target.value)}
            rows={24}
            aria-label="Script"
            className="w-full rounded-md px-2 py-1.5 text-[12.5px] resize-y"
            style={{ ...field, fontFamily: 'inherit' }}
          />
        ) : (
          <pre className="whitespace-pre-wrap text-[12.5px] rounded-md p-2 max-h-[60vh] overflow-y-auto" style={{ fontFamily: 'inherit', background: 'var(--color-bg-secondary)', color: 'var(--color-text)' }}>
            {detail.script ?? 'No script.md yet.'}
          </pre>
        )}
      </Section>

      <Section title={`Claims (${checked.size} / ${claims.length} checked)`}>
        <ClaimsTable
          claims={claims}
          checked={checked}
          editing={editing}
          disabled={busy}
          onCheck={(id, on) =>
            setChecked((s) => {
              const next = new Set(s);
              if (on) next.add(id);
              else next.delete(id);
              return next;
            })
          }
          onEdit={(c) => setClaims((list) => list.map((x) => (x.id === c.id ? c : x)))}
        />
      </Section>

      <Section title={`Source copy${m.sourceCopy ? ` (${m.sourceCopy.length})` : ''}`}>
        <SourceCopy hits={m.sourceCopy} beats={plan} index={detail.sourceIndex} sources={m.sources ?? []} />
      </Section>

      {plan.length > 0 && (
        <Section title="Visual plan">
          <PlanTable beats={plan} copyHits={copyHits} />
        </Section>
      )}

      <Section title="Decision">
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={omni} onChange={(e) => setOmni(e.target.checked)} />
          <span>
            Omni <span style={{ color: 'var(--color-text-tertiary)' }}>(cloud motion on beats; off by default, counts against the caps)</span>
          </span>
        </label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value.slice(0, G0_NOTE_MAX))}
          rows={3}
          placeholder="Note (the rewrite instructions; optional for approve or reject)"
          aria-label="G0 note"
          className="w-full rounded-md px-2 py-1.5 text-[12px] resize-y"
          style={field}
        />
        <Problems items={approveProblems} />
        {message && (
          <p role="alert" className="text-[11.5px]" style={{ color: 'var(--color-error)' }}>
            {message}
          </p>
        )}
        {arm ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span>
              {arm === 'approve' ? `Approve${omni ? ' with Omni' : ''} and send it to narration?` : arm === 'rewrite' ? 'Ask the studio for a rewrite?' : 'Reject this episode? It ends here.'}
            </span>
            <SmallButton tone={arm === 'reject' ? 'error' : 'success'} onClick={() => void decide(arm)} disabled={busy}>
              Confirm {arm}
            </SmallButton>
            <SmallButton onClick={() => setArm(null)} disabled={busy}>
              Cancel
            </SmallButton>
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            <SmallButton tone="success" onClick={() => setArm('approve')} disabled={busy || approveProblems.length > 0}>
              <Check size={11} /> Approve
            </SmallButton>
            <SmallButton
              onClick={() => setArm('rewrite')}
              disabled={busy || dirty || !note.trim() || rewrites >= MAX_REWRITES}
              title={rewrites >= MAX_REWRITES ? `${MAX_REWRITES} rewrites already: approve, edit or reject` : 'Write what to change in the note'}
            >
              <RotateCcw size={11} /> Request rewrite
            </SmallButton>
            <SmallButton tone="error" onClick={() => setArm('reject')} disabled={busy || dirty}>
              <X size={11} /> Reject
            </SmallButton>
          </div>
        )}
      </Section>
    </div>
  );
}

/** A video from the episode folder, loaded on demand (the cut can be large). */
function Clip({ name, label, size, loadMedia }: { name: string; label: string; size: number; loadMedia: EpisodeActions['loadMedia'] }) {
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  if (url) return <video src={url} controls className="w-full rounded-md max-h-[50vh]" style={{ background: '#000' }} aria-label={label} />;
  return (
    <SmallButton
      onClick={() => {
        setState('loading');
        loadMedia(name).then(setUrl, () => setState('error'));
      }}
      disabled={state === 'loading'}
    >
      <Film size={11} /> {state === 'loading' ? 'Loading…' : state === 'error' ? `${label}: failed, retry` : `${label} (${fmtBytes(size)})`}
    </SmallButton>
  );
}

/** The three thumbnails, loaded as blobs; the operator picks one. */
function ThumbPicker({
  names,
  value,
  onPick,
  loadMedia,
  disabled,
}: {
  names: string[];
  value: string;
  onPick: (name: string) => void;
  loadMedia: EpisodeActions['loadMedia'];
  disabled: boolean;
}) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const key = names.join('|');
  useEffect(() => {
    let alive = true;
    const made: string[] = [];
    for (const n of key.split('|').filter(Boolean)) {
      loadMedia(`thumbs/${n}`).then(
        (u) => {
          made.push(u);
          if (alive) setUrls((s) => ({ ...s, [n]: u }));
          else URL.revokeObjectURL(u);
        },
        () => undefined,
      );
    }
    return () => {
      alive = false;
      made.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [key, loadMedia]);
  return (
    <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Thumbnail">
      {names.map((n) => (
        <button
          key={n}
          role="radio"
          aria-checked={value === n}
          disabled={disabled}
          onClick={() => onPick(n)}
          className="flex flex-col gap-1 rounded-md p-1 cursor-pointer disabled:cursor-default"
          style={{ border: `2px solid ${value === n ? 'var(--color-accent)' : 'var(--color-border)'}`, background: 'transparent' }}
        >
          {urls[n] ? <img src={urls[n]} alt={n} className="w-full aspect-video object-cover rounded" /> : <span className="w-full aspect-video rounded" style={{ background: 'var(--color-bg-secondary)' }} />}
          <span className="text-[10.5px]" style={{ color: 'var(--color-text-tertiary)' }}>
            {n}
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * Title, description, tags and the thumbnail pick, written to publish.json
 * for the studio's submit step. Editable until the episode goes to G1.
 */
export function PublishForm({ detail, actions }: { detail: EpisodeDetail; actions: EpisodeActions }) {
  const m = detail.manifest;
  const saved = detail.publish;
  const [title, setTitle] = useState(saved?.title ?? m.title ?? '');
  const [description, setDescription] = useState(saved?.description ?? '');
  const [tags, setTags] = useState((saved?.tags ?? []).join(', '));
  const [thumbnail, setThumbnail] = useState(saved?.thumbnail ?? '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const editable = publishEditable(m as EpisodeDetail['manifest'] & { executionArn?: string });
  const thumbs = detail.media.thumbs;
  const body: PublishFile = { title: title.trim().replace(/\s+/g, ' '), description: description.trim(), tags: parseTags(tags), thumbnail };
  const problems = thumbs.length ? publishProblems(body, thumbs) : [];
  const changed = JSON.stringify(body) !== JSON.stringify(saved ?? null);

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await actions.onSavePublish(body);
      setMessage({ ok: true, text: 'publish.json saved. The studio submits on its next run once the cut is assembled.' });
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {!thumbs.length && <Quiet>The form opens once the cut is assembled and the thumbnails exist.</Quiet>}
      <label className="flex flex-col gap-1">
        <span className="flex justify-between text-[10.5px] uppercase tracking-wide" style={{ color: 'var(--color-text-tertiary)' }}>
          Title <span>{body.title.length} / 100</span>
        </span>
        <input value={title} onChange={(e) => setTitle(e.target.value.slice(0, 120))} disabled={!editable} className="rounded-md px-2 py-1 text-[12.5px]" style={field} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[10.5px] uppercase tracking-wide" style={{ color: 'var(--color-text-tertiary)' }}>
          Description
        </span>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} disabled={!editable} rows={5} className="rounded-md px-2 py-1.5 text-[12px] resize-y" style={field} />
        <span className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
          The studio adds the chapters and the channel’s fixed footer below it.
        </span>
      </label>
      {(detail.chapters ?? []).length > 0 && (
        <details>
          <summary className="cursor-pointer text-[11.5px]">Chapters ({(detail.chapters ?? []).length})</summary>
          <pre className="whitespace-pre-wrap text-[11.5px] mt-1" style={{ fontFamily: 'inherit' }}>
            {(detail.chapters ?? []).join('\n')}
          </pre>
        </details>
      )}
      <label className="flex flex-col gap-1">
        <span className="text-[10.5px] uppercase tracking-wide" style={{ color: 'var(--color-text-tertiary)' }}>
          Tags, comma-separated
        </span>
        <input value={tags} onChange={(e) => setTags(e.target.value)} disabled={!editable} className="rounded-md px-2 py-1 text-[12px]" style={field} />
      </label>
      {thumbs.length > 0 && <ThumbPicker names={thumbs} value={thumbnail} onPick={setThumbnail} loadMedia={actions.loadMedia} disabled={!editable} />}
      <Problems items={problems} />
      {message && (
        <p role="status" className="text-[11.5px]" style={{ color: message.ok ? 'var(--color-success)' : 'var(--color-error)' }}>
          {message.text}
        </p>
      )}
      {editable ? (
        <div>
          <SmallButton tone="accent" onClick={() => void save()} disabled={busy || !thumbs.length || problems.length > 0 || !changed}>
            <Save size={11} /> Save publish.json
          </SmallButton>
        </div>
      ) : (
        <Quiet>Submitted: the title and thumbnail are with the pipeline now.</Quiet>
      )}
    </div>
  );
}

/** Everything after G0: media, scan verdicts, spend, the publish fields and the visibility. */
export function EpisodeInfo({ detail, actions, now }: { detail: EpisodeDetail; actions: EpisodeActions; now: number }) {
  const m = detail.manifest;
  const cloud = m.cloud;
  const verdicts = (m.stages ?? []).filter((s) => ['scanning', 'at-g1', 'stopped', 'rejected'].includes(s.stage) && s.note);
  const vis = detail.visibility;
  return (
    <div className="flex flex-col gap-5">
      {detail.g0Pending && (
        <p role="status" className="rounded-lg p-3" style={{ border: '1px solid var(--color-accent-subtle)' }}>
          <Chip tone="accent">{detail.g0Pending.decision}</Chip> written {ago(detail.g0Pending.at, now)}; the studio applies it on its next run.
        </p>
      )}
      {(detail.media.short != null || detail.media.cut != null) && (
        <Section title="Cut">
          <div className="flex flex-col gap-2">
            {detail.media.short != null && <Clip name="short.mp4" label="The 60 s cut" size={detail.media.short} loadMedia={actions.loadMedia} />}
            {detail.media.cut != null && <Clip name="cut.mp4" label="The full cut" size={detail.media.cut} loadMedia={actions.loadMedia} />}
          </div>
        </Section>
      )}

      <Section title="Checks and spend">
        <div className="flex flex-wrap gap-1.5">
          {m.prescreen && <Chip tone={m.prescreen.verdict === 'pass' ? 'success' : 'error'}>pre-screen {m.prescreen.verdict}</Chip>}
          {detail.narration && <Chip tone={detail.narration.ok ? 'success' : 'error'}>narration {detail.narration.ok ? fmtDuration(detail.narration.seconds) : detail.narration.error}</Chip>}
          <Chip tone="muted">GPU {fmtMinutes(m.gpuMinutes)}</Chip>
          {cloud && (
            <Chip tone="muted">
              cloud {fmtUsd(cloud.spentUsd)} / {fmtUsd(cloud.capEpisodeUsd)}
              {cloud.omniAllowed ? ' · Omni on' : ''}
            </Chip>
          )}
          {m.durationSeconds != null && <Chip tone="muted">{fmtDuration(m.durationSeconds)}</Chip>}
        </div>
        {verdicts.length > 0 && (
          <ul className="text-[11.5px] pl-4 list-disc">
            {verdicts.map((s, i) => (
              <li key={i} style={{ color: s.ok ? 'var(--color-text-secondary)' : 'var(--color-error)' }}>
                {stageInfo(s.stage).label}: {s.note}
              </li>
            ))}
          </ul>
        )}
        {(cloud?.items ?? []).length > 0 && (
          <ul className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
            {(cloud?.items ?? []).map((it, i) => (
              <li key={i}>
                {it.kind} {fmtUsd(it.usd)}
                {it.note ? ` · ${it.note}` : ''}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Publish">
        {vis && (
          <p>
            {vis.number != null ? `Episode ${vis.number} on this channel: ` : ''}
            publishes <b style={{ color: 'var(--color-text)' }}>{vis.visibility.toUpperCase()}</b>
            {vis.visibility === 'unlisted' ? ` (the first ${vis.first} do).` : '.'}
          </p>
        )}
        <p className="text-[11.5px] rounded-md p-2" style={{ border: '1px solid var(--color-warning)' }}>
          AI label: the narration and imagery are synthetic. Set YouTube’s “altered or synthetic content” disclosure on the video before it goes public.
        </p>
        <PublishForm detail={detail} actions={actions} />
      </Section>

      {(detail.plan?.beats ?? []).length > 0 && (
        <details>
          <summary className="cursor-pointer text-[11.5px]">Visual plan</summary>
          <div className="mt-2">
            <PlanTable beats={detail.plan?.beats ?? []} />
          </div>
        </details>
      )}
      {detail.script && (
        <details>
          <summary className="cursor-pointer text-[11.5px]">Approved script</summary>
          <pre className="whitespace-pre-wrap text-[12px] mt-1" style={{ fontFamily: 'inherit' }}>
            {detail.script}
          </pre>
        </details>
      )}
    </div>
  );
}

/** The drawer's body: the G0 review while the episode waits on it, otherwise the episode's detail. */
export function EpisodeDrawerView({
  detail,
  loading,
  error,
  actions,
  now,
}: {
  detail: EpisodeDetail | null;
  loading: boolean;
  error: string | null;
  actions: EpisodeActions;
  now: number;
}) {
  if (!detail) return <Quiet>{loading ? 'Loading…' : error ?? 'Nothing to show.'}</Quiet>;
  const m = detail.manifest;
  const stage = stageInfo(m.stage);
  const atG0 = m.stage === 'awaiting-g0' && !detail.g0Pending;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip tone={stage.tone}>{stage.label}</Chip>
          <Chip tone="accent">{detail.channel?.channelName ?? m.propertyId}</Chip>
          {m.episodeClass && <Chip tone="muted">{m.episodeClass}</Chip>}
          {m.targetMinutes != null && <Chip tone="muted">{m.targetMinutes} min target</Chip>}
          {detail.paused && <Chip tone="warning">channel paused</Chip>}
        </div>
        {m.topic && <span style={{ color: 'var(--color-text-secondary)' }}>{m.topic}</span>}
        {(m.sources ?? []).length > 0 && (
          <span className="flex flex-wrap gap-x-3 text-[11px]" style={{ color: 'var(--color-accent)' }}>
            {(m.sources ?? []).map((u, i) => (
              <ExtLink key={i} url={u}>
                Source {i + 1}
              </ExtLink>
            ))}
          </span>
        )}
        {m.stoppedReason && <span style={{ color: 'var(--color-error)' }}>{m.stoppedReason}</span>}
      </div>
      {error && (
        <p role="alert" className="text-[11.5px]" style={{ color: 'var(--color-error)' }}>
          {error}
        </p>
      )}
      {atG0 ? <G0Review key={m.episodeId} detail={detail} actions={actions} now={now} /> : <EpisodeInfo key={m.episodeId} detail={detail} actions={actions} now={now} />}
      <details>
        <summary className="cursor-pointer text-[11.5px]">Stage history ({(m.stages ?? []).length})</summary>
        <ul className="text-[11px] mt-1 flex flex-col gap-0.5">
          {[...(m.stages ?? [])].reverse().map((s, i) => (
            <li key={i} style={{ color: s.ok ? 'var(--color-text-secondary)' : 'var(--color-error)' }}>
              {ago(s.at, now)} · {s.stage}
              {s.note ? `: ${s.note}` : ''}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

/** The drawer shell: portalled to <body> like the other drawers; Escape closes it. */
export function EpisodeDrawer({
  open,
  title,
  onClose,
  ...view
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  detail: EpisodeDetail | null;
  loading: boolean;
  error: string | null;
  actions: EpisodeActions;
  now: number;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  const drawer = (
    <div className="fixed inset-0 z-[70] flex justify-end" style={{ background: 'rgba(0,0,0,0.35)' }} onClick={onClose}>
      <aside
        role="dialog"
        aria-label="Episode"
        onClick={(e) => e.stopPropagation()}
        className="h-full w-full max-w-[52rem] overflow-y-auto flex flex-col gap-4 p-5 text-[12.5px]"
        style={{ background: 'var(--color-surface)', borderLeft: '1px solid var(--color-border)', color: 'var(--color-text-secondary)' }}
      >
        <header className="flex items-center justify-between gap-2">
          <h2 className="text-[15px] font-semibold" style={{ color: 'var(--color-text)' }}>
            {title}
          </h2>
          <button onClick={onClose} aria-label="Close" className="cursor-pointer" style={{ background: 'transparent', border: 'none', color: 'inherit' }}>
            <X size={16} />
          </button>
        </header>
        <EpisodeDrawerView {...view} />
      </aside>
    </div>
  );
  return typeof document === 'undefined' ? drawer : createPortal(drawer, document.body);
}
