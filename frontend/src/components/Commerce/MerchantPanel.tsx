import { ShoppingBag } from 'lucide-react';
import type { AdsHold, AdsHoldFlight, MerchantHoldItem, MerchantStatus, MerchantStore, StoreRef } from '../../lib/commerce-api';
import type { Patch } from '../../lib/fixes-api';
import { isCollectionPatch, needsOperator } from '../../lib/fixes-api';
import { DashboardPanel, type PanelBand, type PanelSize } from '../Dashboard/DashboardPanel';
import { ALL_STORES, num, shortDateTime } from './format';
import { Chip, Quiet, Tile } from '../shared/ui';
import { SeverityChip } from './CompliancePanel';

/**
 * Merchant Center, read-only (contract v1.26.1, hq 0025 D6): one card per
 * store from `merchant_status`, and the Merchant part of each flight's ads
 * hold from `content_health.ads_hold`. Nothing here writes: there is no
 * Merchant action, and a disapproval links only to its existing Fixes entry.
 */

const READ_ONLY = 'READ_ONLY';

/** The principal is right only when Hermes read exactly READ_ONLY. */
export const roleOk = (role: string | null | undefined) => role === READ_ONLY;

/** A clip-side count: null means Foundry's snapshot doesn't carry it yet. */
export const WAITING_ON_FOUNDRY = 'waiting on Foundry';
export const clipCount = (n: number | null | undefined) => (n == null ? WAITING_ON_FOUNDRY : num(n));

/** An issue code or reporting context in words ("used or refurbished offers"). */
const codeWords = (code: string) => code.replace(/_/g, ' ').toLowerCase();

const count = (n: number | null | undefined) => (n == null ? '—' : num(n));

/** The Fixes entry for a product: one waiting on the operator first, else the newest. */
export function fixFor(
  patches: Pick<Patch, 'id' | 'product_id' | 'status' | 'created_at' | 'target'>[],
  productId?: string | null,
): string | null {
  if (!productId) return null;
  // v1.30: a collection patch (`collection:<n>`) never joins a product.
  const mine = patches.filter((p) => !isCollectionPatch(p) && String(p.product_id) === String(productId));
  if (!mine.length) return null;
  const ranked = [...mine].sort(
    (a, b) => Number(needsOperator(b.status)) - Number(needsOperator(a.status)) || b.created_at.localeCompare(a.created_at),
  );
  return ranked[0].id;
}

/** The Merchant lines among a flight's blockers ("no read yet", "no offer", ...). */
export const merchantBlockers = (f: AdsHoldFlight) => (f.unresolved ?? []).filter((u) => /Merchant Center/.test(u));

function StoreCard({ row, name }: { row: MerchantStore; name: string }) {
  const ok = roleOk(row.role_confirmed);
  const vc = row.video_coverage ?? null;
  const contexts = Object.entries(row.disapproved_by_context ?? {}).filter(([, n]) => n > 0);
  return (
    <div
      className="flex flex-col gap-2 rounded-lg p-3"
      style={{ border: `1px solid ${ok ? 'var(--color-border)' : 'var(--color-error)'}` }}
      data-merchant-store={row.store}
      data-role-ok={ok ? 'true' : 'false'}
    >
      <div className="flex items-center gap-2 flex-wrap text-ui-12">
        <span className="font-medium" style={{ color: 'var(--color-text)' }}>{name}</span>
        <span data-role={row.role_confirmed ?? ''}>
          {ok ? (
            <Chip tone="success" title="Hermes reads Merchant Center with a read-only principal">READ_ONLY</Chip>
          ) : (
            <Chip
              tone="error"
              title="The principal is misconfigured: fix its role in Merchant Center, not here"
            >
              {row.role_confirmed ? `role ${row.role_confirmed}` : 'role unknown'}
            </Chip>
          )}
        </span>
        <span className="ml-auto text-ui-11" style={{ color: 'var(--color-text-tertiary)' }}>
          {row.last_checked ? `checked ${shortDateTime(row.last_checked)}` : 'never checked'}
        </span>
      </div>

      {!ok && (
        <Quiet>
          Hermes saw the role {row.role_confirmed ? `“${row.role_confirmed}”` : 'as missing'}, not Read only, so it read nothing.
          Fix the principal in Merchant Center.
        </Quiet>
      )}
      {row.error && (
        <div className="text-ui-11-5" style={{ color: 'var(--color-warning)' }} data-merchant-error>
          Last read failed: {row.error}
        </div>
      )}

      <div className="flex flex-col gap-2" style={ok ? undefined : { opacity: 0.45 }} aria-disabled={ok ? undefined : true}>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Tile label="Offers" value={count(row.offers_total)} />
          <Tile
            label="Approved"
            value={count(row.approved)}
            sub={row.limited ? `${num(row.limited)} limited` : undefined}
          />
          <Tile label="Pending" value={count(row.pending)} />
          <Tile label="Disapproved" value={count(row.disapproved)} subTone="error" sub={row.disapproved ? 'approved nowhere' : undefined} />
        </div>

        {row.limited ? (
          <Quiet>
            Limited: approved somewhere, disapproved in some context
            {contexts.length ? ` (${contexts.map(([c, n]) => `${codeWords(c)} ${num(n)}`).join(', ')})` : ''}.
          </Quiet>
        ) : null}

        <div className="flex flex-col gap-1">
          <span className="text-ui-10 uppercase tracking-wide" style={{ color: 'var(--color-text-tertiary)' }}>
            Video coverage
          </span>
          <table className="w-full text-ui-12 tabular-nums" data-video-coverage>
            <tbody>
              {(
                [
                  ['Offers with a video link', count(vc?.offers_with_video ?? row.with_video)],
                  ['Products with video', count(vc?.products_with_video)],
                  ['Products with a published clip', clipCount(vc?.clips_in_feed)],
                  ['Clips still under review', clipCount(vc?.clips_under_review)],
                  ['Products with a clip, no video link', clipCount(vc?.products_clip_no_video)],
                ] as const
              ).map(([label, value], i) => (
                <tr key={label} style={{ borderTop: i ? '1px solid var(--color-border)' : undefined }}>
                  <td className="py-1 px-2" style={{ color: 'var(--color-text-secondary)' }}>{label}</td>
                  <td
                    className="py-1 px-2 text-right"
                    style={{ color: value === WAITING_ON_FOUNDRY ? 'var(--color-text-tertiary)' : 'var(--color-text)' }}
                  >
                    {value}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {(row.top_issues ?? []).length > 0 && (
          <div className="flex flex-col gap-1">
            <span className="text-ui-10 uppercase tracking-wide" style={{ color: 'var(--color-text-tertiary)' }}>
              Top issues
            </span>
            <table className="w-full text-ui-12 tabular-nums">
              <tbody>
                {(row.top_issues ?? []).map((t, i) => (
                  <tr key={`${t.code}-${i}`} style={{ borderTop: i ? '1px solid var(--color-border)' : undefined }} data-issue={t.code}>
                    <td className="py-1 px-2" style={{ color: 'var(--color-text)' }}>{codeWords(t.code)}</td>
                    <td className="py-1 px-2">
                      {t.severity && (
                        <Chip tone={t.severity === 'DISAPPROVED' ? 'warning' : 'muted'}>{codeWords(t.severity)}</Chip>
                      )}
                    </td>
                    <td className="py-1 px-2 text-right">{num(t.count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function HoldItem({
  item,
  flight,
  patches,
  onOpenFix,
}: {
  item: MerchantHoldItem;
  flight: AdsHoldFlight;
  patches: Patch[];
  onOpenFix?: (id: string) => void;
}) {
  const productId = flight.targets?.find((t) => t.kind === 'product' && t.target === item.handle)?.product_id;
  const fix = onOpenFix ? fixFor(patches, productId) : null;
  return (
    <li className="flex items-center gap-2 flex-wrap text-ui-12" data-hold-item={item.handle}>
      <SeverityChip severity={item.severity === 'block' || item.severity === 'fix' ? item.severity : undefined} />
      {fix ? (
        <button
          onClick={() => onOpenFix?.(fix)}
          data-open-fix={fix}
          title="Open this product's Fixes entry"
          className="cursor-pointer underline"
          style={{ background: 'transparent', border: 'none', padding: 0, color: 'var(--color-accent)' }}
        >
          {item.handle}
        </button>
      ) : (
        <span style={{ color: 'var(--color-text)' }}>{item.handle}</span>
      )}
      <span style={{ color: 'var(--color-text-secondary)' }}>{item.codes.map(codeWords).join(', ')}</span>
      {item.contexts.length > 0 && (
        <span style={{ color: 'var(--color-text-tertiary)' }}>in {item.contexts.map(codeWords).join(', ')}</span>
      )}
      <span className="tabular-nums" style={{ color: 'var(--color-text-tertiary)' }}>
        {num(item.offers)} of {num(item.offers_total)} offers
      </span>
    </li>
  );
}

export function HoldFlight({
  id,
  flight,
  patches,
  onOpenFix,
}: {
  id: string;
  flight: AdsHoldFlight;
  patches: Patch[];
  onOpenFix?: (id: string) => void;
}) {
  const m = flight.merchant;
  const blockers = merchantBlockers(flight);
  return (
    <li className="flex flex-col gap-1" data-flight={id}>
      <div className="flex items-center gap-2 flex-wrap text-ui-12">
        <span className="font-medium" style={{ color: 'var(--color-text)' }}>{id}</span>
        <span data-verdict={flight.verdict}>
          <Chip tone={flight.verdict === 'clear' ? 'success' : 'error'}>{flight.verdict}</Chip>
        </span>
        {m && (
          <span data-merchant-role={m.role_confirmed ?? ''}>
            <Chip tone={roleOk(m.role_confirmed) ? 'muted' : 'error'}>
              Merchant {roleOk(m.role_confirmed) ? 'read only' : `role ${m.role_confirmed ?? 'unknown'}`}
            </Chip>
          </span>
        )}
      </div>
      <div className="text-ui-11-5" style={{ color: 'var(--color-text-tertiary)' }} data-scope>
        Scope: {flight.scope}
      </div>
      {m &&
        (m.items.length === 0 && blockers.length === 0 ? (
          <div className="text-ui-11-5" style={{ color: 'var(--color-text-secondary)' }}>
            Merchant Center: no disapproved target.
          </div>
        ) : (
          <ul className="flex flex-col gap-1 pl-2">
            {m.items.map((item, i) => (
              <HoldItem key={`${item.handle}-${i}`} item={item} flight={flight} patches={patches} onOpenFix={onOpenFix} />
            ))}
            {blockers.map((b) => (
              <li key={b} className="text-ui-11-5" style={{ color: 'var(--color-warning)' }} data-merchant-blocker>
                {b}
              </li>
            ))}
          </ul>
        ))}
    </li>
  );
}

export interface MerchantPanelProps {
  merchant: MerchantStatus | null;
  selectedStore: string;
  /** The page's stores (from ecom_daily): one without a row has no principal yet. */
  stores: StoreRef[];
  adsHold?: AdsHold | null;
  /** catalog_fixes patches, for the disapproval → Fixes link. */
  patches?: Patch[];
  onOpenFix?: (id: string) => void;
  /** The ads hold by flight; false on the Overview, where Ads & flights owns it. */
  flights?: boolean;
  size?: PanelSize;
  band?: PanelBand;
  loading?: boolean;
  error?: string | null;
}

export function MerchantPanel({
  merchant,
  selectedStore,
  stores,
  adsHold,
  patches = [],
  onOpenFix,
  flights: showFlights = true,
  size = 'full',
  band,
  loading,
  error,
}: MerchantPanelProps) {
  const rows = (merchant?.stores ?? []).filter((r) => selectedStore === ALL_STORES || r.store === selectedStore);
  const names = Object.fromEntries(stores.map((s) => [s.slug, s.display_name]));
  const covered = new Set((merchant?.stores ?? []).map((r) => r.store));
  const missing = stores.filter((s) => !covered.has(s.slug) && (selectedStore === ALL_STORES || s.slug === selectedStore));
  const flights = showFlights ? Object.entries(adsHold?.flights ?? {}) : [];

  return (
    <DashboardPanel icon={ShoppingBag} title="Merchant Center" tag="read only" size={size} band={band} loading={loading && !merchant} error={error}>
      <div className="flex flex-col gap-3">
        {!merchant ? (
          <Quiet>No Merchant Center read yet.</Quiet>
        ) : rows.length === 0 && missing.length === 0 ? (
          <Quiet>No Merchant Center read for this store.</Quiet>
        ) : (
          <div className={`grid grid-cols-1 ${size === 'full' ? 'lg:grid-cols-2' : '3xl:grid-cols-2'} gap-3`}>
            {rows.map((r) => (
              <StoreCard key={r.store} row={r} name={r.display_name || names[r.store] || r.store} />
            ))}
          </div>
        )}
        {merchant && missing.length > 0 && (
          <Quiet>
            No Merchant Center principal yet for {missing.map((s) => s.display_name || s.slug).join(', ')}.
          </Quiet>
        )}

        {flights.length > 0 && (
          <div className="flex flex-col gap-1.5" data-ads-hold>
            <span className="text-ui-10 uppercase tracking-wide" style={{ color: 'var(--color-text-tertiary)' }}>
              Ads hold by flight
            </span>
            <ul className="flex flex-col gap-2">
              {flights.map(([id, f]) => (
                <HoldFlight key={id} id={id} flight={f} patches={patches} onOpenFix={onOpenFix} />
              ))}
            </ul>
          </div>
        )}
      </div>
    </DashboardPanel>
  );
}
