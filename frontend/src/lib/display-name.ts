/**
 * The assistant's display name, as the operator configured it on this
 * machine (the voice worker's `voice_name`, served by /api/voice/queue).
 * The name is never a literal in this public fork. It is remembered in
 * browser storage so the startup screen, which runs before the server is
 * up, can greet by name from the second launch on.
 */

export const DISPLAY_NAME_KEY = 'openjarvis.display_name';

const clean = (name: string | null | undefined): string | null => {
  const n = (name ?? '').trim();
  return n && n.length <= 40 ? n : null;
};

/** "I am <name>." when a name is known, else the product name. */
export function assistantTitle(name: string | null | undefined, fallback = 'OpenJarvis'): string {
  const n = clean(name);
  return n ? `I am ${n}.` : fallback;
}

export function readDisplayName(storage: Pick<Storage, 'getItem'> | null = safeStorage()): string | null {
  try {
    return clean(storage?.getItem(DISPLAY_NAME_KEY));
  } catch {
    return null;
  }
}

/** Keep the name once a route has served it; an empty name clears nothing. */
export function rememberDisplayName(name: string | null | undefined, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  const n = clean(name);
  if (!n) return;
  try {
    storage?.setItem(DISPLAY_NAME_KEY, n);
  } catch {
    /* per-machine convenience only */
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}
