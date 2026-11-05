/** The one age style: "under a minute", "45 min", "3 h", "2 d". */
export function ageWords(seconds: number): string {
  const min = Math.floor(Math.max(0, seconds) / 60);
  if (min < 1) return 'under a minute';
  if (min < 120) return `${min} min`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h} h` : `${Math.floor(h / 24)} d`;
}

/** "just now", "45 min ago", "3 h ago", "2 d ago". */
export function formatAge(seconds: number): string {
  return seconds < 60 ? 'just now' : `${ageWords(seconds)} ago`;
}

/** `formatAge` for a timestamp; '' when there is none or it doesn't parse. */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? '' : formatAge((now - t) / 1000);
}

/** A source's age: "45 min old", or "missing" when it has none. */
export function fmtAge(seconds: number | null): string {
  return seconds == null ? 'missing' : `${ageWords(seconds)} old`;
}
