"""FastAPI routes for the Business Development page -- a read-through proxy
for Hermes's bd-researcher feeds, plus the actions the contract allows.

Hermes researches prospects per business line and publishes `bd_pipeline`
(rewritten after every change), `bd_stats` (daily) and `bd_prospects` (the
weekly batch); see hq/contracts/openjarvis-hermes.md v0.9 §2. These routes
pass the feeds through like the Commerce routes (`data` unwrapped, tagged
with `generated_at` / `age_seconds` / `stale`) and forward only the
allowlisted actions, validated as the bridge validates them.

Prospect documents carry official-directory work contacts. They are passed
through to the page for display only: nothing here logs or stores them
beyond the in-memory last-known copy that keeps the page up when the bridge
restarts.
"""

from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

bizdev_router = APIRouter(prefix="/api/bizdev", tags=["bizdev"])

HERMES_BRIDGE_URL = os.environ.get("HERMES_BRIDGE_URL", "http://127.0.0.1:8643").rstrip(
    "/"
)
_TIMEOUT_S = 10.0

FEEDS = frozenset({"bd_pipeline", "bd_stats", "bd_prospects"})
STAGES = frozenset(
    {
        "drafted",
        "sent",
        "replied",
        "meeting",
        "won",
        "lost",
        "not_interested",
        "do_not_contact",
        "bounced",
    }
)
_ID = re.compile(r"^[1-9][0-9]{0,9}$")
_BODY_MAX = 2048
_NOTE_MAX = 500
_FIELD_MAX = 200

_cache: dict[str, dict] = {}


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


async def _json_body(request: Request, *, required: bool) -> dict | None:
    """The request's JSON object, enforcing the bridge's 2 KB limit."""
    raw = await request.body()
    if len(raw) > _BODY_MAX:
        raise HTTPException(status_code=413, detail="Body over 2 KB")
    if not raw.strip():
        if required:
            raise HTTPException(status_code=400, detail="JSON body required")
        return None
    try:
        body = json.loads(raw)
    except ValueError:
        raise HTTPException(status_code=400, detail="Body is not JSON")
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Body must be a JSON object")
    return body


def _check_id(prospect_id: str) -> None:
    if not _ID.fullmatch(prospect_id):
        raise HTTPException(status_code=400, detail="Invalid prospect id")


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


@bizdev_router.get("/{feed}")
async def get_feed(feed: str) -> dict:
    """Return one bd feed's latest document, unwrapped."""
    if feed not in FEEDS:
        raise HTTPException(status_code=404, detail="Unknown bizdev feed")

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


@bizdev_router.post("/research/refresh")
async def research_more() -> JSONResponse:
    """One extra research batch (Hermes caps it at 1 a week)."""
    return await _post("/panels/bd_research/refresh")


@bizdev_router.post("/queue")
async def queue_institution(request: Request) -> JSONResponse:
    """Put an institution first in the next research batch."""
    body = await _json_body(request, required=True)
    fields = {}
    for key in ("line", "name", "association"):
        value = body.get(key) if body else None
        if not isinstance(value, str) or not value.strip() or len(value) > _FIELD_MAX:
            raise HTTPException(status_code=400, detail=f"Invalid {key}")
        fields[key] = value.strip()
    return await _post("/bd/queue", fields)


# Registered before the stage route, so "recheck" is never read as a stage.
@bizdev_router.post("/prospects/{prospect_id}/recheck")
async def recheck(prospect_id: str) -> JSONResponse:
    """Re-research one prospect (Hermes caps it at 5 a day)."""
    _check_id(prospect_id)
    return await _post(f"/bd/prospects/{prospect_id}/recheck")


@bizdev_router.post("/prospects/{prospect_id}/{stage}")
async def move_stage(prospect_id: str, stage: str, request: Request) -> JSONResponse:
    """Record a prospect's new stage or outcome, with an optional note."""
    _check_id(prospect_id)
    if stage not in STAGES:
        raise HTTPException(status_code=400, detail="Invalid stage")
    body = await _json_body(request, required=False)
    note = body.get("note") if body else None
    if note is not None and (not isinstance(note, str) or len(note) > _NOTE_MAX):
        raise HTTPException(
            status_code=400, detail="Note must be text of at most 500 characters"
        )
    note = (note or "").strip()
    return await _post(
        f"/bd/prospects/{prospect_id}/{stage}", {"note": note} if note else None
    )
