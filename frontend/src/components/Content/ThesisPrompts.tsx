import { Check, Lightbulb, X } from 'lucide-react';
import type { PromptAction, ThesisPrompt } from '../../lib/content-api';
import { DashboardPanel } from '../Dashboard/DashboardPanel';
import { shortDateTime } from '../shared/format';
import { Chip, ExtLink, SmallButton } from '../shared/ui';

/** CIO long-form theses are the operator's own: Hermes only offers prompts. */
export function ThesisPrompts({
  prompts,
  showProperty,
  onMark,
}: {
  prompts: ThesisPrompt[];
  showProperty: boolean;
  onMark: (id: string, action: PromptAction) => void;
}) {
  if (prompts.length === 0) return null;
  return (
    <DashboardPanel icon={Lightbulb} title="Thesis prompts" tag={`${prompts.length} open`} size="tall">
      <div className="flex flex-col gap-2.5">
        <p className="text-[11.5px]" style={{ color: 'var(--color-text-tertiary)' }}>
          Prompts for you; Hermes doesn’t write theses.
        </p>
        <ul className="flex flex-col gap-2.5 max-h-[75vh] overflow-y-auto pr-1">
          {prompts.map((t) => (
            <li key={t.id} className="flex flex-col gap-1.5 rounded-lg p-3" style={{ background: 'var(--color-bg-secondary)' }}>
              <div className="flex flex-wrap items-center gap-1.5">
                {showProperty && <Chip tone="accent">{t.property_id}</Chip>}
                <span className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
                  {shortDateTime(t.created_at)}
                </span>
              </div>
              <span className="font-medium" style={{ color: 'var(--color-text)' }}>
                {t.signal}
              </span>
              {t.why_it_matters && (
                <p>
                  <span style={{ color: 'var(--color-text-tertiary)' }}>Why it matters: </span>
                  {t.why_it_matters}
                </p>
              )}
              {(t.links ?? []).length > 0 && (
                <div className="flex flex-wrap gap-x-3 text-[11px]" style={{ color: 'var(--color-accent)' }}>
                  {(t.links ?? []).map((url, i) => (
                    <ExtLink key={i} url={url}>
                      Link {(t.links ?? []).length > 1 ? i + 1 : ''}
                    </ExtLink>
                  ))}
                </div>
              )}
              <div className="flex gap-1.5">
                <SmallButton tone="accent" onClick={() => onMark(t.id, 'used')} title="You used it for a thesis">
                  <Check size={11} /> Used
                </SmallButton>
                <SmallButton onClick={() => onMark(t.id, 'dismissed')}>
                  <X size={11} /> Dismiss
                </SmallButton>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </DashboardPanel>
  );
}
