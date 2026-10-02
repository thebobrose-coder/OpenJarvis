"""FastAPI routes for the Commerce page's Fixes tab -- the operator's
decisions on Hermes's catalog fixes (hq/contracts/openjarvis-hermes.md v1.3.3
§2, "Catalog fixes").

The feed itself (`catalog_fixes`) is read through `/api/commerce/<feed>`
like the other ecom feeds. These routes forward the decision POSTs to the
bridge's `/fixes/*` routes, adding the `X-Operator-Token` header here: the
token is a file the operator created, its path is local config
(`HERMES_FIX_TOKEN_FILE` in credentials.toml, tool `hermes`), and it is read
per request, never logged, and never sent to the frontend. The bridge's
202 / 401 / 409 answers are passed through as they come.

The bridge records each decision; from P2 the writer applies approved fixes
once it is live. P1 approvals wait in `confirm` until the operator
re-confirms them (0011 A9); before the writer is live both confirm routes
answer 409 not_live, which is passed through like the others.

The tier control (v1.4, 0011 A13) is the one route here that never reaches
Hermes: `/policy` writes the operator-only auto-fix policy file itself (its
path is `HERMES_AUTOFIX_POLICY_FILE` in credentials.toml), atomically, and
only for a request from this machine. Raising a class checks it against the
latest `catalog_fixes` document; lowering is always allowed.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal, Optional

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from openjarvis.core.credentials import get_tool_credential
from openjarvis.server import commerce_routes
from openjarvis.server.commerce_routes import _post

fixes_router = APIRouter(prefix="/api/commerce/fixes", tags=["commerce"])

# 0011 §5 allowlist; the bridge also checks a field is one of the patch's own.
FIELDS = frozenset(
    {
        "descriptionHtml",
        "title",
        "seo.title",
        "seo.description",
        "tags",
        "variant.barcode",
        "inventoryItem.tracked",
        "image.altText",
    }
)
_ID = re.compile(r"^[0-9a-f]{12}$")
_SHA = re.compile(r"^[0-9a-f]{64}$")
_NOTE_MAX = 500
_EDIT_MAX_BYTES = 256 * 1024
_CLASS_MAX = 100
TOKEN_KEY = "HERMES_FIX_TOKEN_FILE"
POLICY_KEY = "HERMES_AUTOFIX_POLICY_FILE"
_LOOPBACK = frozenset({"127.0.0.1", "::1", "localhost"})


class NoteBody(BaseModel):
    note: Optional[str] = Field(default=None, max_length=_NOTE_MAX)


class ApproveBody(NoteBody):
    patch_sha256: str
    # v1.3.2 (0011 A6): approve an invalid patch whose only failed check is
    # the judge. The bridge refuses it (409 status) on any other patch.
    over_judge: bool = False


class EditChange(BaseModel):
    field: str
    after: str


class EditBody(NoteBody):
    patch_sha256: str
    changes: list[EditChange] = Field(min_length=1)


class ClassPatch(BaseModel):
    id: str
    patch_sha256: str


class ApproveClassBody(NoteBody):
    store: str = Field(min_length=1, max_length=200)
    rule: str = Field(min_length=1, max_length=200)
    field: str
    patches: list[ClassPatch] = Field(min_length=1, max_length=_CLASS_MAX)


def _operator_headers() -> dict[str, str]:
    """The operator token header, read fresh from the configured file."""
    path = get_tool_credential("hermes", TOKEN_KEY)
    if not path:
        raise HTTPException(status_code=503, detail="Operator token not configured")
    try:
        token = Path(path).expanduser().read_text(encoding="utf-8").strip()
    except OSError:
        raise HTTPException(status_code=503, detail="Operator token unreadable")
    if not token:
        raise HTTPException(status_code=503, detail="Operator token unreadable")
    return {"X-Operator-Token": token}


def _check_sha(value: str) -> None:
    if not _SHA.fullmatch(value):
        raise HTTPException(status_code=400, detail="Invalid patch_sha256")


def _with_note(body: dict, note: Optional[str]) -> dict:
    note = (note or "").strip()
    return {**body, "note": note} if note else body


class ConfirmBody(NoteBody):
    patch_sha256: str


def _class_payload(body: ApproveClassBody) -> dict:
    if body.field not in FIELDS:
        raise HTTPException(status_code=400, detail="Invalid field")
    for p in body.patches:
        if not _ID.fullmatch(p.id):
            raise HTTPException(status_code=400, detail="Invalid fix id")
        _check_sha(p.patch_sha256)
    payload = {
        "store": body.store,
        "rule": body.rule,
        "field": body.field,
        "patches": [{"id": p.id, "patch_sha256": p.patch_sha256} for p in body.patches],
    }
    return _with_note(payload, body.note)


@fixes_router.post("/approve-class")
async def approve_class(body: ApproveClassBody) -> JSONResponse:
    """Approve the listed patches of one class (not a tier change)."""
    return await _post(
        "/fixes/approve-class", _class_payload(body), _operator_headers()
    )


@fixes_router.post("/confirm-class")
async def confirm_class(body: ApproveClassBody) -> JSONResponse:
    """Re-confirm the listed P1 approvals of one class (v1.3.3, 0011 A9).
    The bridge refuses them all while the class's spot-check hasn't passed."""
    return await _post(
        "/fixes/confirm-class", _class_payload(body), _operator_headers()
    )


@fixes_router.post("/pause")
async def pause() -> JSONResponse:
    return await _post("/fixes/pause", None, _operator_headers())


@fixes_router.post("/resume")
async def resume() -> JSONResponse:
    return await _post("/fixes/resume", None, _operator_headers())


@fixes_router.post("/{fix_id}/approve")
async def approve(fix_id: str, body: ApproveBody) -> JSONResponse:
    """Approve exactly the patch the operator saw (its displayed hash)."""
    _check_id(fix_id)
    _check_sha(body.patch_sha256)
    payload: dict = {"patch_sha256": body.patch_sha256}
    if body.over_judge:
        payload["over_judge"] = True
    return await _post(
        f"/fixes/{fix_id}/approve",
        _with_note(payload, body.note),
        _operator_headers(),
    )


@fixes_router.post("/{fix_id}/confirm")
async def confirm(fix_id: str, body: ConfirmBody) -> JSONResponse:
    """Re-confirm one P1 approval, exactly as displayed (v1.3.3, 0011 A9)."""
    _check_id(fix_id)
    _check_sha(body.patch_sha256)
    return await _post(
        f"/fixes/{fix_id}/confirm",
        _with_note({"patch_sha256": body.patch_sha256}, body.note),
        _operator_headers(),
    )


@fixes_router.post("/{fix_id}/edit")
async def edit(fix_id: str, body: EditBody) -> JSONResponse:
    """Edit and approve in one step; Hermes re-checks the edited text."""
    _check_id(fix_id)
    _check_sha(body.patch_sha256)
    if any(c.field not in FIELDS for c in body.changes):
        raise HTTPException(status_code=400, detail="Invalid field")
    payload = _with_note(
        {
            "patch_sha256": body.patch_sha256,
            "changes": [{"field": c.field, "after": c.after} for c in body.changes],
        },
        body.note,
    )
    if len(json.dumps(payload, ensure_ascii=False).encode("utf-8")) > _EDIT_MAX_BYTES:
        raise HTTPException(status_code=413, detail="Edit is larger than 256 KB")
    return await _post(f"/fixes/{fix_id}/edit", payload, _operator_headers())


@fixes_router.post("/{fix_id}/{action}")
async def note_only(
    fix_id: str, action: str, body: Optional[NoteBody] = None
) -> JSONResponse:
    """Reject (final) or revert (P1: the bridge answers 409 not_applied)."""
    _check_id(fix_id)
    if action not in ("reject", "revert"):
        raise HTTPException(status_code=400, detail="Invalid action")
    return await _post(
        f"/fixes/{fix_id}/{action}",
        _with_note({}, body.note if body else None),
        _operator_headers(),
    )


def _check_id(fix_id: str) -> None:
    if not _ID.fullmatch(fix_id):
        raise HTTPException(status_code=400, detail="Invalid fix id")


# -- the tier control (v1.4, 0011 A13): the policy file, never the bridge ----


class TierBody(NoteBody):
    store: str = Field(min_length=1, max_length=200)
    rule: str = Field(min_length=1, max_length=200)
    field: str
    tier: Literal[0, 1]
    # The rules hash the panel showed; a raise is refused when the feed's differs.
    rules_sha256: Optional[str] = None


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _local_only(request: Request) -> None:
    """The tier control is the operator's, at this machine: refuse anything
    that didn't arrive over loopback."""
    host = request.client.host if request.client else ""
    if host not in _LOOPBACK:
        raise HTTPException(status_code=403, detail="Only from this machine")


def _policy_path() -> Path:
    path = get_tool_credential("hermes", POLICY_KEY)
    if not path:
        raise HTTPException(
            status_code=503, detail="Auto-fix policy file not configured"
        )
    return Path(path).expanduser()


def _read_policy(path: Path) -> Optional[dict]:
    """The policy document, or None when the file is missing. An unreadable
    file is refused rather than overwritten: it may be a hand edit."""
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except OSError:
        raise HTTPException(status_code=409, detail={"reason": "unreadable"})
    try:
        doc = json.loads(raw)
        if not isinstance(doc, dict) or not isinstance(doc.get("classes", []), list):
            raise ValueError
    except ValueError:
        raise HTTPException(status_code=409, detail={"reason": "unreadable"})
    return doc


def _write_policy(path: Path, doc: dict) -> None:
    """A temp file in the same folder, then a rename over the old one."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent)
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(doc, f, indent=2, ensure_ascii=False)
            f.write("\n")
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def _class_of(entry: dict) -> tuple:
    return (entry.get("store"), entry.get("rule"), entry.get("field"))


async def _feed_class(key: tuple) -> dict:
    """The class as the latest catalog_fixes document has it, fetched fresh:
    the last-known copy can't vouch for eligibility."""
    try:
        async with httpx.AsyncClient(timeout=commerce_routes._TIMEOUT_S) as client:
            resp = await client.get(
                f"{commerce_routes.HERMES_BRIDGE_URL}/panels/catalog_fixes"
            )
        if resp.status_code != 200:
            raise ValueError
        classes = resp.json()["data"].get("classes") or []
    except (httpx.HTTPError, ValueError, KeyError, TypeError, AttributeError):
        raise HTTPException(
            status_code=503, detail="Couldn't read the latest fixes feed"
        )
    for c in classes:
        if isinstance(c, dict) and _class_of(c) == key:
            return c
    raise HTTPException(status_code=409, detail={"reason": "unknown"})


def _policy_view(doc: Optional[dict]) -> dict:
    if doc is None:
        return {"exists": False, "updated_at": None, "classes": []}
    return {
        "exists": True,
        "updated_at": doc.get("updated_at"),
        "classes": [c for c in doc.get("classes", []) if isinstance(c, dict)],
    }


@fixes_router.get("/policy")
async def get_policy(request: Request) -> dict:
    """The auto-fix policy file as it stands (missing: no class auto-applies)."""
    _local_only(request)
    return _policy_view(_read_policy(_policy_path()))


@fixes_router.post("/policy")
async def set_tier(request: Request, body: TierBody) -> dict:
    """Raise a class to tier 1, only while the latest feed says it's eligible
    and its rules hash matches, or lower it to tier 0, always. Writes the
    policy file here; nothing is sent to Hermes."""
    _local_only(request)
    if body.field not in FIELDS:
        raise HTTPException(status_code=400, detail="Invalid field")
    key = (body.store, body.rule, body.field)
    path = _policy_path()
    doc = _read_policy(path)
    listed = [c for c in (doc or {}).get("classes", []) if isinstance(c, dict)]
    others = [c for c in listed if _class_of(c) != key]

    if body.tier == 0:
        # Lowering never needs the feed, and never creates the file.
        if doc is None or len(others) == len(listed):
            return _policy_view(doc)
        doc = {**doc, "version": 1, "updated_at": _now(), "classes": others}
        _write_policy(path, doc)
        return _policy_view(doc)

    feed_class = await _feed_class(key)
    if feed_class.get("eligible") is not True:
        raise HTTPException(status_code=409, detail={"reason": "not_eligible"})
    rules_sha = feed_class.get("rules_sha256")
    if not isinstance(rules_sha, str) or not _SHA.fullmatch(rules_sha):
        raise HTTPException(status_code=409, detail={"reason": "no_rules_hash"})
    if body.rules_sha256 != rules_sha:
        raise HTTPException(status_code=409, detail={"reason": "changed"})

    now = _now()
    entry: dict = {
        "store": body.store,
        "rule": body.rule,
        "field": body.field,
        "tier": 1,
        "since": now,
        "rules_sha256": rules_sha,
    }
    note = (body.note or "").strip()
    if note:
        entry["note"] = note
    doc = {**(doc or {}), "version": 1, "updated_at": now, "classes": [*others, entry]}
    _write_policy(path, doc)
    return _policy_view(doc)
