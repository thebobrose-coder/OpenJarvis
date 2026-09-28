"""FastAPI routes for the Commerce page -- a read-through proxy for Hermes's
ecom-seo feeds, plus the two writes the contract allows.

Hermes (the ecom-seo role) produces daily store KPIs, scored products, a
weekly SEO audit, a sectioned daily briefing, and a recommendations ledger
(hq/contracts/openjarvis-hermes.md v0.6 / v0.6.1 §2). These routes pass the
feeds through in the shape the Store Performance route uses (`data`
unwrapped, tagged with `generated_at` / `age_seconds` / `stale`), and
forward only allowlisted refresh flags and recommendation decisions.

A feed that has never run is a 404 ("no data yet"). The last good copy of
each feed is kept in memory, so a Hermes restart degrades to a stale-flagged
copy rather than an empty page.
"""

from __future__ import annotations

import os
import re
from datetime import datetime, timezone
from typing import Any, Optional

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

commerce_router = APIRouter(prefix="/api/commerce", tags=["commerce"])

HERMES_BRIDGE_URL = os.environ.get("HERMES_BRIDGE_URL", "http://127.0.0.1:8643").rstrip(
    "/"
)
_TIMEOUT_S = 10.0

FEEDS = frozenset(
    {
        "ecom_daily",
        "ecom_products",
        "ecom_seo_health",
        "ecom_briefing",
        "ecom_recommendations",
        "compliance_findings",
    }
)
# Refresh flags the bridge accepts for the ecom feeds (v0.6.1): the three
# feeds, plus one flag per briefing focus.
REFRESHABLE = frozenset(
    {
        "ecom_daily",
        "ecom_seo_health",
        "ecom_briefing",
        "ecom_briefing_products",
        "ecom_briefing_growth",
        "ecom_briefing_technical",
    }
)
DECISIONS = frozenset({"accepted", "rejected", "done"})
_ID = re.compile(r"^[0-9a-f]{12}$")
_NOTE_MAX = 500

_cache: dict[str, dict] = {}


class DecisionBody(BaseModel):
    note: Optional[str] = Field(default=None, max_length=_NOTE_MAX)


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


async def _post(path: str, body: Any = None) -> JSONResponse:
    """POST to the bridge and pass its status and JSON body through."""
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
            resp = await client.post(f"{HERMES_BRIDGE_URL}{path}", json=body)
        try:
            content = resp.json()
        except ValueError:
            content = {"detail": resp.text[:200]}
        return JSONResponse(status_code=resp.status_code, content=content)
    except httpx.HTTPError:
        raise HTTPException(status_code=503, detail="Hermes bridge unavailable")


@commerce_router.get("/{feed}")
async def get_feed(feed: str) -> dict:
    """Return one ecom feed's latest document, unwrapped."""
    if feed not in FEEDS:
        raise HTTPException(status_code=404, detail="Unknown commerce feed")

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
            resp = await client.get(f"{HERMES_BRIDGE_URL}/panels/{feed}")
        if resp.status_code == 404:
            raise HTTPException(status_code=404, detail="No data yet")
        if resp.status_code == 200:
            payload = resp.json()
            payload["data"]  # validate before caching
            age = int(payload.get("age_seconds") or _age_from(payload["generated_at"]))
            _cache[feed] = payload
            return _shape(payload, age, False)
    except (httpx.HTTPError, ValueError, KeyError, TypeError):
        pass

    cached = _cache.get(feed)
    if cached is None:
        raise HTTPException(status_code=503, detail="Hermes feed unavailable")
    return _shape(cached, _age_from(cached["generated_at"]), True)


@commerce_router.post("/recommendations/{rec_id}/{decision}")
async def decide(
    rec_id: str, decision: str, body: Optional[DecisionBody] = None
) -> JSONResponse:
    """Record the operator's decision on one recommendation (202 queued)."""
    if not _ID.fullmatch(rec_id):
        raise HTTPException(status_code=400, detail="Invalid recommendation id")
    if decision not in DECISIONS:
        raise HTTPException(status_code=400, detail="Invalid decision")
    note = (body.note or "").strip() if body else ""
    return await _post(
        f"/ecom/recommendations/{rec_id}/{decision}",
        {"note": note} if note else None,
    )


@commerce_router.post("/{feed}/refresh")
async def refresh(feed: str) -> JSONResponse:
    """Ask Hermes to regenerate one feed or briefing focus (202 queued)."""
    if feed not in REFRESHABLE:
        raise HTTPException(status_code=400, detail="Feed can't be refreshed")
    return await _post(f"/panels/{feed}/refresh")
