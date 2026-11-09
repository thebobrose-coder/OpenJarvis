import { SearchCheck } from 'lucide-react';
import { crawlComplete, type EcomSeoHealth, type SeoCollections, type SeoCrawl, type SeoPage, type SeoStore } from '../../lib/commerce-api';
import { DashboardPanel } from '../Dashboard/DashboardPanel';
import { num, shortDateTime, storesFor } from './format';
import { Chip, ExtLink, Quiet, type Tone } from '../shared/ui';

const SEVERITY_RANK = { error: 0, warn: 1, info: 2 } as const;
const SEVERITY_TONE: Record<string, Tone> = { error: 'warning', warn: 'neutral', info: 'muted' };

function siteChecks(site: SeoStore['site']): { label: string; ok: boolean; title: string }[] {
  return [
    { label: 'robots.txt', ok: site.robots_txt === 200, title: `robots.txt returned ${site.robots_txt}` },
    { label: 'sitemap in robots', ok: site.robots_has_sitemap, title: 'robots.txt lists the sitemap' },
    { label: 'www → apex', ok: site.www_redirects_to_apex, title: 'www redirects to the bare domain' },
    { label: 'real 404', ok: site.missing_page_status === 404, title: `a missing page returns ${site.missing_page_status}` },
  ];
}

/** Codes seen on errors sort first, then by count. */
function orderedCounts(store: SeoStore): { code: string; n: number; severity: string }[] {
  const worst: Record<string, string> = {};
  for (const p of store.pages) {
    for (const i of p.issues) {
      const cur = worst[i.code];
      if (!cur || SEVERITY_RANK[i.severity] < SEVERITY_RANK[cur as keyof typeof SEVERITY_RANK]) worst[i.code] = i.severity;
    }
  }
  return Object.entries(store.issue_counts)
    .map(([code, n]) => ({ code, n, severity: worst[code] ?? 'info' }))
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.severity as keyof typeof SEVERITY_RANK] - SEVERITY_RANK[b.severity as keyof typeof SEVERITY_RANK] ||
        b.n - a.n,
    );
}

function pageWeight(p: SeoPage): number {
  return p.issues.reduce((w, i) => w + (i.severity === 'error' ? 100 : i.severity === 'warn' ? 10 : 1), 0);
}

const INCOMPLETE_TITLE = 'Under 90 % read, or the audit gave up on a host: its counts may understate, and nothing closes on it.';

/** One crawl's reach: `read/total`, the give-ups, and an incomplete chip
 * under the complete-crawl rule (90 % read, never while `partial`). */
function CrawlLine({ label, crawl, children }: { label: string; crawl: SeoCrawl & { complete?: boolean }; children?: React.ReactNode }) {
  const complete = crawlComplete(crawl);
  const gaveUp = crawl.gave_up ?? [];
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-ui-11-5" data-crawl={label} data-complete={complete}>
      <span>
        {label}: {num(crawl.read)}/{num(crawl.total)} read
      </span>
      {!complete && (
        <Chip tone="warning" title={INCOMPLETE_TITLE}>
          incomplete
        </Chip>
      )}
      {crawl.partial && <Chip tone="warning" title="The run gave up on a host, so this crawl counts as incomplete">partial</Chip>}
      {gaveUp.map((g) => (
        <Chip key={g.host} tone="muted" title={g.attempted != null ? `refused ${g.refused ?? '?'} of ${g.attempted} pages (rule ${g.rule ?? '?'})` : undefined}>
          gave up on {g.host}
        </Chip>
      ))}
      {children}
    </div>
  );
}

function CollectionsLine({ c }: { c: SeoCollections }) {
  const counts = Object.entries(c.issue_counts ?? {}).filter(([, n]) => n > 0);
  return (
    <CrawlLine label="Collections" crawl={c}>
      {counts.map(([code, n]) => (
        <span key={code} data-collection-issue={code}>
          <Chip tone="neutral">
            {code.replace(/_/g, ' ')} · {num(n)}
          </Chip>
        </span>
      ))}
      {c.error && <span style={{ color: 'var(--color-warning)' }}>{c.error}</span>}
    </CrawlLine>
  );
}

function StoreHealth({ store, showName }: { store: SeoStore; showName: boolean }) {
  const worstPages = [...store.pages].sort((a, b) => pageWeight(b) - pageWeight(a)).slice(0, 15);
  return (
    <div className="flex flex-col gap-2 rounded-lg p-3" style={{ background: 'var(--color-bg-secondary)' }}>
      {showName && (
        <span className="text-ui-11 font-semibold uppercase tracking-wide" style={{ color: 'var(--color-text-tertiary)' }}>
          {store.display_name}
        </span>
      )}
      <div className="flex flex-wrap gap-1.5">
        {siteChecks(store.site).map((c) => (
          <Chip key={c.label} tone={c.ok ? 'success' : 'warning'} title={c.title}>
            {c.ok ? '✓' : '✗'} {c.label}
          </Chip>
        ))}
      </div>
      <div className="text-ui-11-5">
        {num(store.pages_checked)} pages checked · index:{' '}
        {Object.entries(store.index_summary)
          .map(([verdict, n]) => `${num(n)} ${verdict.toLowerCase()}`)
          .join(', ') || '—'}
      </div>
      {store.product_crawl && <CrawlLine label="Products" crawl={store.product_crawl} />}
      {store.collections && <CollectionsLine c={store.collections} />}
      <div className="flex flex-wrap gap-1">
        {orderedCounts(store).map((c) => (
          <Chip key={c.code} tone={SEVERITY_TONE[c.severity]} title={`${c.severity}`}>
            {c.code.replace(/_/g, ' ')} · {num(c.n)}
          </Chip>
        ))}
      </div>
      {worstPages.length > 0 && (
        <details className="text-ui-11-5">
          <summary className="cursor-pointer" style={{ color: 'var(--color-text-tertiary)' }}>
            Worst pages ({worstPages.length} of {store.pages.length} with issues)
          </summary>
          <ul className="mt-2 flex flex-col gap-2">
            {worstPages.map((p) => (
              <li key={p.url} className="flex flex-col gap-0.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="truncate max-w-[26rem]" style={{ color: 'var(--color-text)' }}>
                    <ExtLink url={p.url}>{p.url.replace(/^https?:\/\//, '')}</ExtLink>
                  </span>
                  <Chip tone="muted">{p.kind}</Chip>
                  {p.index?.verdict && <Chip tone={p.index.verdict === 'PASS' ? 'success' : 'neutral'} title={p.index.coverage}>{p.index.verdict.toLowerCase()}</Chip>}
                </div>
                <ul className="pl-3 flex flex-col">
                  {p.issues.map((i, k) => (
                    <li key={k}>
                      <span style={{ color: i.severity === 'error' ? 'var(--color-warning)' : 'var(--color-text-tertiary)' }}>
                        {i.severity}
                      </span>{' '}
                      {i.code.replace(/_/g, ' ')}
                      {i.detail ? ` -- ${i.detail}` : ''}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export function SeoHealthPanel({
  seo,
  selectedStore,
  loading,
  error,
}: {
  seo: EcomSeoHealth | null;
  selectedStore: string;
  loading?: boolean;
  error?: string | null;
}) {
  const stores = storesFor(seo?.stores, selectedStore);
  return (
    <DashboardPanel icon={SearchCheck} title="SEO health" tag={seo ? `audit ${shortDateTime(seo.run_at)}` : 'Weekly'} size="half" band="short" loading={loading} error={error}>
      {!seo ? (
        <Quiet>No SEO audit yet -- Hermes runs it on Sundays.</Quiet>
      ) : (
        <div className="flex flex-col gap-3">
          {stores.map((s) => (
            <StoreHealth key={s.slug} store={s} showName={stores.length > 1} />
          ))}
        </div>
      )}
    </DashboardPanel>
  );
}
