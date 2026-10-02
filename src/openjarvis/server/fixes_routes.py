"""FastAPI routes for the Commerce page's Fixes tab -- the operator's
decisions on Hermes's catalog fixes (hq/contracts/openjarvis-hermes.md v1.3.2
§2, "Catalog fixes").

The feed itself (`catalog_fixes`) is read through `/api/commerce/<feed>`
like the other ecom feeds. These routes forward the decision POSTs to the
bridge's `/fixes/*` routes, adding the `X-Operator-Token` header here: the
token is a file the operator created, its path is local config
(`HERMES_FIX_TOKEN_FILE` in credentials.toml, tool `hermes`), and it is read
per request, never logged, and never sent to the frontend. The bridge's
202 / 401 / 409 answers are passed through as they come.

In P1 nothing is written to Shopify: the bridge records each decision for
the next phase to apply.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from openjarvis.core.credentials import get_tool_credential
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


@fixes_router.post("/approve-class")
async def approve_class(body: ApproveClassBody) -> JSONResponse:
    """Approve the listed patches of one class (not a tier change)."""
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
    return await _post(
        "/fixes/approve-class", _with_note(payload, body.note), _operator_headers()
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
