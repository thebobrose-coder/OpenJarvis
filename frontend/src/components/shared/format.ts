/** Number and date formatting shared by the Commerce and Business Development pages. */

export function num(n: number | null | undefined, digits = 0): string {
  if (n == null || Number.isNaN(n)) return '—';
  return n.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

export function shortDateTime(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Engine ids -> cost labels; the local model costs nothing. */
export function engineLabel(engine: string, usd: number): string {
  if (engine.includes('qwen') || engine.endsWith('_local')) return `${engine.replace(/_local$/, '')}: free / local`;
  return `${engine}: $${usd.toFixed(2)}`;
}
