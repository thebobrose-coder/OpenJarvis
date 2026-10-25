import { useState } from 'react';
import { Activity, Gavel, MessagesSquare, Plus, ScrollText, Wrench } from 'lucide-react';
import { deskIcon } from './deskIcon';
import { DashboardPanel } from '../Dashboard/DashboardPanel';
import { Chip, Quiet, SmallButton } from '../shared/ui';
import { ToolCallCard } from '../Chat/ToolCallCard';
import { RULING_MAX, SOUL_MAX, type DeskId, type DeskInfo, type Ruling, type Soul } from '../../lib/desks-api';
import type { ToolCallInfo } from '../../types';

export interface DeskThread {
  id: string;
  title: string;
  updatedAt: number;
  turns: number;
}

export interface TraceRow {
  key: string;
  thread: string;
  at: number;
  route?: 'hermes' | 'local';
  call: ToolCallInfo;
}

export interface DesksViewProps {
  desks: DeskInfo[] | null;
  loading: boolean;
  error: string | null;
  dataConfigured: boolean;
  selected: DeskId;
  onSelect: (id: DeskId) => void;
  soul: Soul | null;
  soulDraft: string;
  onSoulDraft: (text: string) => void;
  onSaveSoul: () => void;
  onReloadSoul: () => void;
  soulStatus: string | null;
  soulSaving: boolean;
  rulings: Ruling[];
  rulingsError: string | null;
  onAddRuling: (text: string) => void;
  onEditRuling: (id: number, text: string) => void;
  onDeleteRuling: (id: number) => void;
  threads: DeskThread[];
  onOpenThread: (id: string) => void;
  onNewThread: () => void;
  trace: TraceRow[];
  live: boolean;
  now?: number;
}

const field = {
  background: 'var(--color-bg)',
  border: '1px solid var(--color-border)',
  color: 'var(--color-text)',
} as const;

const TOOL_NOTES: Record<string, string> = {
  brand_context: 'Foundry bundle: kernel and compliance sections, verbatim',
  episode: 'one studio episode’s files',
  studio_status: 'the studio’s last run',
  panel_feed: 'this desk’s dashboard feeds',
  stack_health: 'the Stack drawer’s latest run',
  health_events: 'the cloud Health relay’s events',
  briefs: 'the Decisions drawer’s listing',
  runbook: 'the hq runbooks',
  precheck: 'Foundry’s pre-check, as the Compliance panel runs it',
};

function ago(ms: number, now: number): string {
  const m = Math.floor((now - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.floor(h / 24)} d ago`;
}

function Label({ children }: { children: string }) {
  return (
    <span className="text-[10.5px] uppercase tracking-wide" style={{ color: 'var(--color-text-tertiary)' }}>
      {children}
    </span>
  );
}

/** One desk in the roster row. */
function RosterCard({ desk, active, onSelect }: { desk: DeskInfo; active: boolean; onSelect: () => void }) {
  const Icon = deskIcon(desk.id);
  return (
    <button
      onClick={onSelect}
      aria-pressed={active}
      className="flex flex-col gap-1.5 rounded-lg p-3 text-left cursor-pointer min-w-[15rem] flex-1"
      style={{
        background: active ? 'var(--color-accent-subtle)' : 'var(--color-bg-secondary)',
        border: `1px solid ${active ? 'var(--color-accent)' : 'var(--color-border)'}`,
      }}
    >
      <span className="flex items-center gap-2">
        <Icon size={14} style={{ color: 'var(--color-accent)' }} />
        <span className="text-[13.5px] font-semibold" style={{ color: 'var(--color-text)' }}>
          {desk.name}
        </span>
        <Chip tone={desk.default_route === 'hermes' ? 'accent' : 'neutral'}>
          {desk.hermes === false ? 'local only' : desk.default_route === 'hermes' ? 'Hermes' : 'local'}
        </Chip>
      </span>
      <span className="text-[11.5px]" style={{ color: 'var(--color-text-secondary)' }}>
        Bound to {desk.pages.join(', ')} · {desk.soul.exists ? `soul ${desk.soul.chars.toLocaleString()} chars` : 'no soul yet'} ·{' '}
        {desk.rulings} ruling{desk.rulings === 1 ? '' : 's'}
      </span>
      {desk.cost_note && (
        <span className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
          {desk.cost_note}
        </span>
      )}
    </button>
  );
}

/** The soul, edited in place (0020 D1): a counter against the 8,000 cap and
 * a save that the server refuses if the file changed since it was loaded. */
export function SoulEditor({
  soul,
  draft,
  onDraft,
  onSave,
  onReload,
  status,
  saving,
}: {
  soul: Soul | null;
  draft: string;
  onDraft: (t: string) => void;
  onSave: () => void;
  onReload: () => void;
  status: string | null;
  saving: boolean;
}) {
  const over = draft.length > SOUL_MAX;
  const changed = draft !== (soul?.text ?? '');
  return (
    <div className="flex flex-col gap-2">
      <textarea
        aria-label="Soul"
        value={draft}
        onChange={(e) => onDraft(e.target.value)}
        rows={14}
        placeholder={soul?.exists ? '' : 'No soul.md yet. Write one and save to create it.'}
        className="w-full rounded-md px-2.5 py-2 text-[12.5px] leading-relaxed resize-y font-mono"
        style={field}
      />
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11.5px]" style={{ color: over ? 'var(--color-error)' : 'var(--color-text-tertiary)' }}>
          {draft.length.toLocaleString()} / {SOUL_MAX.toLocaleString()} characters
        </span>
        <SmallButton tone="accent" disabled={!changed || over || saving || !draft.trim()} onClick={onSave}>
          {saving ? 'Saving…' : 'Save soul'}
        </SmallButton>
        <SmallButton onClick={onReload} disabled={saving}>
          Reload
        </SmallButton>
        {status && (
          <span className="text-[11.5px]" role="status" style={{ color: 'var(--color-warning)' }}>
            {status}
          </span>
        )}
      </div>
      <p className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
        Hermes reads this file for the desk’s Hermes turns; the local route reads it for local turns. A new desk is
        served by Hermes only after its sync-config.sh has run once with the soul in place.
      </p>
    </div>
  );
}

function RulingRow({
  ruling,
  onEdit,
  onDelete,
}: {
  ruling: Ruling;
  onEdit: (text: string) => void;
  onDelete: () => void;
}) {
  const [mode, setMode] = useState<'idle' | 'edit' | 'delete'>('idle');
  const [text, setText] = useState(ruling.text);
  return (
    <li className="flex flex-col gap-1 rounded-md p-2" style={{ background: 'var(--color-bg-secondary)' }} data-ruling={ruling.id}>
      {mode === 'edit' ? (
        <>
          <textarea
            aria-label="Edit ruling"
            value={text}
            onChange={(e) => setText(e.target.value.slice(0, RULING_MAX))}
            rows={2}
            className="w-full rounded-md px-2 py-1 text-[12px] resize-y"
            style={field}
          />
          <div className="flex gap-1.5">
            <SmallButton
              tone="accent"
              disabled={!text.trim() || text === ruling.text}
              onClick={() => {
                onEdit(text);
                setMode('idle');
              }}
            >
              Save
            </SmallButton>
            <SmallButton onClick={() => setMode('idle')}>Cancel</SmallButton>
          </div>
        </>
      ) : (
        <span style={{ color: 'var(--color-text)' }}>{ruling.text}</span>
      )}
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
        <span>{ruling.created_at.slice(0, 10)}</span>
        {ruling.updated_at !== ruling.created_at && <span>· edited</span>}
        {mode === 'idle' && (
          <>
            <SmallButton onClick={() => setMode('edit')}>Edit</SmallButton>
            <SmallButton onClick={() => setMode('delete')}>Delete</SmallButton>
          </>
        )}
        {mode === 'delete' && (
          <>
            <SmallButton tone="warning" onClick={onDelete}>
              Confirm delete
            </SmallButton>
            <SmallButton onClick={() => setMode('idle')}>Cancel</SmallButton>
          </>
        )}
      </div>
    </li>
  );
}

/** The Rulings view: the operator's rulings for one desk, the only memory a
 * desk has (0019 D11). Every change rewrites the desk's rulings.md. */
export function RulingsList({
  rulings,
  error,
  onAdd,
  onEdit,
  onDelete,
}: {
  rulings: Ruling[];
  error: string | null;
  onAdd: (text: string) => void;
  onEdit: (id: number, text: string) => void;
  onDelete: (id: number) => void;
}) {
  const [text, setText] = useState('');
  return (
    <div className="flex flex-col gap-2">
      {error && (
        <p role="status" className="text-[11.5px]" style={{ color: 'var(--color-error)' }}>
          {error}
        </p>
      )}
      {rulings.length === 0 ? (
        <Quiet>No rulings yet. A desk proposes one as a card; or add one here.</Quiet>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {rulings.map((r) => (
            <RulingRow key={`${r.id}:${r.updated_at}`} ruling={r} onEdit={(t) => onEdit(r.id, t)} onDelete={() => onDelete(r.id)} />
          ))}
        </ul>
      )}
      <div className="flex gap-1.5 items-start">
        <textarea
          aria-label="New ruling"
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, RULING_MAX))}
          rows={2}
          placeholder={`A ruling for this desk (at most ${RULING_MAX} characters)`}
          className="flex-1 rounded-md px-2 py-1 text-[12px] resize-y"
          style={field}
        />
        <SmallButton
          tone="accent"
          disabled={!text.trim()}
          onClick={() => {
            onAdd(text);
            setText('');
          }}
        >
          <Plus size={11} /> Add
        </SmallButton>
      </div>
    </div>
  );
}

function ToolList({ title, tools, notes }: { title: string; tools: string[]; notes?: Record<string, string> }) {
  return (
    <div className="flex flex-col gap-1">
      <Label>{title}</Label>
      {tools.length === 0 ? (
        <Quiet>None.</Quiet>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {tools.map((t) => (
            <li key={t}>
              <code className="text-[11.5px]">{t}</code>
              {notes?.[t] && <span style={{ color: 'var(--color-text-tertiary)' }}> · {notes[t]}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** /agents (0020 D2a): the desk roster, and per desk its soul, route,
 * toolsets, rulings, threads and a live tool-call trace. Pure. */
export function DesksView(props: DesksViewProps) {
  const now = props.now ?? Date.now();
  const desk = props.desks?.find((d) => d.id === props.selected) ?? null;
  return (
    <div className="max-w-[1400px] mx-auto flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-[20px] font-semibold" style={{ color: 'var(--color-text)' }}>
          Desks
        </h1>
        <p className="text-[12.5px]" style={{ color: 'var(--color-text-secondary)' }}>
          Each desk is one role you can talk to. It reads, explains, drafts and proposes; you act through the page’s own
          controls. Open one from Chat or from “Ask the desk” on its page.
        </p>
      </header>

      {!props.desks ? (
        <Quiet>{props.loading ? 'Loading…' : props.error ?? 'No desks.'}</Quiet>
      ) : (
        <>
          {!props.dataConfigured && (
            <p role="status" className="text-[12px]" style={{ color: 'var(--color-warning)' }}>
              The workspace data folder isn’t configured, so souls and rulings can’t be read or written.
            </p>
          )}
          <div className="flex flex-wrap gap-3" role="list" aria-label="Desk roster">
            {props.desks.map((d) => (
              <RosterCard key={d.id} desk={d} active={d.id === props.selected} onSelect={() => props.onSelect(d.id)} />
            ))}
          </div>

          {desk && (
            <div className="grid grid-cols-12 gap-4">
              <DashboardPanel icon={ScrollText} title={`${desk.name}: soul`} tag={desk.soul.exists ? undefined : 'absent'} size="wide">
                <SoulEditor
                  soul={props.soul}
                  draft={props.soulDraft}
                  onDraft={props.onSoulDraft}
                  onSave={props.onSaveSoul}
                  onReload={props.onReloadSoul}
                  status={props.soulStatus}
                  saving={props.soulSaving}
                />
              </DashboardPanel>

              <DashboardPanel icon={Wrench} title="Route and tools" size="tall">
                <div className="flex flex-col gap-3 text-[12px]">
                  <div className="flex flex-col gap-1">
                    <Label>Default route</Label>
                    <span style={{ color: 'var(--color-text)' }}>
                      {desk.hermes === false
                        ? 'Local qwen on this machine only. This desk has no Hermes profile.'
                        : desk.default_route === 'hermes'
                          ? 'Hermes (the desk’s read-only profile). Start with “local,” to answer on this machine.'
                          : 'Local qwen on this machine. Start with “Hermes,” for the desk’s Hermes profile.'}
                    </span>
                    <span className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
                      Hermes turns count under the daily Hermes cap.
                    </span>
                  </div>
                  <ToolList title="Local tools (read-only)" tools={desk.local_tools} notes={TOOL_NOTES} />
                  {desk.local_tools.includes('panel_feed') && (
                    <div className="flex flex-wrap gap-1">
                      {desk.panel_feeds.map((f) => (
                        <Chip key={f} tone="muted">
                          {f}
                        </Chip>
                      ))}
                    </div>
                  )}
                  <ToolList title="Hermes profile tools (read-only)" tools={desk.hermes_tools} />
                  <div className="flex flex-col gap-1">
                    <Label>Cards it may propose</Label>
                    <div className="flex flex-wrap gap-1">
                      {desk.card_kinds.map((k) => (
                        <Chip key={k}>{k}</Chip>
                      ))}
                    </div>
                  </div>
                </div>
              </DashboardPanel>

              <DashboardPanel icon={Gavel} title="Rulings" tag={`${props.rulings.length}`} size="half">
                <RulingsList
                  rulings={props.rulings}
                  error={props.rulingsError}
                  onAdd={props.onAddRuling}
                  onEdit={props.onEditRuling}
                  onDelete={props.onDeleteRuling}
                />
              </DashboardPanel>

              <DashboardPanel
                icon={MessagesSquare}
                title="Threads"
                tag={`${props.threads.length}`}
                size="half"
                actions={
                  <SmallButton tone="accent" onClick={props.onNewThread}>
                    <Plus size={11} /> New thread
                  </SmallButton>
                }
              >
                {props.threads.length === 0 ? (
                  <Quiet>No threads yet.</Quiet>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {props.threads.map((t) => (
                      <li key={t.id}>
                        <button
                          onClick={() => props.onOpenThread(t.id)}
                          className="w-full text-left rounded-md px-2 py-1.5 cursor-pointer"
                          style={{ background: 'var(--color-bg-secondary)', border: 'none' }}
                        >
                          <span className="block text-[12.5px] truncate" style={{ color: 'var(--color-text)' }}>
                            {t.title}
                          </span>
                          <span className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
                            {t.turns} turn{t.turns === 1 ? '' : 's'} · {ago(t.updatedAt, now)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </DashboardPanel>

              <DashboardPanel icon={Activity} title="Tool trace" tag={props.live ? 'live' : undefined} size="full">
                {props.trace.length === 0 ? (
                  <Quiet>No tool calls yet. Each desk turn’s local tool calls and Hermes progress show here.</Quiet>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {props.trace.map((row) => (
                      <li key={row.key} className="flex flex-col gap-1" data-trace>
                        <span className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
                          {row.route === 'hermes' ? 'Hermes' : 'local'} · {ago(row.at, now)}
                        </span>
                        <ToolCallCard toolCall={row.call} />
                      </li>
                    ))}
                  </ul>
                )}
              </DashboardPanel>
            </div>
          )}
        </>
      )}
    </div>
  );
}
