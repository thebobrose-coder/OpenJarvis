import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { RotateCw, X } from 'lucide-react';
import {
  SUPPRESSION_STAGES,
  rankBreakdown,
  rankNumber,
  recheckReason,
  type PipelineProspect,
  type RecheckResult,
  type StageAction,
  type SuppressionStage,
} from '../../lib/bizdev-api';
import { shortDateTime } from '../shared/format';
import { Chip, ExtLink, Quiet, SmallButton } from '../shared/ui';
import { MailActions } from './MailActions';
import { RankChip, STAGE_LABELS } from './PipelineBoard';

const OUTCOMES: StageAction[] = ['replied', 'meeting', 'won', 'lost', 'not_interested', 'do_not_contact', 'bounced'];
const isSuppression = (s: string): s is SuppressionStage => (SUPPRESSION_STAGES as readonly string[]).includes(s);

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: 'var(--color-text-tertiary)' }}>
        {title}
      </h3>
      {children}
    </section>
  );
}

/**
 * What the last re-check found. When the new result was worse, Hermes kept
 * the earlier research, so the drawer says so and summarises what was
 * discarded -- a muted note for a manual look, not an error.
 */
export function RecheckNote({ recheck }: { recheck: RecheckResult }) {
  const reason = recheck.kept_previous ? recheckReason(recheck) : null;
  return (
    <div className="flex flex-col gap-0.5 text-[11.5px]" style={{ color: 'var(--color-text-tertiary)' }}>
      <span>Re-checked {shortDateTime(recheck.at)}</span>
      {recheck.kept_previous && (
        <>
          <span>New result was worse, so the earlier research was kept.</span>
          <span>
            New result: fit {recheck.fit_score ?? '—'}, {recheck.contacts ?? 0} contact{recheck.contacts === 1 ? '' : 's'}
            {reason ? ` -- ${reason}` : ''}
          </span>
        </>
      )}
    </div>
  );
}

/** "Permanent" confirmation for the three suppression outcomes. */
export function SuppressionConfirm({
  stage,
  name,
  onConfirm,
  onCancel,
}: {
  stage: SuppressionStage;
  name: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      role="alertdialog"
      aria-label={`Confirm ${STAGE_LABELS[stage]}`}
      className="flex flex-col gap-2 rounded-lg p-3"
      style={{ border: '1px solid var(--color-warning)', background: 'var(--color-bg-secondary)' }}
    >
      <p style={{ color: 'var(--color-text)' }}>
        Mark {name} as <strong>{STAGE_LABELS[stage].toLowerCase()}</strong>?
      </p>
      <p className="text-[11.5px]">
        This is permanent: the prospect leaves the pipeline and Hermes will never research or draft for it again.
      </p>
      <div className="flex gap-1.5">
        <SmallButton tone="warning" onClick={onConfirm}>
          Yes, permanently
        </SmallButton>
        <SmallButton onClick={onCancel}>Cancel</SmallButton>
      </div>
    </div>
  );
}

export function ProspectDrawer({
  prospect,
  onClose,
  onMove,
  onRecheck,
  recheckDisabled,
  rechecksToday,
  recheckCap,
}: {
  prospect: PipelineProspect;
  onClose: () => void;
  onMove: (stage: StageAction, note: string) => void;
  onRecheck: () => void;
  recheckDisabled: boolean;
  rechecksToday: number;
  recheckCap: number;
}) {
  // Draft edits stay in this component: never saved, never sent anywhere.
  const [subject, setSubject] = useState(prospect.draft?.subject ?? '');
  const [body, setBody] = useState(prospect.draft?.body ?? '');
  const [note, setNote] = useState('');
  const [confirm, setConfirm] = useState<SuppressionStage | null>(null);

  useEffect(() => {
    setSubject(prospect.draft?.subject ?? '');
    setBody(prospect.draft?.body ?? '');
    setNote('');
    setConfirm(null);
  }, [prospect.id, prospect.draft?.subject, prospect.draft?.body]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const decide = (stage: StageAction) => {
    if (isSuppression(stage)) setConfirm(stage);
    else onMove(stage, note);
  };
  const contacts = prospect.contacts ?? [];
  const signals = prospect.signals ?? {};

  const drawer = (
    <div className="fixed inset-0 z-[70] flex justify-end" style={{ background: 'rgba(0,0,0,0.35)' }} onClick={onClose}>
      <aside
        role="dialog"
        aria-label={prospect.name}
        onClick={(e) => e.stopPropagation()}
        className="h-full w-full max-w-[34rem] overflow-y-auto flex flex-col gap-4 p-5 text-[12.5px]"
        style={{ background: 'var(--color-surface)', borderLeft: '1px solid var(--color-border)', color: 'var(--color-text-secondary)' }}
      >
        <header className="flex items-start justify-between gap-2">
          <div className="flex flex-col gap-1">
            <h2 className="text-[15px] font-semibold" style={{ color: 'var(--color-text)' }}>
              {prospect.name}
            </h2>
            <span>{[prospect.association, prospect.division, prospect.conference, prospect.state].filter(Boolean).join(' · ')}</span>
            <div className="flex flex-wrap items-center gap-1.5">
              <Chip tone="accent">{STAGE_LABELS[prospect.stage] ?? prospect.stage}</Chip>
              <RankChip p={prospect} />
              {prospect.fit_score != null && <Chip>fit {prospect.fit_score} / 5</Chip>}
              {prospect.affiliation && <Chip tone="muted">{prospect.affiliation}</Chip>}
              {prospect.days_in_stage != null && <Chip tone="muted">{prospect.days_in_stage} d in stage</Chip>}
            </div>
            <div className="flex flex-wrap gap-3 text-[11.5px]" style={{ color: 'var(--color-accent)' }}>
              {prospect.website && <ExtLink url={prospect.website}>Website</ExtLink>}
              {prospect.athletics_url && <ExtLink url={prospect.athletics_url}>Athletics site</ExtLink>}
              {prospect.directory_url && <ExtLink url={prospect.directory_url}>Staff directory</ExtLink>}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" className="cursor-pointer p-1" style={{ background: 'transparent', border: 'none', color: 'inherit' }}>
            <X size={14} />
          </button>
        </header>

        {(prospect.fit_rationale || prospect.rank) && (
          <Section title="Why it fits">
            {prospect.fit_rationale && <p style={{ color: 'var(--color-text)' }}>{prospect.fit_rationale}</p>}
            {prospect.rank && (
              <p className="text-[11.5px] tabular-nums">
                Rank {rankNumber(prospect.rank.score)}: {rankBreakdown(prospect)}
              </p>
            )}
          </Section>
        )}

        <Section title="Signals">
          <div className="flex flex-wrap gap-1.5">
            {signals.platform && <Chip>platform: {signals.platform}</Chip>}
            <Chip tone={signals.directory_found ? 'success' : 'muted'}>
              {signals.directory_found ? 'directory found' : 'no directory'}
            </Chip>
            {signals.latest_date_on_home && <Chip tone="muted">latest post {signals.latest_date_on_home}</Chip>}
          </div>
          {(prospect.signal_notes?.length ?? 0) > 0 && (
            <ul className="list-disc pl-4 flex flex-col gap-0.5">
              {prospect.signal_notes!.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
          {(prospect.sources?.length ?? 0) > 0 && (
            <div className="flex flex-wrap gap-x-3 text-[11px]" style={{ color: 'var(--color-accent)' }}>
              {prospect.sources!.map((s, i) => (
                <ExtLink key={i} url={s}>
                  source {i + 1}
                </ExtLink>
              ))}
            </div>
          )}
          {prospect.triage?.reason && (
            <p className="text-[11.5px]">
              <span style={{ color: 'var(--color-text-tertiary)' }}>Triage ({prospect.triage.engine ?? 'local'}): </span>
              {prospect.triage.reason}
            </p>
          )}
        </Section>

        <Section title="Contacts (official directory)">
          {contacts.length === 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <Chip tone="warning">no contacts</Chip>
              <span className="text-[11.5px]">Re-check asks Hermes to look again.</span>
            </div>
          ) : (
            <ul className="flex flex-col gap-1">
              {contacts.map((c, i) => (
                <li key={i}>
                  <span style={{ color: 'var(--color-text)' }}>{c.name}</span>
                  {c.title ? ` -- ${c.title}` : ''}
                  <div className="text-[11.5px]">{[c.email, c.phone].filter(Boolean).join(' · ')}</div>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Draft">
          {prospect.draft ? (
            <>
              {prospect.draft.to_role && <span className="text-[11px]">For: {prospect.draft.to_role}</span>}
              <input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                aria-label="Subject"
                className="rounded-md px-2 py-1.5"
                style={{ background: 'var(--color-bg-secondary)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
              />
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                aria-label="Body"
                rows={10}
                className="rounded-md px-2 py-1.5 resize-y leading-relaxed"
                style={{ background: 'var(--color-bg-secondary)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
              />
              <span className="text-[10.5px]" style={{ color: 'var(--color-text-tertiary)' }}>
                Edits stay on this screen; they aren’t saved or sent anywhere.
              </span>
              {(prospect.draft_problems?.length ?? 0) > 0 && (
                <Quiet>Hermes flagged: {prospect.draft_problems!.join('; ')}</Quiet>
              )}
              <MailActions contacts={contacts} subject={subject} body={body} onMarkSent={() => onMove('sent', note)} />
            </>
          ) : (
            <Quiet>No draft -- Hermes drafts for the week’s top prospects.</Quiet>
          )}
        </Section>

        <Section title="Outcome">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value.slice(0, 500))}
            rows={2}
            placeholder="Optional note (kept with the stage change)"
            className="rounded-md px-2 py-1.5 resize-y"
            style={{ background: 'var(--color-bg-secondary)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
          />
          {confirm ? (
            <SuppressionConfirm
              stage={confirm}
              name={prospect.name}
              onCancel={() => setConfirm(null)}
              onConfirm={() => {
                setConfirm(null);
                onMove(confirm, note);
              }}
            />
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {OUTCOMES.map((s) => (
                <SmallButton key={s} tone={isSuppression(s) ? 'neutral' : s === 'won' ? 'success' : 'accent'} onClick={() => decide(s)}>
                  {STAGE_LABELS[s]}
                </SmallButton>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2 mt-1">
            <SmallButton onClick={onRecheck} disabled={recheckDisabled} title="Ask Hermes to research this prospect again">
              <RotateCw size={11} /> Re-check
            </SmallButton>
            <span className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
              {recheckDisabled ? 'Daily re-check cap reached' : `${rechecksToday} of ${recheckCap} re-checks used today`}
            </span>
          </div>
          {prospect.recheck && <RecheckNote recheck={prospect.recheck} />}
        </Section>

        {(prospect.history?.length ?? 0) > 0 && (
          <Section title="History">
            <ol className="flex flex-col gap-1">
              {prospect.history!.map((h, i) => (
                <li key={i} className="flex flex-col">
                  <span>
                    <span style={{ color: 'var(--color-text)' }}>{STAGE_LABELS[h.stage] ?? h.stage}</span> · {shortDateTime(h.at)}
                  </span>
                  {h.note && <span className="italic">“{h.note}”</span>}
                </li>
              ))}
            </ol>
          </Section>
        )}
      </aside>
    </div>
  );
  // Portalled to <body>: the page content sits in its own stacking context
  // (Layout), which would otherwise keep the drawer under the header bell.
  // The server renderer used in tests has no document, so it renders inline.
  return typeof document === 'undefined' ? drawer : createPortal(drawer, document.body);
}
