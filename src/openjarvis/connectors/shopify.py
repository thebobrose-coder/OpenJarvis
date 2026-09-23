"""Shopify connector — read-only Admin API catalog access.

Multi-store: one ShopifyConnector instance per configured store, each with
its own credentials file (connectors/shopify_{store_slug}.json) and its own
registry entry ("shopify_{store_slug}"), registered dynamically at runtime
by connectors/shopify_stores.py rather than the usual class-level
@ConnectorRegistry.register decorator -- the store list isn't known until
the "Add Store" flow (Data Sources) creates one. This class stays agnostic
of *how many* stores exist; it just needs a slug to know which file is its
own.

erebus-audit (the app type used for each store) was created via the
Partners dev dashboard, not Shopify Admin's "Develop apps" page -- that app
type has no static Admin API access token at all; it only supports the
standard OAuth 2.0 authorization-code flow (see
server/shopify_oauth_routes.py for the start/callback endpoints). Access
tokens minted this way for "offline" access (what this app requests) don't
expire and have no refresh token, so unlike the Google connectors there's
no refresh step needed once connected.

All API calls are in module-level functions for easy mocking in tests.
Scope: read_products, read_inventory only -- no order/customer data, no
write capability.
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional

import httpx

from openjarvis.connectors._stubs import BaseConnector, Document, SyncStatus
from openjarvis.core.paths import get_config_dir

_API_VERSION = "2025-01"

_PRODUCTS_QUERY = """
query Products($first: Int!, $after: String) {
  products(first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      title
      status
      totalInventory
      tags
      seo { title description }
      priceRangeV2 { minVariantPrice { amount currencyCode } }
    }
  }
}
"""


class ShopifyAPIError(RuntimeError):
    """A credential-safe error returned by the Shopify Admin API."""


def _normalize_shop_domain(shop_domain: str) -> str:
    domain = shop_domain.strip().lower()
    for prefix in ("https://", "http://"):
        if domain.startswith(prefix):
            domain = domain[len(prefix) :]
    return domain.rstrip("/")


def _shopify_graphql(
    shop_domain: str, access_token: str, query: str, variables: Dict[str, Any]
) -> Dict[str, Any]:
    """Execute a GraphQL query against the Shopify Admin API."""
    url = f"https://{shop_domain}/admin/api/{_API_VERSION}/graphql.json"
    try:
        resp = httpx.post(
            url,
            headers={
                "X-Shopify-Access-Token": access_token,
                "Content-Type": "application/json",
            },
            json={"query": query, "variables": variables},
            timeout=30.0,
        )
        resp.raise_for_status()
        payload = resp.json()
    except httpx.HTTPStatusError as exc:
        status = exc.response.status_code
        if status == 401:
            raise ShopifyAPIError("Shopify rejected the access token") from None
        raise ShopifyAPIError(f"Shopify returned HTTP {status}") from None
    except httpx.RequestError:
        raise ShopifyAPIError("Shopify could not be reached") from None
    except (TypeError, ValueError):
        raise ShopifyAPIError("Shopify returned an invalid JSON response") from None

    if "errors" in payload:
        raise ShopifyAPIError(f"Shopify GraphQL error: {payload['errors']}")
    return payload["data"]


def _fetch_all_products(
    shop_domain: str, access_token: str, *, page_size: int = 50
) -> List[Dict[str, Any]]:
    """Page through the full product catalog."""
    products: List[Dict[str, Any]] = []
    cursor: Optional[str] = None
    while True:
        data = _shopify_graphql(
            shop_domain,
            access_token,
            _PRODUCTS_QUERY,
            {"first": page_size, "after": cursor},
        )
        page = data["products"]
        products.extend(page["nodes"])
        if not page["pageInfo"]["hasNextPage"]:
            break
        cursor = page["pageInfo"]["endCursor"]
    return products


class ShopifyConnector(BaseConnector):
    """Read-only catalog access to one Shopify store via OAuth 2.0.

    Not registered at class-definition time (see module docstring) --
    connectors/shopify_stores.py registers one instance per configured
    store under "shopify_{store_slug}" once that store exists.
    """

    connector_id = "shopify"  # fallback only; real registry key is per-store
    display_name = "Shopify"
    auth_type = "oauth"

    def __init__(
        self,
        *,
        store_slug: str = "",
        display_name: str = "",
        token_path: Optional[str] = None,
    ) -> None:
        self._store_slug = store_slug
        if display_name:
            self.display_name = f"Shopify — {display_name}"
        filename = f"shopify_{store_slug}.json" if store_slug else "shopify.json"
        self._token_path = (
            Path(token_path)
            if token_path is not None
            else get_config_dir() / "connectors" / filename
        )
        self._status = SyncStatus()

    @property
    def store_slug(self) -> str:
        return self._store_slug

    def _load_config(self) -> Dict[str, str]:
        return json.loads(self._token_path.read_text(encoding="utf-8"))

    def _save_config(self, updates: Dict[str, str]) -> None:
        from openjarvis.security.file_utils import secure_write_json

        try:
            config = self._load_config()
        except (json.JSONDecodeError, OSError):
            config = {}
        config.update(updates)
        secure_write_json(self._token_path, config)

    def stored_access_token(self) -> Optional[str]:
        try:
            value = self._load_config().get("access_token", "")
        except (AttributeError, json.JSONDecodeError, OSError, TypeError):
            return None
        if not isinstance(value, str):
            return None
        return value.strip() or None

    def stored_shop_domain(self) -> Optional[str]:
        try:
            value = self._load_config().get("shop_domain", "")
        except (AttributeError, json.JSONDecodeError, OSError, TypeError):
            return None
        if not isinstance(value, str):
            return None
        return value.strip() or None

    def stored_client_id(self) -> Optional[str]:
        try:
            value = self._load_config().get("client_id", "")
        except (AttributeError, json.JSONDecodeError, OSError, TypeError):
            return None
        if not isinstance(value, str):
            return None
        return value.strip() or None

    def stored_client_secret(self) -> Optional[str]:
        try:
            value = self._load_config().get("client_secret", "")
        except (AttributeError, json.JSONDecodeError, OSError, TypeError):
            return None
        if not isinstance(value, str):
            return None
        return value.strip() or None

    def stored_pending_state(self) -> Optional[str]:
        """CSRF nonce set by /oauth/start, checked and cleared by /oauth/callback."""
        try:
            value = self._load_config().get("_pending_state", "")
        except (AttributeError, json.JSONDecodeError, OSError, TypeError):
            return None
        if not isinstance(value, str):
            return None
        return value.strip() or None

    def save_pending_state(self, state: str) -> None:
        self._save_config({"_pending_state": state})

    def clear_pending_state(self) -> None:
        self._save_config({"_pending_state": ""})

    def save_app_credentials(
        self, *, shop_domain: str, client_id: str, client_secret: str
    ) -> None:
        """Persist the OAuth app credentials -- step 1, before the redirect.

        No live validation possible here (unlike the old static-token
        configure()): the client_id/secret pair can only be verified by
        actually completing the OAuth authorize+exchange round trip.
        """
        shop_domain = _normalize_shop_domain(shop_domain)
        client_id = client_id.strip()
        client_secret = client_secret.strip()
        if not shop_domain:
            raise ValueError(
                "A shop domain is required (the *.myshopify.com admin domain, "
                "not the customer-facing storefront domain)"
            )
        if not client_id or not client_secret:
            raise ValueError("Both Client ID and Client Secret are required")
        self._save_config(
            {
                "shop_domain": shop_domain,
                "client_id": client_id,
                "client_secret": client_secret,
            }
        )

    def save_access_token(self, access_token: str) -> None:
        """Persist the access token -- step 2, after the OAuth callback exchange."""
        self._save_config({"access_token": access_token.strip()})

    def is_connected(self) -> bool:
        if not self._token_path.exists():
            return False
        try:
            data = json.loads(self._token_path.read_text(encoding="utf-8"))
            return bool(data.get("access_token")) and bool(data.get("shop_domain"))
        except (AttributeError, json.JSONDecodeError, OSError, TypeError):
            return False

    def disconnect(self) -> None:
        if self._token_path.exists():
            self._token_path.unlink()

    def fetch_catalog_snapshot(self) -> List[Dict[str, Any]]:
        """Fetch the full live product catalog, normalized for snapshotting."""
        config = self._load_config()
        products = _fetch_all_products(config["shop_domain"], config["access_token"])
        snapshot = []
        for p in products:
            price = None
            try:
                price = float(p["priceRangeV2"]["minVariantPrice"]["amount"])
            except (KeyError, TypeError, ValueError):
                pass
            seo = p.get("seo") or {}
            snapshot.append(
                {
                    "id": p["id"],
                    "title": p["title"],
                    "status": p["status"],
                    "inventory": p.get("totalInventory"),
                    "tags": p.get("tags", []),
                    "price": price,
                    "seo_title": seo.get("title"),
                    "seo_description": seo.get("description"),
                }
            )
        return snapshot

    def sync(
        self, *, since: Optional[datetime] = None, cursor: Optional[str] = None
    ) -> Iterator[Document]:
        """Yield one Document per product, for RAG/search over the catalog."""
        for p in self.fetch_catalog_snapshot():
            content = (
                f"Status: {p['status']}, Inventory: {p['inventory']}, "
                f"Price: {p['price']}, Tags: {', '.join(p['tags'])}"
            )
            if p["seo_description"]:
                content += f"\nSEO description: {p['seo_description']}"
            yield Document(
                doc_id=f"shopify-{p['id']}",
                source="shopify",
                doc_type="product",
                content=content,
                title=p["title"],
                timestamp=datetime.now(),
                metadata={"status": p["status"], "price": p["price"], "tags": p["tags"]},
            )
        self._status.state = "idle"
        self._status.last_sync = datetime.now()

    def sync_status(self) -> SyncStatus:
        return self._status
