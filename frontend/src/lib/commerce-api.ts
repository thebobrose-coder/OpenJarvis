/**
 * Commerce page data: Hermes's ecom-seo feeds, proxied by /api/commerce
 * (hq/contracts/openjarvis-hermes.md v0.6 / v0.6.1 §2). Everything shown on
 * the page comes from these feeds at runtime; no store data lives in code.
 */
import type { SpeechBlock } from './voice-api';
import { apiFetch } from './api';

/** Freshness metadata the proxy adds to every feed document. */
export interface FeedMeta {
  generated_at: string;
  age_seconds: number;
  /** True when the bridge is down and this is the last good copy. */
  stale: boolean;
}

export interface StoreRef {
  slug: string;
  display_name: string;
}

// -- ecom_daily ---------------------------------------------------------------

export interface SalesWindow {
  orders: number;
  revenue: number;
  units: number;
}

export interface Ga4Campaign {
  sessionGoogleAdsCampaignName?: string;
  advertiserAdCost?: number;
  advertiserAdClicks?: number;
  advertiserAdImpressions?: number;
  sessions?: number;
  ecommercePurchases?: number;
  purchaseRevenue?: number;
}

export interface Ga4 {
  connected: boolean;
  reason?: string;
  sessions_28?: number;
  purchases_28?: number;
  revenue_28?: number;
  ads?: {
    cost_28?: number;
    clicks_28?: number;
    impressions_28?: number;
    revenue_28?: number;
    roas_28?: number | null;
    campaigns?: Ga4Campaign[];
    top_queries?: Record<string, string | number>[];
  };
}

export interface DailyStore extends StoreRef {
  sales?: {
    currency: string | null;
    yesterday: SalesWindow;
    last_7: SalesWindow;
    prior_7: SalesWindow;
    last_28: SalesWindow;
  };
  catalog?: {
    active: number;
    in_stock: number;
    out_of_stock: number;
    no_custom_seo_meta: number;
    missing_barcode: number;
  };
  ga4?: Ga4;
  alerts?: { kind: string; title: string; admin_url?: string }[];
}

export interface EcomDaily extends FeedMeta {
  run_at: string;
  stores: DailyStore[];
  failed?: { slug: string; error: string }[];
}

// -- ecom_products ------------------------------------------------------------

export type ProductFlag =
  | 'ad_policy_excluded'
  | 'open_compliance_finding'
  | 'demand_but_out_of_stock'
  | 'no_visibility_yet'
  | 'no_custom_seo_meta'
  | 'not_on_online_store';

export interface Product {
  id: string;
  title: string;
  price: number;
  inventory: number;
  in_stock: boolean;
  url?: string;
  admin_url?: string;
  score: number;
  ad_policy: string | null;
  search?: { impressions?: number; clicks?: number; position?: number };
  traffic?: { sessions?: number; paid_sessions?: number; purchases?: number; revenue?: number };
  item?: { views?: number; add_to_cart?: number; purchased?: number; revenue?: number };
  flags: ProductFlag[];
}

export interface EcomProducts extends FeedMeta {
  run_at: string;
  stores: (StoreRef & { products: Product[] })[];
}

// -- ecom_seo_health ----------------------------------------------------------

export interface SeoIssue {
  severity: 'error' | 'warn' | 'info';
  code: string;
  detail?: string;
}

export interface SeoPage {
  url: string;
  kind: 'content' | 'product';
  status: number;
  issues: SeoIssue[];
  index?: { verdict?: string; coverage?: string };
}

export interface SeoStore extends StoreRef {
  site: {
    robots_txt: number;
    robots_has_sitemap: boolean;
    www_redirects_to_apex: boolean;
    missing_page_status: number;
  };
  pages_checked: number;
  issue_counts: Record<string, number>;
  index_summary: Record<string, number>;
  pages: SeoPage[];
}

export interface EcomSeoHealth extends FeedMeta {
  run_at: string;
  stores: SeoStore[];
}

// -- recommendations (briefing + ledger) --------------------------------------

export type RecCategory =
  | 'spend'
  | 'content'
  | 'seo_technical'
  | 'seo_page'
  | 'merchandising'
  | 'tracking'
  | 'compliance';

export type Decision = 'accepted' | 'rejected' | 'done';
export type RecStatus = 'open' | Decision | 'expired';

export interface Recommendation {
  id: string;
  store: string;
  category: RecCategory;
  priority: 1 | 2 | 3;
  title: string;
  target?: { type?: string; ref?: string; url?: string | null };
  action?: string;
  rationale?: string;
  expected_impact?: string;
  confidence?: string;
  effort?: string;
  owner?: string;
  spend?: { daily_budget_usd: number; change: string } | null;
}

export interface LedgerItem {
  id: string;
  created_at: string;
  store: string;
  category: RecCategory;
  priority: 1 | 2 | 3;
  title: string;
  detail: Recommendation;
  status: RecStatus;
  decided_at: string | null;
  note: string | null;
}

export interface EcomRecommendations extends FeedMeta {
  run_at: string;
  counts: Record<RecStatus, number>;
  acceptance_rate: number | null;
  open: LedgerItem[];
  recent_decided: LedgerItem[];
}

export type BriefingFocus = 'products' | 'growth' | 'technical';

export interface BriefingSection {
  focus: BriefingFocus;
  run_at: string;
  model?: string;
  headline?: string;
  model_error?: string;
  stores?: {
    slug: string;
    summary: string;
    top_targets?: { product_id: string; title: string; why: string; suggested_action: string }[];
  }[];
  recommendations?: Recommendation[];
  data_gaps?: string[];
}

export interface EcomBriefing extends FeedMeta {
  /** Spoken script(s) for the voice worker (contract v1.1). */
  speech?: SpeechBlock[];

  run_at: string;
  doc_version?: number;
  headline?: string;
  sections?: Partial<Record<BriefingFocus, BriefingSection>>;
}

// -- compliance_findings ------------------------------------------------------

export interface ComplianceFindings extends FeedMeta {
  /** Spoken script(s) for the voice worker (contract v1.1). */
  speech?: SpeechBlock[];

  run_at: string;
  /** v1.4 (0011 A12): `advisory` never counts in `open`. */
  counts: { open: number; new?: number; open_by_property?: Record<string, number>; advisory?: number };
  open_findings?: ComplianceFinding[];
  /** v1.4 (A12): spec-only findings on the writer's carried-over copy. */
  advisory_findings?: AdvisoryFinding[];
}

export interface ComplianceFinding {
  id: string;
  property: string;
  kind?: string;
  location?: string;
  link?: string;
  field?: string;
  quote?: string;
  rule?: string;
  reason?: string;
  first_seen?: string;
  /** v1.4 (A12): a finding the judge opened on writer copy by majority. */
  readings?: { flagged: number; of: number };
}

export interface AdvisoryFinding extends ComplianceFinding {
  advisory_reason: string;
  patch_id?: string;
}

// -- calls --------------------------------------------------------------------

export interface CommerceFeeds {
  ecom_daily: EcomDaily;
  ecom_products: EcomProducts;
  ecom_seo_health: EcomSeoHealth;
  ecom_briefing: EcomBriefing;
  ecom_recommendations: EcomRecommendations;
  compliance_findings: ComplianceFindings;
}

export type FeedName = keyof CommerceFeeds;

export const FEED_NAMES: FeedName[] = [
  'ecom_daily',
  'ecom_products',
  'ecom_seo_health',
  'ecom_briefing',
  'ecom_recommendations',
  'compliance_findings',
];

export type RefreshTarget =
  | 'ecom_daily'
  | 'ecom_seo_health'
  | 'ecom_briefing'
  | `ecom_briefing_${BriefingFocus}`;

/** A feed's document, or null when Hermes hasn't produced it yet (404). */
export async function fetchCommerceFeed<F extends FeedName>(
  feed: F,
): Promise<CommerceFeeds[F] | null> {
  const res = await apiFetch(`/api/commerce/${feed}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(res.status === 503 ? 'Hermes is unreachable' : `Failed: ${res.status}`);
  return res.json();
}

export async function requestCommerceRefresh(target: RefreshTarget): Promise<void> {
  const res = await apiFetch(`/api/commerce/${target}/refresh`, { method: 'POST' });
  if (!res.ok) throw new Error(`Refresh failed: ${res.status}`);
}

export async function decideRecommendation(
  id: string,
  decision: Decision,
  note?: string,
): Promise<void> {
  const trimmed = note?.trim();
  const res = await apiFetch(`/api/commerce/recommendations/${id}/${decision}`, {
    method: 'POST',
    ...(trimmed
      ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note: trimmed.slice(0, 500) }) }
      : {}),
  });
  if (!res.ok) {
    const detail = await res.json().then((b) => b?.detail).catch(() => null);
    throw new Error(detail ? String(detail) : `Decision failed: ${res.status}`);
  }
}
