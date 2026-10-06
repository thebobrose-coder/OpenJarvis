"""FastAPI routes for the Trading view -- a read-only proxy for Hermes's
``trading_status`` and ``trading_day`` feeds (hq/decisions/0014, contract
v1.6 "Trading").

The trader writes its own status export; Hermes publishes it unchanged with
no agent and no model call; these routes pass it through like
``bizdev_routes.py`` (``data`` unwrapped, tagged with ``generated_at`` /
``age_seconds`` / ``stale``, the last good copy served when the bridge is
down). **There are no POST routes here, and none may be added:** the view
shows and never acts (0014 D2; the ``trader/kill`` scope stays unbuilt).

``GET /api/trading/config`` returns whether the AWS approval page URL is
configured (``[trading] page_url`` in the machine-local ``config.toml``) and
the URL itself for the open-in-browser link. The URL is never in the repo or
in a feed.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, HTTPException

from openjarvis.core.config import load_config

trading_router = APIRouter(prefix="/api/trading", tags=["trading"])

HERMES_BRIDGE_URL = os.environ.get("HERMES_BRIDGE_URL", "http://127.0.0.1:8643").rstrip(
    "/"
)
_TIMEOUT_S = 10.0

FEEDS = frozenset({"trading_status", "trading_day"})

_cache: dict[str, dict] = {}


def _age_from(generated_at: str) -> int:
    ts = datetime.fromisoformat(generated_at.replace("Z", "+00:00"))
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return max(0, int((datetime.now(timezone.utc) - ts).total_seconds()))


def _shape(payload: dict, age_seconds: int, stale: bool) -> dict:
    """Unwrap ``data`` and tag it. Hermes marks a status older than 15 minutes
    ``stale: true`` inside the document (contract v1.6); that flag is kept,
    never overwritten by the route's own bridge-down flag."""
    data = payload["data"]
    return {
        **data,
        "generated_at": payload["generated_at"],
        "age_seconds": age_seconds,
        "stale": bool(stale or data.get("stale")),
    }


def page_url_from_config() -> str | None:
    """The approval page URL from ``[trading] page_url``, or None when unset
    or not an https URL (the link opens the system browser, so nothing else
    is ever handed to it)."""
    try:
        trading = getattr(load_config(), "trading", None)
        url = (getattr(trading, "page_url", "") or "").strip()
    except Exception:  # noqa: BLE001 - a broken config means "not set"
        return None
    if not url.lower().startswith("https://"):
        return None
    return url


@trading_router.get("/config")
async def get_config() -> dict:
    """Whether the AWS approval page URL is set, and the URL for the link."""
    url = page_url_from_config()
    return {"page_url_set": url is not None, "page_url": url}


@trading_router.get("/{feed}")
async def get_feed(feed: str) -> dict:
    """Return one trading feed's latest document, unwrapped."""
    if feed not in FEEDS:
        raise HTTPException(status_code=404, detail="Unknown trading feed")

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
            resp = await client.get(f"{HERMES_BRIDGE_URL}/panels/{feed}")
        if resp.status_code == 404:
            raise HTTPException(status_code=404, detail="No data yet")
        if resp.status_code == 200:
            payload = resp.json()
            if not isinstance(payload.get("data"), dict):
                raise ValueError("feed document is not an object")
            age = int(payload.get("age_seconds") or _age_from(payload["generated_at"]))
            _cache[feed] = payload
            return _shape(payload, age, False)
    except (httpx.HTTPError, ValueError, KeyError, TypeError):
        pass

    cached = _cache.get(feed)
    if cached is None:
        raise HTTPException(status_code=503, detail="Hermes feed unavailable")
    return _shape(cached, _age_from(cached["generated_at"]), True)
