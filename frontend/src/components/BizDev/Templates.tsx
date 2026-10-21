import { useState } from 'react';
import { Archive, FileText, Pencil, Plus } from 'lucide-react';
import { unresolvedFields, type Template, type TemplateSave, type TemplateTouch } from '../../lib/bizdev-api';
import { MERGE_FIELDS } from '../../lib/bizdev-compose';
import { DashboardPanel } from '../Dashboard/DashboardPanel';
import { num, shortDateTime } from '../shared/format';
import { Chip, Quiet, SmallButton } from '../shared/ui';

const TOUCHES: TemplateTouch[] = [1, 2, 3, 'any'];
const AFTER_FIRST = ['first_subject', 'days_since_first'];
// Hermes's save caps (contract v0.10.2).
const CAPS = { name: 80, subject: 300, body: 6000 };

const field = {
  background: 'var(--color-bg-secondary)',
  color: 'var(--color-text)',
  border: '1px solid var(--color-border)',
} as const;

export const touchLabel = (t: TemplateTouch) => (t === 'any' ? 'any touch' : `touch ${t}`);

/** What a save would be refused for, checked here so the form says it first
 * (the server checks the same rules, and Hermes again). */
export function templateProblem(t: TemplateSave): string | null {
  if (!t.name.trim()) return 'Give the template a name';
  if (!t.subject.trim() || !t.body.trim()) return 'The subject and body can’t be empty';
  for (const [k, cap] of Object.entries(CAPS)) {
    if ((t[k as keyof typeof CAPS] ?? '').trim().length > cap) return `The ${k} is over ${cap} characters`;
  }
  const fields = unresolvedFields(t.subject, t.body);
  const unknown = fields.filter((f) => !(MERGE_FIELDS as readonly string[]).includes(f));
  if (unknown.length) return `Unknown merge field: ${unknown.map((f) => `{{${f}}}`).join(', ')}`;
  if (t.default_for_touch === 1 && fields.some((f) => AFTER_FIRST.includes(f))) {
    return 'A touch-1 default can’t use {{first_subject}} or {{days_since_first}}';
  }
  return null;
}

/**
 * New, edit, and "Save as template…" all use this form: name, touch, the
 * default-for-touch choice, subject and body. Merge fields are typed as
 * `{{field}}`; the list of them is under the body.
 */
export function TemplateEditor({
  initial,
  title,
  onSave,
  onCancel,
}: {
  initial: TemplateSave;
  title: string;
  onSave: (t: TemplateSave) => Promise<void>;
  onCancel: () => void;
}) {
  const [t, setT] = useState<TemplateSave>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<TemplateSave>) => setT((prev) => ({ ...prev, ...patch }));
  const problem = templateProblem(t);
  const defaultOptions: (1 | 2 | 3)[] = t.touch === 'any' ? [1, 2, 3] : [t.touch];

  const save = async () => {
    if (problem) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(t);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Saving failed');
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg p-3" style={{ background: 'var(--color-bg-secondary)' }} data-template-editor>
      <span className="text-[11.5px] font-medium" style={{ color: 'var(--color-text)' }}>
        {title}
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={t.name}
          onChange={(e) => set({ name: e.target.value.slice(0, CAPS.name) })}
          placeholder="Name"
          aria-label="Template name"
          className="rounded-md px-2 py-1 text-[12px] flex-1 min-w-[10rem]"
          style={field}
        />
        <label className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
          For
          <select
            value={String(t.touch)}
            aria-label="Touch"
            onChange={(e) => {
              const touch = (e.target.value === 'any' ? 'any' : Number(e.target.value)) as TemplateTouch;
              set({ touch, default_for_touch: touch === 'any' || t.default_for_touch === touch ? t.default_for_touch : undefined });
            }}
            className="rounded-md px-1.5 py-1 text-[11.5px] cursor-pointer"
            style={field}
          >
            {TOUCHES.map((x) => (
              <option key={x} value={String(x)}>
                {touchLabel(x)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
          Default for
          <select
            value={t.default_for_touch ? String(t.default_for_touch) : ''}
            aria-label="Default for touch"
            onChange={(e) => set({ default_for_touch: e.target.value ? (Number(e.target.value) as 1 | 2 | 3) : undefined })}
            className="rounded-md px-1.5 py-1 text-[11.5px] cursor-pointer"
            style={field}
            title="Hermes drafts that touch from the default template, with no model call"
          >
            <option value="">no touch</option>
            {defaultOptions.map((x) => (
              <option key={x} value={String(x)}>
                touch {x}
              </option>
            ))}
          </select>
        </label>
      </div>
      <input
        value={t.subject}
        onChange={(e) => set({ subject: e.target.value })}
        placeholder="Subject"
        aria-label="Template subject"
        className="rounded-md px-2 py-1.5 text-[12px]"
        style={field}
      />
      <textarea
        value={t.body}
        onChange={(e) => set({ body: e.target.value })}
        rows={8}
        aria-label="Template body"
        className="rounded-md px-2 py-1.5 text-[12px] resize-y leading-relaxed"
        style={field}
      />
      <span className="text-[10.5px]" style={{ color: 'var(--color-text-tertiary)' }}>
        No footer: it’s added when the mail is sent. Merge fields: {MERGE_FIELDS.map((f) => `{{${f}}}`).join(' ')}
      </span>
      <div className="flex flex-wrap items-center gap-1.5">
        <SmallButton tone="accent" onClick={() => void save()} disabled={!!problem || saving} title={problem ?? undefined}>
          {saving ? 'Saving…' : 'Save template'}
        </SmallButton>
        <SmallButton onClick={onCancel}>Cancel</SmallButton>
        {(problem || error) && (
          <span className="text-[11px]" style={{ color: error ? 'var(--color-error)' : 'var(--color-text-tertiary)' }} role="status">
            {error ?? problem}
          </span>
        )}
      </div>
    </div>
  );
}

function TemplateRow({
  t,
  onEdit,
  onArchive,
}: {
  t: Template;
  onEdit: () => void;
  onArchive: () => Promise<void>;
}) {
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <li className="flex flex-col gap-1 py-2" style={{ borderTop: '1px solid var(--color-border)' }} data-template={t.id}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[12.5px] font-medium" style={{ color: 'var(--color-text)' }}>
          {t.name}
        </span>
        <Chip tone="muted">{touchLabel(t.touch)}</Chip>
        {t.default_for_touch && <Chip tone="accent">default for touch {t.default_for_touch}</Chip>}
        <span className="text-[11px] tabular-nums ml-auto" style={{ color: 'var(--color-text-tertiary)' }}>
          {num(t.uses ?? 0)} uses · {num(t.replies ?? 0)} replies
        </span>
      </div>
      <span className="text-[12px]">{t.subject}</span>
      <span className="text-[11px] line-clamp-2 whitespace-pre-line" style={{ color: 'var(--color-text-tertiary)' }}>
        {t.body}
      </span>
      {confirm ? (
        <div className="flex flex-wrap items-center gap-1.5 text-[11.5px]" role="alertdialog" aria-label={`Archive ${t.name}`}>
          <span>Archive “{t.name}”? It stays listed as archived, loses its default and can’t be edited again.</span>
          <SmallButton
            tone="warning"
            onClick={() => {
              setConfirm(false);
              onArchive().catch((e: unknown) => setError(e instanceof Error ? e.message : 'Archiving failed'));
            }}
          >
            Archive
          </SmallButton>
          <SmallButton onClick={() => setConfirm(false)}>Cancel</SmallButton>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          <SmallButton onClick={onEdit}>
            <Pencil size={11} /> Edit
          </SmallButton>
          <SmallButton onClick={() => setConfirm(true)}>
            <Archive size={11} /> Archive
          </SmallButton>
          {t.updated_at && (
            <span className="text-[10.5px]" style={{ color: 'var(--color-text-tertiary)' }}>
              updated {shortDateTime(t.updated_at)}
            </span>
          )}
          {error && (
            <span className="text-[11px]" style={{ color: 'var(--color-error)' }} role="status">
              {error}
            </span>
          )}
        </div>
      )}
    </li>
  );
}

/** The page's Templates tab: the line's templates, with uses and replies. */
export function TemplatesPanel({
  line,
  templates,
  onSave,
  onArchive,
}: {
  line: string | null;
  templates: Template[];
  onSave: (t: TemplateSave) => Promise<void>;
  onArchive: (id: number) => Promise<void>;
}) {
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const current = templates.filter((t) => !t.archived_at);
  const archived = templates.filter((t) => t.archived_at);
  const save = async (t: TemplateSave) => {
    await onSave(t);
    setEditing(null);
  };

  return (
    <DashboardPanel icon={FileText} title="Templates" tag={`${current.length}`} size="full">
      <div className="flex flex-col gap-2 text-[12px]" style={{ color: 'var(--color-text-secondary)' }}>
        <span className="text-[11.5px]">
          Saved changes reach Hermes within about 2 minutes. A template that is the default for a touch replaces the
          model’s draft for that touch.
        </span>
        {editing === 'new' && line ? (
          <TemplateEditor
            title="New template"
            initial={{ line, name: '', touch: 1, subject: '', body: '' }}
            onSave={save}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <div>
            <SmallButton tone="accent" onClick={() => setEditing('new')} disabled={!line}>
              <Plus size={11} /> New template
            </SmallButton>
          </div>
        )}
        {current.length === 0 ? (
          <Quiet>No templates yet. Make one here, or with “Save as template…” on a draft.</Quiet>
        ) : (
          <ul className="flex flex-col">
            {current.map((t) =>
              editing === t.id && line ? (
                <li key={t.id} className="py-2">
                  <TemplateEditor
                    title={`Edit “${t.name}”`}
                    initial={{
                      id: t.id,
                      line,
                      name: t.name,
                      touch: t.touch,
                      subject: t.subject,
                      body: t.body,
                      ...(t.default_for_touch ? { default_for_touch: t.default_for_touch } : {}),
                    }}
                    onSave={save}
                    onCancel={() => setEditing(null)}
                  />
                </li>
              ) : (
                <TemplateRow key={t.id} t={t} onEdit={() => setEditing(t.id)} onArchive={() => onArchive(t.id)} />
              ),
            )}
          </ul>
        )}
        {archived.length > 0 && (
          <details>
            <summary className="cursor-pointer text-[11.5px]" style={{ color: 'var(--color-text-tertiary)' }}>
              Archived ({archived.length})
            </summary>
            <ul className="mt-1 flex flex-col gap-0.5 pl-3">
              {archived.map((t) => (
                <li key={t.id} data-template={t.id}>
                  <span style={{ color: 'var(--color-text)' }}>{t.name}</span> · {touchLabel(t.touch)} · {num(t.uses ?? 0)} uses ·{' '}
                  {num(t.replies ?? 0)} replies · archived {shortDateTime(t.archived_at)}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </DashboardPanel>
  );
}
