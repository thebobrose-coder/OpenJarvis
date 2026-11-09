import { useEffect, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router';
import { PageFrame } from '../components/shared/PageFrame';
import { StudioView } from '../components/Studio/StudioView';
import { EpisodeDrawer } from '../components/Content/EpisodeDrawer';
import { isEpisodeId, nextRunAt } from '../components/Content/episodes';
import { ALL_PROPERTIES } from '../components/Content/format';
import { useStudioData } from '../hooks/useStudioData';
import { fetchContentFeed, type YouTubePerformance } from '../lib/content-api';
import { scrollToWhenReady } from '../lib/waiting-api';

const YOUTUBE_POLL_MS = 5 * 60 * 1000;

/** /studio (widescreen plan 5.2): the episode pipeline and the channels' YouTube read.
 * The studio hook lives here now; Content keeps a one-line chip that links over. */
export function StudioPage() {
  const studio = useStudioData();
  const [property, setProperty] = useState(ALL_PROPERTIES);
  const [youtube, setYoutube] = useState<{ feed: YouTubePerformance | null; loading: boolean; error: string | null }>({
    feed: null,
    loading: true,
    error: null,
  });
  useEffect(() => {
    const load = () =>
      fetchContentFeed('youtube_performance').then(
        (feed) => setYoutube({ feed, loading: false, error: null }),
        (e: unknown) => setYoutube((y) => ({ ...y, loading: false, error: e instanceof Error ? e.message : String(e) })),
      );
    void load();
    const poll = window.setInterval(() => void load(), YOUTUBE_POLL_MS);
    return () => window.clearInterval(poll);
  }, []);

  // ?focus=<episode id> from "Waiting on you" or a Content link: open the drawer and show the row.
  const location = useLocation();
  const [params] = useSearchParams();
  const focus = params.get('focus');
  const open = studio.open;
  useEffect(() => {
    if (!focus) return undefined;
    setProperty(ALL_PROPERTIES);
    if (isEpisodeId(focus)) open(focus);
    return scrollToWhenReady([`episode-${focus}`]);
  }, [focus, location.key, open]);

  return (
    <PageFrame>
      <StudioView
        status={studio.status}
        episodes={studio.episodes}
        loading={studio.loading}
        error={studio.error}
        now={Date.now()}
        selectedProperty={property}
        onSelectProperty={setProperty}
        onOpen={studio.open}
        onRun={() => void studio.run()}
        runStatus={studio.runStatus}
        runAvailableAt={studio.runAvailableAt}
        runError={studio.runError}
        onPause={(id, paused) => void studio.pause(id, paused)}
        pausing={studio.pausing}
        youtube={youtube}
        notice={studio.notice}
        onClearNotice={studio.clearNotice}
      />
      {studio.actions && (
        <EpisodeDrawer
          open={!!studio.openId}
          title={studio.detail?.summary.title || studio.detail?.manifest.topic || 'Episode'}
          onClose={studio.close}
          detail={studio.detail}
          loading={studio.detailLoading}
          error={studio.detailError}
          actions={studio.actions}
          now={Date.now()}
          initialAction={studio.openAction ?? null}
          run={{ onRun: () => void studio.run(), status: studio.runStatus ?? 'idle', availableAt: studio.runAvailableAt ?? null }}
          nextRunAt={nextRunAt(studio.status)}
        />
      )}
    </PageFrame>
  );
}
