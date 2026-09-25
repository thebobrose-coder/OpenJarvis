"""FastAPI route for the Store Performance panel -- a read-through proxy for
the Hermes panel feed.

Hermes (the ecom-seo role) now owns the Shopify catalog diff + Search
Console pull and refreshes it every 30 minutes; this route just fetches
`/panels/store_performance` from the local Hermes bridge and passes its
`data` through, tagged with freshness. The payload shape is unchanged from
when OpenJarvis computed it itself (see hq/contracts/openjarvis-hermes.md
v0.3 §2).

The last good response is kept in memory, so a Hermes restart or a missed
refresh degrades to a stale-flagged copy rather than an empty panel.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, HTTPException

store_performance_router = APIRouter(
    prefix="/api/store-performance", tags=["store-performance"]
)

HERMES_PANELS_URL = os.environ.get(
    "HERMES_PANELS_URL", "http://127.0.0.1:8643/panels/store_performance"
)
_TIMEOUT_S = 10.0
# 4 missed 30-minute refreshes.
_STALE_AFTER_S = 7200

_cache: dict | None = None


def _age_from(generated_at: str) -> int:
    ts = datetime.fromisoformat(generated_at.replace("Z", "+00:00"))
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return max(0, int((datetime.now(timezone.utc) - ts).total_seconds()))


def _shape(payload: dict, age_seconds: int, stale: bool) -> dict:
    return {
        **payload["data"],
        "generated_at": payload["generated_at"],
        "age_seconds": age_seconds,
        "stale": stale,
    }


@store_performance_router.get("")
async def get_store_performance() -> dict:
    """Return Hermes's latest per-store Shopify + Search Console data."""
    global _cache

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
            resp = await client.get(HERMES_PANELS_URL)
        if resp.status_code == 200:
            payload = resp.json()
            age = int(payload.get("age_seconds") or 0)
            shaped = _shape(payload, age, age > _STALE_AFTER_S)
            _cache = payload
            return shaped
    except (httpx.HTTPError, ValueError, KeyError):
        pass

    if _cache is None:
        raise HTTPException(status_code=503, detail="Hermes panel feed unavailable")
    return _shape(_cache, _age_from(_cache["generated_at"]), True)
