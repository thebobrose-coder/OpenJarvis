import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Package, Search } from 'lucide-react';
import type { EcomProducts, Product, ProductFlag } from '../../lib/commerce-api';
import { DashboardPanel } from '../Dashboard/DashboardPanel';
import { ALL_STORES, money, num, storesFor } from './format';
import { Chip, ExtIcon, ExtLink, Quiet, Select, SmallButton, type Tone } from './ui';

const PAGE = 50;

const FLAG: Record<ProductFlag, { label: string; tone: Tone }> = {
  ad_policy_excluded: { label: 'ad policy', tone: 'muted' },
  open_compliance_finding: { label: 'compliance', tone: 'warning' },
  demand_but_out_of_stock: { label: 'demand, no stock', tone: 'warning' },
  no_visibility_yet: { label: 'no visibility yet', tone: 'neutral' },
  no_custom_seo_meta: { label: 'no SEO meta', tone: 'neutral' },
  not_on_online_store: { label: 'not on store', tone: 'neutral' },
};

type Row = Product & { store: string; storeName: string };

type SortKey =
  | 'score' | 'title' | 'price' | 'inventory' | 'impressions' | 'clicks' | 'position'
  | 'paid_sessions' | 'add_to_cart' | 'purchases' | 'revenue';

const VALUE: Record<SortKey, (r: Row) => number | string> = {
  score: (r) => r.score,
  title: (r) => r.title.toLowerCase(),
  price: (r) => r.price,
  inventory: (r) => r.inventory,
  impressions: (r) => r.search?.impressions ?? 0,
  clicks: (r) => r.search?.clicks ?? 0,
  // No position sorts last whichever way.
  position: (r) => r.search?.position || Number.MAX_SAFE_INTEGER,
  paid_sessions: (r) => r.traffic?.paid_sessions ?? 0,
  add_to_cart: (r) => r.item?.add_to_cart ?? 0,
  purchases: (r) => r.item?.purchased ?? r.traffic?.purchases ?? 0,
  revenue: (r) => r.item?.revenue ?? r.traffic?.revenue ?? 0,
};

const COLUMNS: { key: SortKey; label: string; title?: string; numeric?: boolean }[] = [
  { key: 'score', label: 'Score', title: 'Ad-attention score (0 when excluded or flagged)', numeric: true },
  { key: 'title', label: 'Product' },
  { key: 'price', label: 'Price', numeric: true },
  { key: 'inventory', label: 'Stock', numeric: true },
  { key: 'impressions', label: 'Impr.', title: 'Search impressions (28 d)', numeric: true },
  { key: 'clicks', label: 'Clicks', title: 'Search clicks (28 d)', numeric: true },
  { key: 'position', label: 'Pos.', title: 'Average search position', numeric: true },
  { key: 'paid_sessions', label: 'Paid', title: 'Paid sessions (GA4)', numeric: true },
  { key: 'add_to_cart', label: 'Cart', title: 'Add-to-cart (GA4)', numeric: true },
  { key: 'purchases', label: 'Buys', title: 'Purchases (GA4)', numeric: true },
  { key: 'revenue', label: 'Revenue', title: 'Revenue (GA4)', numeric: true },
];

export function ProductsTable({
  products,
  selectedStore,
  currencyBySlug,
  loading,
  error,
}: {
  products: EcomProducts | null;
  selectedStore: string;
  currencyBySlug: Record<string, string | null>;
  loading?: boolean;
  error?: string | null;
}) {
  const [query, setQuery] = useState('');
  const [eligibleOnly, setEligibleOnly] = useState(false);
  const [flag, setFlag] = useState<'all' | ProductFlag>('all');
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'score', desc: true });
  const [shown, setShown] = useState(PAGE);

  const rows = useMemo<Row[]>(
    () =>
      storesFor(products?.stores, selectedStore).flatMap((s) =>
        s.products.map((p) => ({ ...p, store: s.slug, storeName: s.display_name })),
      ),
    [products, selectedStore],
  );
  const flagsPresent = useMemo(
    () => [...new Set(rows.flatMap((r) => r.flags))].sort() as ProductFlag[],
    [rows],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out = rows.filter(
      (r) =>
        (!q || r.title.toLowerCase().includes(q)) &&
        (!eligibleOnly || !r.flags.includes('ad_policy_excluded')) &&
        (flag === 'all' || r.flags.includes(flag)),
    );
    const get = VALUE[sort.key];
    return out.sort((a, b) => {
      const x = get(a);
      const y = get(b);
      const c = typeof x === 'string' ? x.localeCompare(y as string) : (x as number) - (y as number);
      return sort.desc ? -c : c;
    });
  }, [rows, query, eligibleOnly, flag, sort]);

  const setSortKey = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: key !== 'title' && key !== 'position' }));
  const multiStore = selectedStore === ALL_STORES && (products?.stores.length ?? 0) > 1;

  return (
    <DashboardPanel icon={Package} title="Products" tag={products ? `${filtered.length} of ${rows.length}` : undefined} size="full" loading={loading} error={error}>
      {!products ? (
        <Quiet>No product data yet -- Hermes scores products daily.</Quiet>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <label
              className="flex items-center gap-1.5 rounded-md px-2 py-1"
              style={{ background: 'var(--color-bg-secondary)', border: '1px solid var(--color-border)' }}
            >
              <Search size={12} style={{ color: 'var(--color-text-tertiary)' }} />
              <input
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setShown(PAGE);
                }}
                placeholder="Search products"
                className="bg-transparent outline-none text-[12px] w-48"
                style={{ color: 'var(--color-text)' }}
              />
            </label>
            <label className="flex items-center gap-1.5 text-[11.5px] cursor-pointer" style={{ color: 'var(--color-text-secondary)' }}>
              <input type="checkbox" checked={eligibleOnly} onChange={(e) => setEligibleOnly(e.target.checked)} />
              Ad-eligible only
            </label>
            <Select
              label="Flag"
              value={flag}
              onChange={setFlag}
              options={[{ value: 'all', label: 'Any' }, ...flagsPresent.map((f) => ({ value: f, label: FLAG[f]?.label ?? f }))]}
            />
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-[12px] tabular-nums">
              <thead>
                <tr style={{ color: 'var(--color-text-tertiary)' }}>
                  {COLUMNS.map((c) => (
                    <th
                      key={c.key}
                      className={`py-1.5 px-2 font-medium whitespace-nowrap ${c.numeric ? 'text-right' : 'text-left'}`}
                      title={c.title}
                      aria-sort={sort.key === c.key ? (sort.desc ? 'descending' : 'ascending') : 'none'}
                    >
                      <button
                        onClick={() => setSortKey(c.key)}
                        className="inline-flex items-center gap-0.5 cursor-pointer"
                        style={{ background: 'transparent', border: 'none', padding: 0, color: 'inherit', font: 'inherit' }}
                      >
                        {c.label}
                        {sort.key === c.key && (sort.desc ? <ArrowDown size={10} /> : <ArrowUp size={10} />)}
                      </button>
                    </th>
                  ))}
                  <th className="py-1.5 px-2 font-medium text-left">Flags</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, shown).map((r) => (
                  <tr key={`${r.store}-${r.id}`} style={{ borderTop: '1px solid var(--color-border)' }}>
                    <td className="py-1.5 px-2 text-right" style={{ color: r.score ? 'var(--color-text)' : 'var(--color-text-tertiary)' }}>
                      {num(r.score, 1)}
                    </td>
                    <td className="py-1.5 px-2 max-w-[18rem]">
                      <div className="truncate" style={{ color: 'var(--color-text)' }}>
                        <ExtLink url={r.url} title="Open in the storefront">{r.title}</ExtLink>
                      </div>
                      {multiStore && (
                        <div className="text-[10.5px]" style={{ color: 'var(--color-text-tertiary)' }}>{r.storeName}</div>
                      )}
                    </td>
                    <td className="py-1.5 px-2 text-right">{money(r.price, currencyBySlug[r.store])}</td>
                    <td className="py-1.5 px-2 text-right" style={{ color: r.in_stock ? undefined : 'var(--color-warning)' }}>
                      {r.in_stock ? num(r.inventory) : 'out'}
                    </td>
                    <td className="py-1.5 px-2 text-right">{num(r.search?.impressions)}</td>
                    <td className="py-1.5 px-2 text-right">{num(r.search?.clicks)}</td>
                    <td className="py-1.5 px-2 text-right">{r.search?.position ? num(r.search.position, 1) : '—'}</td>
                    <td className="py-1.5 px-2 text-right">{num(r.traffic?.paid_sessions)}</td>
                    <td className="py-1.5 px-2 text-right">{num(r.item?.add_to_cart)}</td>
                    <td className="py-1.5 px-2 text-right">{num(r.item?.purchased ?? r.traffic?.purchases)}</td>
                    <td className="py-1.5 px-2 text-right">{money(r.item?.revenue ?? r.traffic?.revenue ?? 0, currencyBySlug[r.store])}</td>
                    <td className="py-1.5 px-2 min-w-[13rem]">
                      <div className="flex flex-wrap gap-1">
                        {r.flags.map((f) => (
                          <Chip
                            key={f}
                            tone={FLAG[f]?.tone ?? 'neutral'}
                            title={f === 'ad_policy_excluded' && r.ad_policy ? r.ad_policy : undefined}
                          >
                            {FLAG[f]?.label ?? f}
                          </Chip>
                        ))}
                      </div>
                    </td>
                    <td className="py-1.5 px-2">
                      <ExtIcon url={r.admin_url} title="Open in Shopify admin" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {filtered.length === 0 && <Quiet>No products match.</Quiet>}
          {filtered.length > shown && (
            <div>
              <SmallButton onClick={() => setShown((n) => n + PAGE)}>
                Show {Math.min(PAGE, filtered.length - shown)} more
              </SmallButton>
            </div>
          )}
        </div>
      )}
    </DashboardPanel>
  );
}
