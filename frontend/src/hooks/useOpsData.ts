import { useCallback, useEffect, useState } from 'react';
import { fetchCommerceFeed, type SpendLedger } from '../lib/commerce-api';
import { fetchContentFeed, type ContentProposals } from '../lib/content-api';
import { fetchBizDevFeed, type BdStats } from '../lib/bizdev-api';
import { fetchVoiceQueue, type VoiceQueue } from '../lib/voice-api';
import { fetchSpeechHealth, fetchTtsHealth, type SpeechHealth, type TtsHealth } from '../lib/api';
import { listConnectors } from '../lib/connectors-api';
import { useAppStore } from '../lib/store';

export interface Polled<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

/** The ledger and the cost blocks move at most daily; five minutes is plenty. */
export const OPS_POLL_MS = 5 * 60 * 1000;
/** The voice queue and the worker change while the operator listens. */
export const VOICE_POLL_MS = 60 * 1000;

/** One read, then every `ms` while the page is mounted; the last good copy stays on an error. */
function usePolled<T>(load: () => Promise<T | null>, ms: number): Polled<T> {
  const [state, setState] = useState<Polled<T>>({ data: null, loading: true, error: null });
  const run = useCallback(async () => {
    try {
      const data = await load();
      setState({ data, loading: false, error: null });
    } catch (e) {
      setState((s) => ({ data: s.data, loading: false, error: e instanceof Error ? e.message : String(e) }));
    }
    // `load` is a module-level fetcher per call site: stable.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    void run();
    const id = window.setInterval(() => void run(), ms);
    return () => window.clearInterval(id);
  }, [run, ms]);
  return state;
}

export interface VoiceState {
  queue: VoiceQueue | null;
  tts: TtsHealth | null;
  stt: SpeechHealth | null;
}

async function loadVoice(): Promise<VoiceState> {
  const [queue, tts, stt] = await Promise.allSettled([fetchVoiceQueue(), fetchTtsHealth(), fetchSpeechHealth()]);
  return {
    queue: queue.status === 'fulfilled' ? queue.value : null,
    tts: tts.status === 'fulfilled' ? tts.value : null,
    stt: stt.status === 'fulfilled' ? stt.value : null,
  };
}

/** The connector list the sidebar dock used to fetch for its dots (now on Ops). */
function useConnectors() {
  const cached = useAppStore((s) => s.cachedConnectors);
  const setCached = useAppStore((s) => s.setCachedConnectors);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (cached) return;
    listConnectors()
      .then((list) =>
        setCached(
          list.map((c) => ({
            connector_id: c.connector_id,
            display_name: c.display_name,
            connected: c.connected,
            chunks: c.chunks ?? 0,
            auth_type: c.auth_type,
          })),
        ),
      )
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [cached, setCached]);
  return { connectors: cached, error };
}

/**
 * Everything the Ops page reads besides the stack-health hook (widescreen plan 5.3):
 * the spend ledger, the Content and BizDev cost blocks, the voice queue and the
 * speech backends, and the connectors. Existing feeds and routes only; no writes.
 */
export function useOpsData() {
  const spend = usePolled<SpendLedger>(() => fetchCommerceFeed('spend_ledger'), OPS_POLL_MS);
  const proposals = usePolled<ContentProposals>(() => fetchContentFeed('content_proposals'), OPS_POLL_MS);
  const bdStats = usePolled<BdStats>(() => fetchBizDevFeed('bd_stats'), OPS_POLL_MS);
  const voice = usePolled<VoiceState>(loadVoice, VOICE_POLL_MS);
  const connectors = useConnectors();
  return { spend, proposals, bdStats, voice, connectors };
}
