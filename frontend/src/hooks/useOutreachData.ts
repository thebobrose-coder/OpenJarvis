import { useCallback, useEffect, useRef, useState } from 'react';
import {
  addAccounts,
  decideCandidate,
  draftAngles,
  editAccount,
  fetchCandidates,
  fetchOutreach,
  fetchReach,
  markRound,
  rowKey,
  setCheck,
  type AccountEdits,
  type AddResult,
  type CheckItem,
  type IgCandidates,
  type IgReach,
  type OutreachState,
} from '../lib/outreach-api';
import type { AngleState, FeedState } from '../components/Outreach/OutreachView';

// The store only changes from this page; the poll rolls the day over and
// picks up a second window.
const STATE_POLL_MS = 2 * 60 * 1000;
// Hermes writes both feeds once a week.
const FEED_POLL_MS = 30 * 60 * 1000;

const message = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Put the angle kept by Copy on each ready row (pure, for the test). */
export function withUsed(angles: Record<string, AngleState>, key: string, angle: string): Record<string, AngleState> {
  const row = angles[key];
  if (row?.status !== 'ready') return angles;
  return { ...angles, [key]: { ...row, used: angle } };
}

/**
 * The Outreach page's data: OpenJarvis's own store, re-read after every write,
 * and Hermes's two weekly feeds (null until Hermes builds them). Angles live in
 * page memory only; Done sends the one the operator copied, if any.
 */
export function useOutreachData(onChanged?: () => void) {
  const [state, setState] = useState<OutreachState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reach, setReach] = useState<FeedState<IgReach>>({ data: null, loading: true, error: null });
  const [candidates, setCandidates] = useState<FeedState<IgCandidates>>({ data: null, loading: true, error: null });
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [angles, setAngles] = useState<Record<string, AngleState>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const anglesRef = useRef(angles);
  anglesRef.current = angles;
  const changed = useRef(onChanged);
  changed.current = onChanged;

  const load = useCallback(async () => {
    try {
      setState(await fetchOutreach());
      setError(null);
    } catch (e) {
      setError(message(e, 'The outreach list is unavailable.'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadFeeds = useCallback(async () => {
    await Promise.all([
      fetchReach().then(
        (data) => setReach({ data, loading: false, error: null }),
        (e) => setReach((prev) => ({ data: prev.data, loading: false, error: message(e, 'The weekly read is unavailable.') })),
      ),
      fetchCandidates().then(
        (data) => setCandidates({ data, loading: false, error: null }),
        (e) => setCandidates((prev) => ({ data: prev.data, loading: false, error: message(e, 'Candidates are unavailable.') })),
      ),
    ]);
  }, []);

  useEffect(() => {
    void load();
    void loadFeeds();
    const a = window.setInterval(() => void load(), STATE_POLL_MS);
    const b = window.setInterval(() => void loadFeeds(), FEED_POLL_MS);
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(a);
      window.clearInterval(b);
      window.removeEventListener('focus', onFocus);
    };
  }, [load, loadFeeds]);

  /** One write on a row: busy while it runs, the store re-read after, the
   * reason shown when it is refused. */
  const act = useCallback(
    async (key: string, run: () => Promise<unknown>, what: string) => {
      setBusy((b) => ({ ...b, [key]: true }));
      try {
        await run();
        setNotice(null);
      } catch (e) {
        setNotice(message(e, `${what} failed.`));
      } finally {
        setBusy((b) => {
          const { [key]: _gone, ...rest } = b;
          return rest;
        });
        await load();
        changed.current?.();
      }
    },
    [load],
  );

  const mark = useCallback(
    (brand: string, handle: string, action: 'done' | 'skip' | 'undo') => {
      const key = rowKey(brand, handle);
      const row = anglesRef.current[key];
      const used = action === 'done' && row?.status === 'ready' ? row.used : null;
      void act(key, () => markRound(brand, handle, action, used), 'The mark');
    },
    [act],
  );

  const check = useCallback(
    (brand: string, item: CheckItem, checked: boolean) => void act(`${brand}:check:${item}`, () => setCheck(brand, item, checked), 'The checklist'),
    [act],
  );

  const candidate = useCallback(
    (brand: string, handle: string, action: 'accept' | 'dismiss') => void act(rowKey(brand, handle), () => decideCandidate(brand, handle, action), action === 'accept' ? 'Accept' : 'Dismiss'),
    [act],
  );

  const add = useCallback(
    async (brand: string, text: string): Promise<AddResult> => {
      const result = await addAccounts(brand, text);
      await load();
      changed.current?.();
      return result;
    },
    [load],
  );

  const edit = useCallback(
    async (brand: string, handle: string, edits: AccountEdits) => {
      await editAccount(brand, handle, edits);
      await load();
      changed.current?.();
    },
    [load],
  );

  const askAngles = useCallback((brand: string, handle: string, about: string) => {
    const key = rowKey(brand, handle);
    setAngles((a) => ({ ...a, [key]: { status: 'loading' } }));
    draftAngles(brand, handle, about).then(
      (r) => setAngles((a) => ({ ...a, [key]: { status: 'ready', angles: r.angles, screenedOut: r.screened_out, used: null } })),
      (e) => setAngles((a) => ({ ...a, [key]: { status: 'error', error: message(e, 'No angles this time.') } })),
    );
  }, []);

  const copyAngle = useCallback((brand: string, handle: string, angle: string) => {
    void copyText(angle).then((ok) => {
      if (!ok) setNotice('Could not reach the clipboard; select the text and copy it by hand.');
    });
    setAngles((a) => withUsed(a, rowKey(brand, handle), angle));
  }, []);

  return {
    state,
    loading,
    error,
    reach,
    candidates,
    busy,
    angles,
    notice,
    clearNotice: () => setNotice(null),
    mark,
    check,
    candidate,
    add,
    edit,
    askAngles,
    copyAngle,
  };
}
