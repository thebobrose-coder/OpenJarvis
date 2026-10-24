import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { DesksView, type DeskThread, type TraceRow } from '../components/Desks/DesksView';
import { useAppStore } from '../lib/store';
import {
  addRuling,
  deleteRuling,
  editRuling,
  fetchDesks,
  fetchRulings,
  fetchSoul,
  isDeskId,
  saveSoul,
  type DeskId,
  type DeskInfo,
  type Ruling,
  type Soul,
} from '../lib/desks-api';
import type { Conversation } from '../types';

const SELECTED_KEY = 'oj-desks-selected';
const TRACE_MAX = 30;

/** The trace: this desk's tool calls across its threads, newest first, with
 * the streaming turn's calls on top while it runs. */
export function deskTrace(
  conversations: Conversation[],
  desk: DeskId,
  live?: { conversationId: string | null; calls: TraceRow['call'][] },
): TraceRow[] {
  const rows: TraceRow[] = [];
  for (const c of conversations) {
    if (c.desk !== desk) continue;
    for (const m of c.messages) {
      if (m.role !== 'assistant' || !m.toolCalls?.length) continue;
      if (live && c.id === live.conversationId && m === c.messages[c.messages.length - 1]) continue;
      m.toolCalls.forEach((call, i) =>
        rows.push({ key: `${m.id}:${i}`, thread: c.id, at: m.timestamp, route: m.telemetry?.route, call }),
      );
    }
  }
  rows.sort((a, b) => b.at - a.at || b.key.localeCompare(a.key));
  const liveRows =
    live && live.calls.length && conversations.some((c) => c.id === live.conversationId && c.desk === desk)
      ? live.calls.map((call, i) => ({ key: `live:${i}`, thread: live.conversationId!, at: Date.now(), call }))
      : [];
  return [...liveRows.reverse(), ...rows].slice(0, TRACE_MAX);
}

/** /agents: the Desks roster (hq 0020 D2a). The upstream Agents page stays in
 * the tree, unrouted. */
export function DesksPage() {
  const navigate = useNavigate();
  const conversations = useAppStore((s) => s.conversations);
  const streamState = useAppStore((s) => s.streamState);
  const selectConversation = useAppStore((s) => s.selectConversation);
  const openDeskThread = useAppStore((s) => s.openDeskThread);

  const [desks, setDesks] = useState<DeskInfo[] | null>(null);
  const [dataConfigured, setDataConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<DeskId>(() => {
    try {
      const v = localStorage.getItem(SELECTED_KEY);
      return isDeskId(v) ? v : 'content';
    } catch {
      return 'content';
    }
  });
  const [soul, setSoul] = useState<Soul | null>(null);
  const [soulDraft, setSoulDraft] = useState('');
  const [soulStatus, setSoulStatus] = useState<string | null>(null);
  const [soulSaving, setSoulSaving] = useState(false);
  const [rulings, setRulings] = useState<Ruling[]>([]);
  const [rulingsError, setRulingsError] = useState<string | null>(null);

  const loadDesks = useCallback(async () => {
    try {
      const body = await fetchDesks();
      setDesks(body.desks);
      setDataConfigured(body.data_configured);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSoul = useCallback(async (id: DeskId) => {
    try {
      const s = await fetchSoul(id);
      setSoul(s);
      setSoulDraft(s.text ?? '');
      setSoulStatus(null);
    } catch (e) {
      setSoul(null);
      setSoulStatus(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const loadRulings = useCallback(async (id: DeskId) => {
    try {
      setRulings(await fetchRulings(id));
      setRulingsError(null);
    } catch (e) {
      setRulingsError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void loadDesks();
  }, [loadDesks]);

  useEffect(() => {
    try {
      localStorage.setItem(SELECTED_KEY, selected);
    } catch {
      /* per-browser convenience only */
    }
    void loadSoul(selected);
    void loadRulings(selected);
  }, [selected, loadSoul, loadRulings]);

  const rulingAction = (fn: () => Promise<unknown>) => async () => {
    try {
      await fn();
      setRulingsError(null);
    } catch (e) {
      setRulingsError(e instanceof Error ? e.message : String(e));
    }
    await loadRulings(selected);
    void loadDesks();
  };

  const threads: DeskThread[] = useMemo(
    () =>
      conversations
        .filter((c) => c.desk === selected)
        .map((c) => ({
          id: c.id,
          title: c.title,
          updatedAt: c.updatedAt,
          turns: c.messages.filter((m) => m.role === 'user').length,
        })),
    [conversations, selected],
  );

  const live = streamState.isStreaming
    ? { conversationId: streamState.conversationId, calls: streamState.activeToolCalls }
    : undefined;
  const trace = deskTrace(conversations, selected, live);

  return (
    <div className="flex-1 overflow-y-auto px-6 py-10">
      <DesksView
        desks={desks}
        loading={loading}
        error={error}
        dataConfigured={dataConfigured}
        selected={selected}
        onSelect={setSelected}
        soul={soul}
        soulDraft={soulDraft}
        onSoulDraft={setSoulDraft}
        onSaveSoul={() => {
          setSoulSaving(true);
          void saveSoul(selected, soulDraft, soul?.hash ?? null)
            .then((r) => {
              if (r.kind === 'saved') {
                setSoul(r.soul);
                setSoulDraft(r.soul.text ?? '');
                setSoulStatus('Saved.');
                void loadDesks();
              } else if (r.kind === 'conflict') {
                setSoulStatus(`${r.message}. Your text is still here; Reload replaces it with the file.`);
              } else {
                setSoulStatus(r.message);
              }
            })
            .finally(() => setSoulSaving(false));
        }}
        onReloadSoul={() => void loadSoul(selected)}
        soulStatus={soulStatus}
        soulSaving={soulSaving}
        rulings={rulings}
        rulingsError={rulingsError}
        onAddRuling={(text) => void rulingAction(() => addRuling(selected, text))()}
        onEditRuling={(id, text) => void rulingAction(() => editRuling(selected, id, text))()}
        onDeleteRuling={(id) => void rulingAction(() => deleteRuling(selected, id))()}
        threads={threads}
        onOpenThread={(id) => {
          selectConversation(id);
          navigate('/');
        }}
        onNewThread={() => {
          openDeskThread(selected);
          navigate('/');
        }}
        trace={trace}
        live={!!live && trace.some((r) => r.key.startsWith('live:'))}
      />
    </div>
  );
}
