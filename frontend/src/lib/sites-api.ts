/**
 * Company sites (contract v1.27, hq 0026 D5): Hermes's daily `entity_watch`
 * read of the company-tier sites, read-only. /api/commerce/entity_watch is a
 * GET only (its refresh is refused). The card sits in the Stack health
 * drawer, and a Waiting row of kind `notice` opens it. Pure helpers live here
 * so they test without a DOM.
 */
import { apiFetch } from './api';

export interface ServeCheck {
  path: string;
  url?: string;
  status: number | null;
  content_type: string | null;
  last_modified: string | null;
  sha256?: string | null;
  ok: boolean;
  error?: string | null;
  final_url?: string;
}

export interface GscRead {
  start?: string;
  end?: string;
  clicks?: number | null;
  impressions?: number | null;
  position?: number | null;
  inspection?: { verdict?: string | null; coverage?: string | null; last_crawl?: string | null; error?: unknown } | null;
  error?: string;
}

export interface Ga4Read {
  days?: number;
  sessions?: number | null;
  error?: string;
}

export interface SiteRow {
  id: string;
  apex: string;
  checked_at: string | null;
  serve: ServeCheck[];
  privacy_sha256: string | null;
  /** An object, or a reason string ("not verified", "not configured"). */
  gsc: GscRead | string | null;
  /** An object, or a reason string ("no property id"). */
  ga4: Ga4Read | string | null;
}

export interface EntityWatch {
  run_at: string | null;
  notices: { id: string; kind: string; entity: string; detail: string; at: string }[];
  briefing_line: string | null;
  baseline: boolean;
  compared_against?: string;
  entities: SiteRow[];
  generated_at: string;
  age_seconds: number;
  stale: boolean;
}

/** A `checked_at` older than this reads stale, in amber. */
export const SITE_STALE_S = 36 * 3600;
export const HASH_CHARS = 12;
export const PRIVACY_NOTE = "Google's OAuth verification reads this page.";

export async function fetchEntityWatch(): Promise<EntityWatch> {
  const res = await apiFetch('/api/commerce/entity_watch');
  if (res.status === 404) throw new Error('No company-site data yet');
  if (!res.ok) throw new Error(`Company sites unavailable (${res.status})`);
  return res.json();
}

export function checkedStale(checkedAt: string | null | undefined, now = Date.now()): boolean {
  if (!checkedAt) return true;
  const t = new Date(checkedAt).getTime();
  return Number.isNaN(t) || (now - t) / 1000 > SITE_STALE_S;
}

/** The host a row or URL names: `alpha.example.test` from its https apex. */
export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

const num = (n: number | null | undefined, digits = 0) =>
  typeof n === 'number' ? n.toLocaleString('en-US', { maximumFractionDigits: digits }) : '—';

/** Search Console in one line, or its reason string as-is. */
export function gscText(g: SiteRow['gsc']): string {
  if (g == null) return 'missing';
  if (typeof g === 'string') return g;
  if (g.error) return g.error;
  const verdict = g.inspection?.verdict ?? (g.inspection?.error != null ? `inspection error ${String(g.inspection.error)}` : null);
  const parts = [`${num(g.clicks)} clicks`, `${num(g.impressions)} impressions`, `position ${num(g.position, 1)}`];
  if (verdict) parts.push(verdict);
  return parts.join(' · ');
}

/** GA4 sessions over the window, or its reason string as-is. */
export function ga4Text(g: SiteRow['ga4']): string {
  if (g == null) return 'missing';
  if (typeof g === 'string') return g;
  if (g.error) return g.error;
  return `${num(g.sessions)} sessions / ${g.days ?? 28} d`;
}

// -- the Waiting row (kind `notice`) ------------------------------------------

export type NoticeKind = 'serve_failed' | 'privacy_changed' | 'last_modified_changed';

/** Hermes's notice detail is `<url>: <rest>`. */
function splitDetail(detail: string | null | undefined): { url: string | null; rest: string } {
  if (!detail) return { url: null, rest: '' };
  const m = /^(https?:\/\/\S+?):\s(.*)$/.exec(detail);
  return m ? { url: m[1], rest: m[2] } : { url: null, rest: detail };
}

/** The row's line: the site, the notice in words, and the path or detail. */
export function noticeLine(item: { notice_kind?: string | null; detail: string | null; scope: string | null; title: string }): string {
  const { url, rest } = splitDetail(item.detail);
  let host = item.scope ?? '';
  let path = '';
  if (url) {
    try {
      const u = new URL(url);
      host = u.hostname;
      path = u.pathname || '/';
    } catch {
      /* keep the scope */
    }
  }
  switch (item.notice_kind) {
    case 'serve_failed': {
      const reason = rest.replace(/^status\s+/, '');
      return `${host} is not serving ${path || 'a page'}${reason ? ` (${reason})` : ''}`;
    }
    case 'privacy_changed':
      return `${host}: privacy page changed`;
    case 'last_modified_changed':
      return `${host}: ${path || 'a page'} Last-Modified changed`;
    default:
      return host ? `${host}: ${item.title}` : item.title;
  }
}
