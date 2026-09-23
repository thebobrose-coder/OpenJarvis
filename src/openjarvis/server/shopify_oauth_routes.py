"""Shopify OAuth 2.0 routes -- dedicated, not the generic multi-provider
flow in connectors_router.py/oauth.py.

Shopify's authorize/token endpoints are per-shop
(https://{shop}.myshopify.com/admin/oauth/...), which the generic
OAuthProvider dataclass doesn't support (it assumes one fixed global URL
per provider, true for Google/Strava/Spotify but not Shopify). Rather than
changing shared code every other OAuth connector depends on, this is a
small self-contained flow at its own path (not /v1/connectors/{id}/oauth/*,
which the generic router already claims for every connector_id including
this one) so there's no route collision.

Multi-store: /start and /callback both take a store_slug path segment
(each configured store has its own Shopify Partners app callback URL
registered, so this can't be a single fixed path) -- see
connectors/shopify_stores.py for how stores get created.

Also hosts shopify_stores_router, the "Add Store" management API (list/
add/remove) the Data Sources UI drives -- small enough to co-locate here
rather than a fourth Shopify file.
"""

from __future__ import annotations

import hashlib
import hmac as hmac_module
import secrets
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from pydantic import BaseModel

shopify_oauth_router = APIRouter(prefix="/v1/shopify-oauth", tags=["shopify-oauth"])
shopify_stores_router = APIRouter(prefix="/v1/shopify-stores", tags=["shopify-stores"])

_SCOPES = "read_products,read_inventory"

_SUCCESS_STYLE = "font-family:system-ui;text-align:center;padding:60px"


def _verify_hmac(params: dict, client_secret: str) -> bool:
    """Validate Shopify's callback signature (fail closed)."""
    provided = params.get("hmac", "")
    if not provided:
        return False
    message = "&".join(
        f"{k}={v}" for k, v in sorted(params.items()) if k not in ("hmac", "signature")
    )
    computed = hmac_module.new(
        client_secret.encode("utf-8"), message.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    return hmac_module.compare_digest(computed, provided)


@shopify_oauth_router.get("/{store_slug}/start")
async def shopify_oauth_start(store_slug: str, request: Request):
    """Redirect to Shopify's per-shop authorize page."""
    from openjarvis.connectors.shopify import ShopifyConnector
    from openjarvis.connectors.shopify_stores import load_stores

    if store_slug not in load_stores():
        raise HTTPException(404, f"Unknown store '{store_slug}'")

    connector = ShopifyConnector(store_slug=store_slug)
    shop_domain = connector.stored_shop_domain()
    client_id = connector.stored_client_id()
    if not shop_domain or not client_id:
        raise HTTPException(
            400, "Shop domain and Client ID must be saved before starting OAuth"
        )

    state = secrets.token_urlsafe(24)
    connector.save_pending_state(state)

    base_url = str(request.base_url).rstrip("/")
    redirect_uri = f"{base_url}/v1/shopify-oauth/{store_slug}/callback"
    params = {
        "client_id": client_id,
        "scope": _SCOPES,
        "redirect_uri": redirect_uri,
        "state": state,
    }
    auth_url = f"https://{shop_domain}/admin/oauth/authorize?{urlencode(params)}"
    return RedirectResponse(url=auth_url)


@shopify_oauth_router.get("/{store_slug}/callback")
async def shopify_oauth_callback(store_slug: str, request: Request):
    """Handle Shopify's OAuth callback: verify, exchange, persist."""
    from openjarvis.connectors.shopify import ShopifyConnector
    from openjarvis.connectors.shopify_stores import load_stores

    if store_slug not in load_stores():
        raise HTTPException(404, f"Unknown store '{store_slug}'")

    params = dict(request.query_params)
    code = params.get("code", "")
    shop = params.get("shop", "")
    state = params.get("state", "")

    connector = ShopifyConnector(store_slug=store_slug)

    if not code or not shop:
        raise HTTPException(400, "Missing code or shop in Shopify callback")

    stored_shop = connector.stored_shop_domain()
    client_id = connector.stored_client_id()
    client_secret = connector.stored_client_secret()
    if not stored_shop or not client_id or not client_secret:
        raise HTTPException(400, "No pending Shopify OAuth request found")

    if shop != stored_shop:
        raise HTTPException(400, "Shop domain mismatch")

    pending_state = connector.stored_pending_state()
    if not state or state != pending_state:
        raise HTTPException(400, "Invalid or expired state -- restart the connection")

    if not _verify_hmac(params, client_secret):
        raise HTTPException(400, "Invalid Shopify signature (hmac mismatch)")

    try:
        resp = httpx.post(
            f"https://{shop}/admin/oauth/access_token",
            json={
                "client_id": client_id,
                "client_secret": client_secret,
                "code": code,
            },
            timeout=30.0,
        )
        resp.raise_for_status()
        access_token = resp.json().get("access_token", "")
    except Exception as exc:
        return HTMLResponse(
            content=(
                f"<html><body style='{_SUCCESS_STYLE}'>"
                "<h2 style='color:#ef4444'>Token Exchange Failed</h2>"
                f"<p>{exc}</p>"
                "</body></html>"
            ),
            status_code=500,
        )

    if not access_token:
        raise HTTPException(500, "Shopify did not return an access token")

    connector.save_access_token(access_token)
    connector.clear_pending_state()

    return HTMLResponse(
        content=(
            f"<html><body style='{_SUCCESS_STYLE}'>"
            "<h2 style='color:#22c55e'>Connected!</h2>"
            "<p>You can close this tab and return to OpenJarvis.</p>"
            "<script>setTimeout(()=>window.close(),2000)</script>"
            "</body></html>"
        )
    )


# ---------------------------------------------------------------------------
# Store management -- the "Add Store" flow Data Sources drives
# ---------------------------------------------------------------------------


class AddStoreRequest(BaseModel):
    display_name: str
    gsc_site_url: str = ""


@shopify_stores_router.get("")
async def list_shopify_stores():
    """Return every configured store, for Data Sources to render (and for
    Store Performance to iterate)."""
    from openjarvis.connectors.shopify_stores import load_stores

    return [
        {"slug": slug, "display_name": meta.get("display_name", slug),
         "gsc_site_url": meta.get("gsc_site_url", "")}
        for slug, meta in load_stores().items()
    ]


@shopify_stores_router.post("")
async def add_shopify_store(req: AddStoreRequest):
    """Create a new store and register its connector. The frontend follows
    this with the normal connect flow (POST /v1/connectors/shopify_{slug}/
    connect) using the oauth_start path returned here."""
    from openjarvis.connectors.shopify_stores import add_store

    try:
        slug = add_store(req.display_name, req.gsc_site_url)
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    return {
        "slug": slug,
        "connector_id": f"shopify_{slug}",
        "oauth_start": f"/v1/shopify-oauth/{slug}/start",
    }


@shopify_stores_router.delete("/{slug}")
async def remove_shopify_store(slug: str):
    """Disconnect and forget a store. Its card stays in Data Sources
    (shown disconnected) until the app restarts -- see remove_store()'s
    docstring for why (RegistryBase has no unregister)."""
    from openjarvis.connectors.shopify import ShopifyConnector
    from openjarvis.connectors.shopify_stores import load_stores, remove_store

    if slug not in load_stores():
        raise HTTPException(404, f"Unknown store '{slug}'")

    ShopifyConnector(store_slug=slug).disconnect()
    remove_store(slug)
    return {"status": "removed", "slug": slug}
