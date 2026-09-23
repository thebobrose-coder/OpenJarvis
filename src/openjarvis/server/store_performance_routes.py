"""FastAPI route for the Store Performance panel -- live Shopify catalog
diff plus Google Search Console query performance, per configured store.

Unlike weather_routes.py's single-source pattern, each store combines two
independent sources that come online at different times, so nothing here
is all-or-nothing: each section reports its own `connected` flag and the
frontend renders whichever is/isn't available, per store.

Multi-store (2026-09-22): iterates every store in
connectors/shopify_stores.py's registry rather than one hardcoded
connector/site_url -- see that module for how stores get added (the Data
Sources "Add Store" flow).
"""

from __future__ import annotations

from datetime import datetime, timedelta

from fastapi import APIRouter

store_performance_router = APIRouter(
    prefix="/api/store-performance", tags=["store-performance"]
)


def _diff_catalog(today: list, yesterday: list) -> dict:
    """Compute new listings, price changes, and stockouts between two snapshots."""
    by_id_yesterday = {p["id"]: p for p in yesterday}
    yesterday_ids = set(by_id_yesterday.keys())

    new_today = [p for p in today if p["id"] not in yesterday_ids]
    price_changes = []
    stockouts = []
    for p in today:
        prev = by_id_yesterday.get(p["id"])
        if prev is None:
            continue
        if prev.get("price") != p.get("price"):
            price_changes.append(
                {
                    "title": p["title"],
                    "old_price": prev.get("price"),
                    "new_price": p.get("price"),
                }
            )
        prev_inventory = prev.get("inventory") or 0
        cur_inventory = p.get("inventory") or 0
        if prev_inventory > 0 and cur_inventory <= 0:
            stockouts.append({"title": p["title"]})

    return {
        "new_today": [{"title": p["title"], "price": p.get("price")} for p in new_today],
        "price_changes": price_changes,
        "stockouts": stockouts,
    }


def _get_shopify_section(store_slug: str) -> dict:
    from openjarvis.agents.shopify_snapshot_store import ShopifySnapshotStore
    from openjarvis.connectors.shopify import ShopifyConnector

    connector = ShopifyConnector(store_slug=store_slug)
    if not connector.is_connected():
        return {"connected": False}

    try:
        catalog = connector.fetch_catalog_snapshot()
    except Exception as exc:  # noqa: BLE001 -- surface as a soft error, not a 500
        return {"connected": True, "error": str(exc)}

    store = ShopifySnapshotStore()
    today_str = datetime.now().strftime("%Y-%m-%d")
    yesterday_str = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")

    if store.get_snapshot(store_slug, today_str) is None:
        store.save_snapshot(store_slug, today_str, catalog)

    yesterday_snapshot = store.get_snapshot(store_slug, yesterday_str)
    store.close()

    diff = (
        _diff_catalog(catalog, yesterday_snapshot)
        if yesterday_snapshot is not None
        else {"new_today": [], "price_changes": [], "stockouts": []}
    )

    return {
        "connected": True,
        "catalog_count": len(catalog),
        **diff,
    }


def _get_search_console_section(gsc_site_url: str) -> dict:
    if not gsc_site_url:
        return {"connected": False}

    from openjarvis.connectors.google_search_console import GoogleSearchConsoleConnector

    connector = GoogleSearchConsoleConnector()
    if not connector.is_connected():
        return {"connected": False}

    try:
        data = connector.fetch_search_analytics(gsc_site_url)
    except Exception as exc:  # noqa: BLE001 -- surface as a soft error, not a 500
        return {"connected": True, "error": str(exc)}

    return {"connected": True, **data}


@store_performance_router.get("")
async def get_store_performance() -> dict:
    """Return the latest Shopify catalog diff and Search Console query data
    for every configured store."""
    from openjarvis.connectors.shopify_stores import load_stores

    stores = []
    for slug, meta in load_stores().items():
        stores.append(
            {
                "slug": slug,
                "display_name": meta.get("display_name", slug),
                "shopify": _get_shopify_section(slug),
                "search_console": _get_search_console_section(
                    meta.get("gsc_site_url", "")
                ),
            }
        )
    return {"stores": stores}
