"""FastAPI routes for the Content page -- a read-through proxy for Hermes's
content-strategist feeds, plus the actions the contract allows.

Hermes proposes seed topics per Foundry property and measures what was
posted; the operator decides here, and only approved proposals reach
Foundry's intake (hq/contracts/openjarvis-hermes.md v1.0 §2, "Content
loop"). These routes pass the four feeds through like the Business
Development routes (`data` unwrapped, tagged with `generated_at` /
`age_seconds` / `stale`) and forward only the allowlisted actions,
validated as the bridge validates them.
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

content_router = APIRouter(prefix="/api/content", tags=["content"])

HERMES_BRIDGE_URL = os.environ.get("HERMES_BRIDGE_URL", "http://127.0.0.1:8643").rstrip(
    "/"
)
_TIMEOUT_S = 10.0

FEEDS = frozenset(
    {"content_seedbank", "content_proposals", "content_performance", "content_health"}
)
PROPOSAL_ACTIONS = frozenset({"approve", "reject"})
PROMPT_ACTIONS = frozenset({"used", "dismissed"})
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_BODY_MAX = 2048
# Per-field limits, as the bridge enforces them.
_APPROVE_LIMITS = {"topic": 600, "pillar_hint": 120, "product_handle": 120, "note": 500}
_REJECT_LIMITS = {"note": 500}

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


async def _json_body(request: Request) -> dict | None:
    """The request's optional JSON object, enforcing the bridge's 2 KB limit."""
    raw = await request.body()
    if len(raw) > _BODY_MAX:
        raise HTTPException(status_code=413, detail="Body over 2 KB")
    if not raw.strip():
        return None
    try:
        body = json.loads(raw)
    except ValueError:
        raise HTTPException(status_code=400, detail="Body is not JSON")
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Body must be a JSON object")
    return body


def _fields(body: dict | None, limits: dict[str, int]) -> dict[str, str] | None:
    """Only the allowed text fields, trimmed; empty ones are dropped."""
    if not body:
        return None
    unknown = set(body) - set(limits)
    if unknown:
        raise HTTPException(
            status_code=400, detail=f"Unknown field: {sorted(unknown)[0]}"
        )
    kept = {}
    for key, limit in limits.items():
        value = body.get(key)
        if value is None:
            continue
        if not isinstance(value, str) or len(value) > limit:
            raise HTTPException(
                status_code=400,
                detail=f"{key} must be text of at most {limit} characters",
            )
        if value.strip():
            kept[key] = value.strip()
    return kept or None


def _check_id(object_id: str) -> None:
    if not _UUID.fullmatch(object_id):
        raise HTTPException(status_code=400, detail="Invalid id")


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


@content_router.get("/{feed}")
async def get_feed(feed: str) -> dict:
    """Return one content feed's latest document, unwrapped."""
    if feed not in FEEDS:
        raise HTTPException(status_code=404, detail="Unknown content feed")

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


@content_router.post("/ideation/refresh")
async def research_more() -> JSONResponse:
    """One extra ideation run (Hermes caps it at 1 a day)."""
    return await _post("/panels/content_ideation/refresh")


@content_router.post("/proposals/{proposal_id}/{action}")
async def decide_proposal(
    proposal_id: str, action: str, request: Request
) -> JSONResponse:
    """Approve (optionally with the operator's edits) or reject a proposal."""
    _check_id(proposal_id)
    if action not in PROPOSAL_ACTIONS:
        raise HTTPException(status_code=400, detail="Invalid action")
    limits = _APPROVE_LIMITS if action == "approve" else _REJECT_LIMITS
    body = _fields(await _json_body(request), limits)
    return await _post(f"/content/proposals/{proposal_id}/{action}", body)


@content_router.post("/prompts/{prompt_id}/{action}")
async def mark_prompt(prompt_id: str, action: str) -> JSONResponse:
    """Mark a CIO thesis prompt used or dismissed."""
    _check_id(prompt_id)
    if action not in PROMPT_ACTIONS:
        raise HTTPException(status_code=400, detail="Invalid action")
    return await _post(f"/content/prompts/{prompt_id}/{action}")
