"""FastAPI routes for the Content page -- a read-through proxy for Hermes's
content-strategist feeds, plus the actions the contract allows.

Hermes proposes seed topics per Foundry property and measures what was
posted; the operator decides here, and only approved proposals reach
Foundry's intake (hq/contracts/openjarvis-hermes.md v1.0 §2, "Content
loop"; v1.9-v1.10 add `content_winners` and the target-query edits; v1.14
adds the video flag on approvals and seeds). These
routes pass the five feeds through like the Business Development routes
(`data` unwrapped, tagged with `generated_at` / `age_seconds` / `stale`) and
forward only the allowlisted actions, validated as the bridge validates them.

v1.16 (hq 0008 A1) adds the operator's own seeds: `POST /api/content/seeds`
and `GET /api/content/verify-product` proxy the bridge, and
`POST /api/content/intake/run` starts Foundry's intake task now instead of at
its next :20 (the stack-health pattern; at most once every 2 minutes). These
three answer only requests from this machine.

v1.17 (hq 0019) adds the episode lane's seed fields: `episode_class`,
`sources` and `target_minutes`, required on that lane and refused on any other.
The studio's own files are served by `studio_routes`.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from openjarvis.server.stack_routes import _local_only

content_router = APIRouter(prefix="/api/content", tags=["content"])

HERMES_BRIDGE_URL = os.environ.get("HERMES_BRIDGE_URL", "http://127.0.0.1:8643").rstrip(
    "/"
)
_TIMEOUT_S = 10.0

FEEDS = frozenset(
    {
        "content_seedbank",
        "content_proposals",
        "content_performance",
        "content_health",
        "content_winners",
    }
)
PROPOSAL_ACTIONS = frozenset({"approve", "reject"})
PROMPT_ACTIONS = frozenset({"used", "dismissed"})
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_BODY_MAX = 2048
# v1.14.1: the bridge reads approve bodies up to 4096 bytes.
_APPROVE_BODY_MAX = 4096
# Per-field limits, as the bridge enforces them.
_APPROVE_LIMITS = {"topic": 600, "pillar_hint": 120, "product_handle": 120, "note": 500}
_REJECT_LIMITS = {"note": 500}
# v1.10: the approve body's target queries and priority (the bridge checks the
# shape only; Hermes validates the queries with Foundry's intake rules).
_QUERIES_MAX = 3
_QUERY_MAX_LEN = 80
# v1.14: the video flag, the beat and the operator's own clip.
_MOTIONS = ("always", "never")
_MOTION_BRIEF_MAX = 240
_VIDEO_KEY_MAX = 512
# v1.16 operator seeds: the bridge's own keys and caps (v1.14 adds the motion keys).
_SEED_BODY_MAX = 16 * 1024
_SEED_TEXT_MAX = 6000
_SEED_KEYS = frozenset(
    {
        "property_id",
        "content_type",
        "text",
        "pillar_hint",
        "product_handle",
        "url",
        "target_queries",
        "priority",
        "source_prompt_id",
        "motion",
        "motion_brief",
        "video_asset_key",
        "episode_class",
        "sources",
        "target_minutes",
    }
)
# v1.17: the episode lane's fields, required there and refused on any other lane.
EPISODE_TYPE = "episode"
_EPISODE_KEYS = ("episode_class", "sources", "target_minutes")
_SOURCES_MAX = 10
_MINUTES = (4, 12)
_SEED_ID = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$")
_HANDLE = re.compile(r"^[a-z0-9][a-z0-9-]{0,119}$")
_URL_MAX = 500
# Foundry's intake task (hourly at :20); the operator may start it early.
INTAKE_TASK = r"\Foundry\ProposalIntake"
INTAKE_COOLDOWN_S = 120
_intake_last_run: float | None = None

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


async def _json_body(request: Request, limit: int = _BODY_MAX) -> dict | None:
    """The request's optional JSON object, enforcing the bridge's size limit."""
    raw = await request.body()
    if len(raw) > limit:
        raise HTTPException(status_code=413, detail=f"Body over {limit // 1024} KB")
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


def _targeting(body: dict | None) -> dict[str, Any]:
    """Pop `target_queries` (0-3 strings; `[]` removes them) and `priority`
    (1-3, or null for the default) off the approve body, shape-checked."""
    out: dict[str, Any] = {}
    if not body:
        return out
    if "target_queries" in body:
        queries = body.pop("target_queries")
        if (
            not isinstance(queries, list)
            or len(queries) > _QUERIES_MAX
            or not all(
                isinstance(q, str) and 0 < len(q.strip()) <= _QUERY_MAX_LEN
                for q in queries
            )
        ):
            raise HTTPException(
                status_code=400,
                detail=f"target_queries must be up to {_QUERIES_MAX} texts "
                f"of at most {_QUERY_MAX_LEN} characters",
            )
        out["target_queries"] = [q.strip() for q in queries]
    if "priority" in body:
        priority = body.pop("priority")
        if priority is not None and (
            isinstance(priority, bool)
            or not isinstance(priority, int)
            or not 1 <= priority <= 3
        ):
            raise HTTPException(
                status_code=400, detail="priority must be 1, 2, 3 or null"
            )
        out["priority"] = priority
    return out


def _motion(body: dict | None) -> dict[str, Any]:
    """Pop `motion` ("always", "never" or null for the lane default),
    `motion_brief` (<= 240; "" removes it) and `video_asset_key` (<= 512; ""
    removes it) off the body, shape-checked with the bridge's 400 texts. Hermes
    checks where a clip may render, the beat's wording and the key's prefix."""
    out: dict[str, Any] = {}
    if not body:
        return out
    if "motion" in body:
        motion = body.pop("motion")
        if motion is not None and motion not in _MOTIONS:
            raise HTTPException(
                status_code=400, detail='motion: "always", "never" or null'
            )
        out["motion"] = motion
    for key, limit in (
        ("motion_brief", _MOTION_BRIEF_MAX),
        ("video_asset_key", _VIDEO_KEY_MAX),
    ):
        if key not in body:
            continue
        value = body.pop(key)
        if not isinstance(value, str) or len(value) > limit:
            raise HTTPException(
                status_code=400,
                detail=f"{key}: a string of at most {limit} characters",
            )
        out[key] = value.strip()
    return out


def _episode(body: dict, content_type: str) -> dict[str, Any]:
    """Pop the episode fields (v1.17): on the `episode` lane all three are
    required (a class id, 1-10 https sources, 4-12 minutes); on any other lane
    none may be sent. Hermes checks the class against the bundle."""
    present = [k for k in _EPISODE_KEYS if body.get(k) is not None]
    values = {k: body.pop(k, None) for k in _EPISODE_KEYS}
    if content_type != EPISODE_TYPE:
        if present:
            raise HTTPException(
                status_code=400, detail=f"{present[0]} is only for the episode lane"
            )
        return {}
    cls, sources, minutes = (values[k] for k in _EPISODE_KEYS)
    if not (isinstance(cls, str) and _SEED_ID.fullmatch(cls)):
        raise HTTPException(status_code=400, detail="episode_class is required")
    if (
        not isinstance(sources, list)
        or not 1 <= len(sources) <= _SOURCES_MAX
        or not all(
            isinstance(s, str)
            and s.strip().startswith("https://")
            and len(s.strip()) <= _URL_MAX
            for s in sources
        )
    ):
        raise HTTPException(
            status_code=400,
            detail=f"sources: 1-{_SOURCES_MAX} https links of at most {_URL_MAX} "
            "characters",
        )
    if (
        isinstance(minutes, bool)
        or not isinstance(minutes, int)
        or not _MINUTES[0] <= minutes <= _MINUTES[1]
    ):
        raise HTTPException(
            status_code=400,
            detail=f"target_minutes is a whole number {_MINUTES[0]}-{_MINUTES[1]}",
        )
    return {
        "episode_class": cls,
        "sources": [s.strip() for s in sources],
        "target_minutes": minutes,
    }


def _seed_body(body: dict | None) -> dict[str, Any]:
    """A seed, shape-checked as the bridge checks it: only its keys, empty
    optional fields dropped. Hermes validates lanes, pillars, phrases and names."""
    if not body:
        raise HTTPException(status_code=400, detail="A seed needs a body")
    unknown = set(body) - _SEED_KEYS
    if unknown:
        raise HTTPException(
            status_code=400, detail=f"Unknown field: {sorted(unknown)[0]}"
        )

    def bad(detail: str) -> HTTPException:
        return HTTPException(status_code=400, detail=detail)

    for key in ("property_id", "content_type"):
        if not (isinstance(body.get(key), str) and _SEED_ID.fullmatch(body[key])):
            raise bad(f"{key} is required")
    text = body.get("text")
    if not isinstance(text, str) or not 1 <= len(text.strip()) <= _SEED_TEXT_MAX:
        raise bad(f"text must be 1-{_SEED_TEXT_MAX} characters")
    seed: dict[str, Any] = {
        "property_id": body["property_id"],
        "content_type": body["content_type"],
        "text": text.strip(),
    }
    pillar = body.get("pillar_hint")
    if pillar is not None:
        if not isinstance(pillar, str) or len(pillar) > 120:
            raise bad("pillar_hint must be text of at most 120 characters")
        if pillar.strip():
            seed["pillar_hint"] = pillar.strip()
    handle = body.get("product_handle")
    if handle is not None and handle != "":
        if not (isinstance(handle, str) and _HANDLE.fullmatch(handle)):
            raise bad("product_handle: lowercase letters, digits and hyphens")
        seed["product_handle"] = handle
    url = body.get("url")
    if url is not None and url != "":
        if not (
            isinstance(url, str) and url.startswith("https://") and len(url) <= _URL_MAX
        ):
            raise bad(f"url must start https:// and be at most {_URL_MAX} characters")
        seed["url"] = url
    seed.update(_episode(body, seed["content_type"]))
    seed.update(_targeting(body))
    # A seed has no stored values to keep or clear: the defaults are left out.
    seed.update({k: v for k, v in _motion(body).items() if v})
    if not seed.get("target_queries"):
        seed.pop("target_queries", None)
    prompt_id = body.get("source_prompt_id")
    if prompt_id is not None:
        if not isinstance(prompt_id, str):
            raise bad("source_prompt_id must be a prompt id")
        _check_id(prompt_id)
        seed["source_prompt_id"] = prompt_id
    return seed


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


# Declared before `/{feed}`, which would otherwise take the path.
@content_router.get("/verify-product")
async def verify_product(request: Request, property: str = "", handle: str = ""):
    """Does the product handle resolve in that property's store? Read-only;
    the bridge caches answers 5 minutes and answers 502 when it can't check."""
    _local_only(request)
    if not (_SEED_ID.fullmatch(property) and _HANDLE.fullmatch(handle)):
        raise HTTPException(status_code=400, detail="Invalid property or handle")
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
            resp = await client.get(
                f"{HERMES_BRIDGE_URL}/content/verify-product",
                params={"property": property, "handle": handle},
            )
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
    if action == "approve":
        raw = await _json_body(request, _APPROVE_BODY_MAX)
        extra = {**_targeting(raw), **_motion(raw)}
        body = {**(_fields(raw, _APPROVE_LIMITS) or {}), **extra} or None
    else:
        body = _fields(await _json_body(request), _REJECT_LIMITS)
    return await _post(f"/content/proposals/{proposal_id}/{action}", body)


@content_router.post("/prompts/{prompt_id}/{action}")
async def mark_prompt(prompt_id: str, action: str) -> JSONResponse:
    """Mark a CIO thesis prompt used or dismissed."""
    _check_id(prompt_id)
    if action not in PROMPT_ACTIONS:
        raise HTTPException(status_code=400, detail="Invalid action")
    return await _post(f"/content/prompts/{prompt_id}/{action}")


@content_router.post("/seeds")
async def send_seed(request: Request) -> JSONResponse:
    """The operator's own seed (v1.16): any active property, any seedable or
    operator-only lane. Hermes answers 202 with the proposal id; its verdict
    arrives in `content_proposals`."""
    _local_only(request)
    seed = _seed_body(await _json_body(request, _SEED_BODY_MAX))
    return await _post("/content/seeds", seed)


@content_router.post("/intake/run", status_code=202)
def run_intake(request: Request):
    """Start Foundry's proposal intake now (hourly at :20 otherwise); at most
    once every 2 minutes. The result shows after Hermes's next sync."""
    global _intake_last_run
    _local_only(request)
    if sys.platform != "win32":
        raise HTTPException(status_code=501, detail="Only on Windows")
    now = time.monotonic()
    if _intake_last_run is not None and now - _intake_last_run < INTAKE_COOLDOWN_S:
        wait = int(INTAKE_COOLDOWN_S - (now - _intake_last_run)) + 1
        return JSONResponse(
            status_code=429,
            content={"detail": "Intake ran under 2 minutes ago", "retry_after": wait},
            headers={"Retry-After": str(wait)},
        )
    try:
        proc = subprocess.run(
            ["schtasks", "/Run", "/TN", INTAKE_TASK],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise HTTPException(
            status_code=503, detail=f"schtasks failed: {type(exc).__name__}"
        ) from None
    if proc.returncode != 0:
        lines = (proc.stderr or proc.stdout or "").strip().splitlines()
        detail = lines[0].strip() if lines else ""
        raise HTTPException(status_code=503, detail=detail[:200] or "schtasks failed")
    _intake_last_run = now
    started = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return JSONResponse(status_code=202, content={"started_at": started})
