/**
 * mailto: links for the operator's own mail client. Neither OpenJarvis nor
 * Hermes sends email (contract v0.9 "Send path").
 */

/** Long mailto: URLs get truncated or rejected by Windows mail handlers
 * past ~2 KB, so anything longer falls back to the copy buttons. */
export const MAILTO_MAX = 2000;

/** RFC 6068: percent-encode everything, line breaks as CRLF. */
function encode(text: string): string {
  return encodeURIComponent(text.replace(/\r?\n/g, '\r\n'));
}

export type Mailto = { ok: true; href: string } | { ok: false; reason: 'no_address' | 'too_long'; length?: number };

export function buildMailto(to: string | null | undefined, subject: string, body: string): Mailto {
  const address = (to ?? '').trim();
  if (!address || !address.includes('@')) return { ok: false, reason: 'no_address' };
  const href = `mailto:${encodeURIComponent(address).replace(/%40/g, '@')}?subject=${encode(subject)}&body=${encode(body)}`;
  if (href.length > MAILTO_MAX) return { ok: false, reason: 'too_long', length: href.length };
  return { ok: true, href };
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Hand a mailto: link to the system (the desktop webview can't navigate to it). */
export async function openMailto(href: string): Promise<void> {
  const { openExternal } = await import('../../lib/open-external');
  await openExternal(href);
}
