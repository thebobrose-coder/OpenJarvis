"""Registry of configured Shopify stores, and dynamic per-store connector
registration.

ShopifyConnector isn't registered at class-definition time (unlike every
other connector in this package) because the store list itself is dynamic
-- created through the "Add Store" flow in Data Sources, not known until
runtime. Each store gets its own ConnectorRegistry entry
("shopify_{slug}"), so Data Sources shows one connect/disconnect card per
store and each store's OAuth flow (server/shopify_oauth_routes.py) is
fully independent, using the same generic registry/instance-caching
machinery every other connector already goes through
(server/connectors_router.py's _get_or_create etc. -- confirmed those are
plain string-keyed dicts with no allowlist, so a dynamic connector_id works
identically to a static one).
"""

from __future__ import annotations

import json
import re
from functools import partial
from pathlib import Path
from typing import Dict

from openjarvis.connectors.shopify import ShopifyConnector
from openjarvis.core.paths import get_config_dir
from openjarvis.core.registry import ConnectorRegistry

_STORES_PATH = get_config_dir() / "shopify_stores.json"


def _slugify(display_name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", display_name.strip().lower()).strip("-")
    return slug or "store"


def load_stores() -> Dict[str, Dict[str, str]]:
    """Return {slug: {"display_name": ..., "gsc_site_url": ...}}."""
    try:
        data = json.loads(_STORES_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _save_stores(stores: Dict[str, Dict[str, str]]) -> None:
    from openjarvis.security.file_utils import secure_write_json

    secure_write_json(_STORES_PATH, stores)


def _register_store(slug: str, display_name: str) -> None:
    connector_id = f"shopify_{slug}"
    if ConnectorRegistry.contains(connector_id):
        return
    ConnectorRegistry.register(connector_id)(
        partial(ShopifyConnector, store_slug=slug, display_name=display_name)
    )


def add_store(display_name: str, gsc_site_url: str = "") -> str:
    """Create a new store entry and register its connector. Returns the slug."""
    display_name = display_name.strip()
    if not display_name:
        raise ValueError("A store display name is required")

    stores = load_stores()
    base_slug = _slugify(display_name)
    slug = base_slug
    n = 2
    while slug in stores or ConnectorRegistry.contains(f"shopify_{slug}"):
        slug = f"{base_slug}-{n}"
        n += 1

    stores[slug] = {"display_name": display_name, "gsc_site_url": gsc_site_url.strip()}
    _save_stores(stores)
    _register_store(slug, display_name)
    return slug


def remove_store(slug: str) -> None:
    """Forget a store. Its connector stays registered for this process's
    lifetime (RegistryBase has no unregister -- only clear(), which would
    wipe every connector, not just this one); its card in Data Sources
    will show as disconnected once its credentials are cleared separately
    via ShopifyConnector(store_slug=slug).disconnect(), and disappear on
    the next app restart."""
    stores = load_stores()
    stores.pop(slug, None)
    _save_stores(stores)


def register_all_configured_stores() -> None:
    """Register every already-configured store's connector. Called once at
    package import time (connectors/__init__.py) -- idempotent, safe to
    call again (e.g. after add_store, though add_store already registers
    its own new entry directly)."""
    for slug, meta in load_stores().items():
        _register_store(slug, meta.get("display_name", slug))
