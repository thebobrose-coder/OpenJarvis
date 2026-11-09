/**
 * Whether a keydown is Ctrl/Cmd + `letter` (no Alt). Matches the typed key in
 * either case (Caps Lock gives "I") or the physical key (`KeyI`), so a
 * non-QWERTY layout or an IME that rewrites `key` still triggers it.
 */
export function isModLetter(e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey'>, letter: string): boolean {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return false;
  const l = letter.toLowerCase();
  return (e.key ?? '').toLowerCase() === l || e.code === `Key${l.toUpperCase()}`;
}
