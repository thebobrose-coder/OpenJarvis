"""FastAPI routes for the G1 mirror (hq 0020 D4; hq/contracts/foundry-g1-mirror.md).

Foundry's ``ApprovalMirror`` is a Lambda Function URL with ``AWS_IAM`` auth:
``GET /approvals`` lists the open G1 and G2 approvals with the Telegram
card's text, and ``POST /approvals/<id>`` decides one through the same code
as Telegram's buttons. The backend signs both with SigV4 (service ``lambda``)
using a named AWS profile. Both the URL and the profile name are local config
(credentials.toml ``[g1]`` ``G1_MIRROR_URL`` and ``G1_AWS_PROFILE``). With no
config the G1 kind is simply absent: these routes answer 404, and "Waiting
on you" lists no G1 rows.

The listing's still and clip are presigned S3 links valid for 15 minutes.
They never reach the page and are never cached or logged: the page asks
``…/media/{still|clip}``, and the backend lists again and streams the file.
G2 rows (``decidable: false``) are listed for reading only; Foundry refuses
to decide them (403), and the page says "Decide in Telegram". Every route
answers only requests from this machine.
"""

from __future__ import annotations

import json
import logging
from typing import Any
from urllib.parse import quote

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

from openjarvis.core.credentials import get_tool_credential
from openjarvis.server import sigv4
from openjarvis.server.stack_routes import _local_only

g1_router = APIRouter(prefix="/api/g1", tags=["g1"])


class _NoPresignedLinks(logging.Filter):
    """httpx logs each request's URL at INFO; a presigned S3 link carries its
    signature in the query (`X-Amz-…`), so those lines are dropped."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            return "X-Amz-" not in record.getMessage()
        except Exception:
            return True


_LINK_FILTER = _NoPresignedLinks()
for _name in ("httpx", "httpcore"):
    logging.getLogger(_name).addFilter(_LINK_FILTER)

TOOL = "g1"
URL_KEY = "G1_MIRROR_URL"
PROFILE_KEY = "G1_AWS_PROFILE"
SERVICE = "lambda"
_TIMEOUT_S = 10.0
_MEDIA_TIMEOUT_S = 60.0
_MEDIA_MAX = 60 * 1024 * 1024  # the clip is the 60 s cut (Telegram takes 50 MB)
NOTE_MAX = 500
DECISIONS = ("approve", "reject")
_ID_OK = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-")
_MEDIA_KEYS = {"still": "stillUrl", "clip": "clipUrl"}
# The card's text, as the listing carries it; nothing else reaches the page.
_ITEM_KEYS = (
    "approvalId",
    "gate",
    "propertyId",
    "contentType",
    "executionName",
    "createdAt",
    "expiresAt",
    "headline",
    "caption",
    "disclosures",
    "escalation",
    "targets",
    "motion",
    "decidable",
)


class MirrorConfig:
    def __init__(self, url: str, region: str, credentials: sigv4.Credentials):
        self.url = url.rstrip("/")
        self.region = region
        self.credentials = credentials


class MirrorError(Exception):
    """The mirror couldn't be reached or answered badly; the text is safe to show."""


def config() -> MirrorConfig | None:
    """The mirror's URL and keys from local config, or None when not set up."""
    url = get_tool_credential(TOOL, URL_KEY)
    profile = get_tool_credential(TOOL, PROFILE_KEY)
    if not url or not profile:
        return None
    region = sigv4.lambda_url_region(url)
    if region is None or not url.startswith("https://"):
        raise MirrorError("G1_MIRROR_URL is not a Lambda Function URL")
    creds = sigv4.load_profile(profile)
    if creds is None:
        raise MirrorError("The G1 profile has no access key on this machine")
    return MirrorConfig(url, region, creds)


def _configured() -> MirrorConfig:
    try:
        cfg = config()
    except MirrorError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from None
    if cfg is None:
        raise HTTPException(status_code=404, detail="The G1 mirror is not configured")
    return cfg


async def _call(
    cfg: MirrorConfig, method: str, path: str, body: dict | None = None
) -> httpx.Response:
    data = json.dumps(body).encode() if body is not None else b""
    headers = {"Content-Type": "application/json"} if body is not None else {}
    url = f"{cfg.url}{path}"
    signed = sigv4.sign(
        method,
        url,
        region=cfg.region,
        service=SERVICE,
        credentials=cfg.credentials,
        body=data,
        headers=headers,
    )
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
            return await client.request(method, url, content=data, headers=signed)
    except httpx.HTTPError as exc:
        # The exception text carries the URL: report the kind only.
        raise MirrorError(f"G1 mirror unreachable ({type(exc).__name__})") from None


async def list_raw(cfg: MirrorConfig) -> dict[str, Any]:
    """The mirror's listing as it came, presigned links included. Callers
    strip the links before anything reaches the page."""
    resp = await _call(cfg, "GET", "/approvals")
    if resp.status_code != 200:
        raise MirrorError(f"G1 mirror answered {resp.status_code}")
    try:
        doc = resp.json()
    except ValueError:
        raise MirrorError("G1 mirror answered something other than JSON") from None
    if not isinstance(doc, dict) or not isinstance(doc.get("items"), list):
        raise MirrorError("G1 mirror answered an unexpected shape")
    return doc


def public_item(item: dict[str, Any]) -> dict[str, Any]:
    """A listing row for the page: the card's text and whether media exists,
    never the presigned links."""
    out = {k: item.get(k) for k in _ITEM_KEYS}
    out["hasStill"] = bool(item.get("stillUrl"))
    out["hasClip"] = bool(item.get("clipUrl"))
    return out


async def listing() -> dict[str, Any] | None:
    """The page's listing, or None when the mirror isn't configured. Raises
    MirrorError when it is configured but can't be read."""
    cfg = config()
    if cfg is None:
        return None
    doc = await list_raw(cfg)
    return {
        "generatedAt": doc.get("generatedAt"),
        "items": [public_item(i) for i in doc["items"] if isinstance(i, dict)],
    }


def _check_id(approval_id: str) -> None:
    if not approval_id or len(approval_id) > 64 or set(approval_id) - _ID_OK:
        raise HTTPException(status_code=400, detail="Invalid approval id")


@g1_router.get("/approvals")
async def get_approvals(request: Request):
    _local_only(request)
    cfg = _configured()
    try:
        doc = await list_raw(cfg)
    except MirrorError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from None
    return {
        "generatedAt": doc.get("generatedAt"),
        "items": [public_item(i) for i in doc["items"] if isinstance(i, dict)],
    }


@g1_router.get("/approvals/{approval_id}/media/{which}")
async def get_media(approval_id: str, which: str, request: Request):
    """The row's still or clip, streamed from a link fetched just now. The
    link isn't stored, returned or logged."""
    _local_only(request)
    _check_id(approval_id)
    if which not in _MEDIA_KEYS:
        raise HTTPException(status_code=400, detail="still or clip")
    cfg = _configured()
    try:
        doc = await list_raw(cfg)
    except MirrorError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from None
    item = next(
        (
            i
            for i in doc["items"]
            if isinstance(i, dict) and i.get("approvalId") == approval_id
        ),
        None,
    )
    if item is None:
        raise HTTPException(status_code=404, detail="No longer open")
    link = item.get(_MEDIA_KEYS[which])
    if not isinstance(link, str) or not link.startswith("https://"):
        raise HTTPException(status_code=404, detail=f"This row has no {which}")
    try:
        async with httpx.AsyncClient(timeout=_MEDIA_TIMEOUT_S) as client:
            resp = await client.get(link)
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=503,
            detail=f"The {which} couldn't be fetched ({type(exc).__name__})",
        ) from None
    if resp.status_code != 200:
        raise HTTPException(
            status_code=502, detail=f"The {which} answered {resp.status_code}"
        )
    if len(resp.content) > _MEDIA_MAX:
        raise HTTPException(status_code=502, detail=f"The {which} is too large")
    kind = resp.headers.get("content-type") or (
        "video/mp4" if which == "clip" else "image/jpeg"
    )
    return Response(
        content=resp.content,
        media_type=kind.split(";")[0],
        headers={"Cache-Control": "no-store"},
    )


class DecisionBody(BaseModel):
    decision: str
    note: str = ""


@g1_router.post("/approvals/{approval_id}")
async def decide(approval_id: str, body: DecisionBody, request: Request):
    """Approve or reject one G1 row through Foundry's decide(), the code
    Telegram's buttons run. Foundry's answer passes through: 200 decided, 409
    already decided (by Telegram or the app) or expired, 403 a G2 row, 404
    gone, 400 a bad body."""
    _local_only(request)
    _check_id(approval_id)
    if body.decision not in DECISIONS:
        raise HTTPException(status_code=400, detail="approve or reject")
    note = body.note.strip()
    if len(note) > NOTE_MAX:
        raise HTTPException(
            status_code=400, detail=f"The note is at most {NOTE_MAX} characters"
        )
    cfg = _configured()
    payload: dict[str, Any] = {"decision": body.decision}
    if note:
        payload["note"] = note
    try:
        resp = await _call(cfg, "POST", f"/approvals/{quote(approval_id)}", payload)
    except MirrorError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from None
    try:
        content = resp.json()
    except ValueError:
        content = {"detail": f"G1 mirror answered {resp.status_code}"}
    if resp.status_code not in (200, 400, 403, 404, 409):
        return JSONResponse(
            status_code=502,
            content={"detail": f"G1 mirror answered {resp.status_code}"},
        )
    return JSONResponse(status_code=resp.status_code, content=content)
