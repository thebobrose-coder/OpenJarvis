import { useState } from 'react';
import { Newspaper } from 'lucide-react';
import { useDailyBriefAudio } from '../../lib/DailyBriefAudioContext';
import { useCultureAudio } from '../../lib/CultureAudioContext';
import { Segmented } from '../shared/ui';
import { DashboardPanel } from './DashboardPanel';
import { DailyBriefBody } from './DailyBriefPanel';
import { CultureBody } from './CultureNewsPanel';
import { ListenList, useVoiceQueue } from './ListenPanel';

type Tab = 'brief' | 'culture' | 'listen';

/**
 * The digests in one panel (widescreen plan, Phase 1): the Daily Brief, Culture &
 * Sports and the Listen queue as tabs. One speaker per tab; Regenerate acts on the
 * digest shown. The Listen queue is the aggregate of the other speakers, so it lives
 * here rather than in a panel of its own.
 */
export function DigestHubPanel() {
  const [tab, setTab] = useState<Tab>('brief');
  const brief = useDailyBriefAudio();
  const culture = useCultureAudio();
  const listen = useVoiceQueue();
  const digest = tab === 'brief' ? brief : tab === 'culture' ? culture : null;
  const articles = culture.digest?.articles?.length ?? 0;
  const items = listen.queue?.items.length ?? 0;
  return (
    <DashboardPanel
      icon={Newspaper}
      title="Briefings"
      tag={tab === 'brief' ? 'Flagship' : tab === 'culture' ? 'Daily' : listen.queue?.voice_name}
      size="half"
      band="tall"
      priority
      loading={digest ? digest.loading : listen.loading}
      error={digest ? digest.error : listen.error}
      onRegenerate={digest ? digest.regenerate : undefined}
      regenerating={digest?.regenerating}
      headerExtra={
        <Segmented<Tab>
          ariaLabel="Briefing"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'brief', label: 'Daily Brief' },
            { value: 'culture', label: articles ? `Culture & Sports (${articles})` : 'Culture & Sports' },
            { value: 'listen', label: items ? `Listen (${items})` : 'Listen' },
          ]}
        />
      }
    >
      {tab === 'brief' && <DailyBriefBody {...brief} />}
      {tab === 'culture' && <CultureBody {...culture} limit={8} />}
      {tab === 'listen' && (
        <>
          {listen.queue && <ListenList queue={listen.queue} />}
          {listen.playError && (
            <p className="mt-2 text-ui-11" style={{ color: 'var(--color-warning)' }}>
              {listen.playError}
            </p>
          )}
        </>
      )}
    </DashboardPanel>
  );
}
