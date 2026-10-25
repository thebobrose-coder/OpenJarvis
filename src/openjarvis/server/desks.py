"""Desks (hq 0020 P2): the registry, the souls and the operator's rulings.

A desk is one role made conversable: a Chat thread with a desk id, a soul
file the operator owns, read-only tools, a default route and the pages it is
bound to. Contract: ``hq/contracts/openjarvis-hermes.md`` §1 "Desk endpoints".

- **Registry:** below. It holds no paths: each desk's folder is
  ``<workspace data>/desks/<id>/`` (credentials.toml ``[desks]``
  ``WORKSPACE_DATA_DIR``), where Hermes reads ``soul.md`` and ``rulings.md``.
- **Soul:** the operator edits ``soul.md`` from the Desks page (0020 D1): at
  most 8,000 characters, a sha256 check against the copy the page read, and
  an atomic write. Nothing else writes it, apart from :func:`seed_soul`,
  which only ever creates an absent file.
- **Rulings:** operator rulings only (0020 D6, 0019 D11), one table in
  OpenJarvis's sqlite memory. A clicked ``ruling`` card or the Rulings view
  is the only writer; the desk never writes memory itself. Every change
  rewrites ``rulings.md`` (atomic, newest first, at most 8,000 characters,
  oldest dropped). OpenJarvis is its only writer; Hermes only reads it.
"""

from __future__ import annotations

import hashlib
import os
import re
import sqlite3
import threading
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from openjarvis.core.paths import get_config_dir
from openjarvis.server.stack_routes import _local_only
from openjarvis.server.waiting_routes import _data_dir

desks_router = APIRouter(prefix="/api/desks", tags=["desks"])

SOUL_MAX = 8000
RULINGS_MAX = 8000
RULING_MAX = 500
CARD_KINDS = ("open", "tick", "proposal_decision", "ruling")

CONTENT_FEEDS = (
    "content_proposals",
    "content_seedbank",
    "content_performance",
    "content_winners",
    "content_health",
)
BD_FEEDS = ("bd_pipeline", "bd_stats")
COMMERCE_FEEDS = (
    "ecom_daily",
    "store_performance",
    "ecom_recommendations",
    "ecom_seo_health",
    "compliance_findings",
)
COMPLIANCE_FEEDS = ("compliance_findings",)


@dataclass(frozen=True)
class Desk:
    id: str
    name: str
    #: "local" (qwen on this machine) or "hermes" (the desk's Hermes profile).
    default_route: str
    #: The pages "Ask the desk" opens from, and the only targets of ``open``.
    pages: tuple[str, ...]
    #: The loopback tools a local turn may call (desk_tools.py).
    local_tools: tuple[str, ...]
    #: The panel feeds ``panel_feed`` may read on this desk.
    panel_feeds: tuple[str, ...]
    #: The Hermes profile's allowlist, as Hermes built it (shown, not enforced here).
    hermes_tools: tuple[str, ...]
    card_kinds: tuple[str, ...]
    #: What a turn costs, for the roster card.
    cost_note: str = ""
    #: False for a local-only desk (v1.19): no Hermes profile, and a forced
    #: "Hermes," turn is refused.
    hermes: bool = True

    def public(self) -> dict[str, Any]:
        return {
            k: list(v) if isinstance(v, tuple) else v for k, v in asdict(self).items()
        }


DESKS: dict[str, Desk] = {
    d.id: d
    for d in (
        Desk(
            id="content",
            name="Content desk",
            default_route="local",
            pages=("/content",),
            local_tools=("brand_context", "episode", "studio_status", "panel_feed"),
            panel_feeds=CONTENT_FEEDS,
            hermes_tools=(
                "content_proposals",
                "content_thesis_prompts",
                "session_search",
                "web_search",
                "web_extract",
            ),
            card_kinds=CARD_KINDS,
            cost_note=(
                "Local turns cost nothing. A Hermes turn measured $0.07-0.09, "
                "and it can't read the brand rules."
            ),
        ),
        Desk(
            id="bd",
            name="BD desk",
            default_route="hermes",
            pages=("/bizdev",),
            local_tools=("panel_feed",),
            panel_feeds=BD_FEEDS,
            hermes_tools=(
                "bd_due",
                "bd_templates",
                "bd_prospects",
                "session_search",
                "web_search",
                "web_extract",
            ),
            card_kinds=("open", "ruling"),
            cost_note=(
                '"Who is due" measured about $0.02 on Hermes (bd_due), and a '
                "drafted follow-up about $0.13. 'local,' reads the pipeline and "
                "stats at no cost."
            ),
        ),
        Desk(
            id="commerce",
            name="Commerce desk",
            default_route="hermes",
            pages=("/commerce", "/commerce#fixes"),
            local_tools=("panel_feed",),
            panel_feeds=COMMERCE_FEEDS,
            hermes_tools=(
                "ecom_briefing",
                "ecom_store_kpis",
                "ecom_products",
                "ecom_seo_health",
                "ecom_recommendations",
                "search_analytics",
                "ga4_report",
                "list_stores",
                "catalog_snapshot",
                "catalog_diff",
                "order_totals",
                "bundle_info",
                "list_properties",
                "get_property",
                "property_for_store",
                "session_search",
                "web_search",
                "web_extract",
            ),
            card_kinds=("open", "ruling"),
            cost_note=(
                "A Hermes turn measured $0.05-0.12. 'local,' reads the page's "
                "feeds at no cost."
            ),
        ),
        Desk(
            id="ops",
            name="Ops desk",
            default_route="local",
            pages=("/stack", "/logs"),
            local_tools=("stack_health", "health_events", "briefs", "runbook"),
            panel_feeds=(),
            hermes_tools=(),
            card_kinds=("open", "ruling"),
            cost_note="Local only: every turn runs on this machine and costs nothing.",
            hermes=False,
        ),
        Desk(
            id="compliance",
            name="Compliance desk",
            default_route="local",
            pages=("/commerce",),
            local_tools=("precheck", "brand_context", "panel_feed"),
            panel_feeds=COMPLIANCE_FEEDS,
            hermes_tools=(),
            card_kinds=("open", "ruling"),
            cost_note="Local only: every turn runs on this machine and costs nothing.",
            hermes=False,
        ),
    )
}


def get_desk(desk_id: str) -> Desk:
    desk = DESKS.get(desk_id)
    if desk is None:
        raise HTTPException(status_code=404, detail="No such desk")
    return desk


def desk_dir(desk_id: str) -> Path | None:
    """``<workspace data>/desks/<id>``, or None when the data folder isn't set."""
    data = _data_dir()
    return None if data is None else data / "desks" / get_desk(desk_id).id


def _require_dir(desk_id: str) -> Path:
    folder = desk_dir(desk_id)
    if folder is None:
        raise HTTPException(
            status_code=404, detail="Workspace data folder not configured"
        )
    return folder


def _iso(dt: datetime) -> str:
    return (
        dt.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    )


def _write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    tmp.write_bytes(text.encode("utf-8"))
    os.replace(tmp, path)


# ---------- souls ----------


def read_soul(desk_id: str) -> dict[str, Any]:
    folder = desk_dir(desk_id)
    path = None if folder is None else folder / "soul.md"
    raw = None
    if path is not None:
        try:
            raw = path.read_bytes()
        except OSError:
            raw = None
    text = None if raw is None else raw.decode("utf-8", errors="replace")
    return {
        "exists": raw is not None,
        "text": text,
        "hash": None if raw is None else hashlib.sha256(raw).hexdigest(),
        "chars": 0 if text is None else len(text),
        "max": SOUL_MAX,
    }


def soul_text(desk_id: str) -> str:
    """The soul for a local turn's system prompt, cut at the cap as Hermes cuts it."""
    return (read_soul(desk_id)["text"] or "")[:SOUL_MAX]


def write_soul(desk_id: str, text: str, expected_hash: str | None) -> dict[str, Any]:
    """Replace ``soul.md`` when it is still the copy the page read (A5-style)."""
    folder = _require_dir(desk_id)
    if len(text) > SOUL_MAX:
        raise HTTPException(
            status_code=400, detail=f"A soul is at most {SOUL_MAX:,} characters"
        )
    if not text.strip():
        raise HTTPException(status_code=400, detail="A soul can't be empty")
    current = read_soul(desk_id)
    if current["hash"] != expected_hash:
        raise HTTPException(
            status_code=409, detail="The soul changed since it was loaded; reload"
        )
    _write_atomic(folder / "soul.md", text)
    return read_soul(desk_id)


def seed_soul(desk_id: str, text: str) -> bool:
    """Create ``soul.md`` from a seed only when it is absent; the operator owns
    it after that. True when this call created it."""
    folder = _require_dir(desk_id)
    folder.mkdir(parents=True, exist_ok=True)
    try:
        with open(folder / "soul.md", "xb") as fh:
            fh.write(text[:SOUL_MAX].encode("utf-8"))
    except FileExistsError:
        return False
    return True


# ---------- rulings ----------


def _clean_ruling(text: str) -> str:
    text = re.sub(r"\s+", " ", text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="A ruling needs text")
    if len(text) > RULING_MAX:
        raise HTTPException(
            status_code=400, detail=f"A ruling is at most {RULING_MAX} characters"
        )
    return text


class RulingsStore:
    """Operator rulings, one table in OpenJarvis's sqlite memory database."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._lock = threading.Lock()

    def _connect(self) -> sqlite3.Connection:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        conn.execute(
            "CREATE TABLE IF NOT EXISTS desk_rulings ("
            " id INTEGER PRIMARY KEY AUTOINCREMENT,"
            " desk TEXT NOT NULL,"
            " text TEXT NOT NULL,"
            " created_at TEXT NOT NULL,"
            " updated_at TEXT NOT NULL,"
            " thread TEXT)"
        )
        return conn

    def list(self, desk: str) -> list[dict[str, Any]]:
        with self._lock, self._connect() as conn:
            rows = conn.execute(
                "SELECT id, text, created_at, updated_at, thread FROM desk_rulings"
                " WHERE desk = ? ORDER BY created_at DESC, id DESC",
                (desk,),
            ).fetchall()
        return [dict(r) for r in rows]

    def add(self, desk: str, text: str, thread: str | None, now: datetime) -> int:
        at = _iso(now)
        with self._lock, self._connect() as conn:
            cur = conn.execute(
                "INSERT INTO desk_rulings (desk, text, created_at, updated_at, thread)"
                " VALUES (?, ?, ?, ?, ?)",
                (desk, text, at, at, thread),
            )
            return int(cur.lastrowid)

    def update(self, desk: str, ruling_id: int, text: str, now: datetime) -> bool:
        with self._lock, self._connect() as conn:
            cur = conn.execute(
                "UPDATE desk_rulings SET text = ?, updated_at = ?"
                " WHERE id = ? AND desk = ?",
                (text, _iso(now), ruling_id, desk),
            )
            return cur.rowcount > 0

    def delete(self, desk: str, ruling_id: int) -> bool:
        with self._lock, self._connect() as conn:
            cur = conn.execute(
                "DELETE FROM desk_rulings WHERE id = ? AND desk = ?", (ruling_id, desk)
            )
            return cur.rowcount > 0


_store: RulingsStore | None = None


def rulings_store() -> RulingsStore:
    global _store
    if _store is None:
        _store = RulingsStore(get_config_dir() / "memory.db")
    return _store


EXPORT_HEADER = (
    "<!-- Written by OpenJarvis from the operator's rulings, newest first. "
    "Edit them in the app (Desks), not here. -->\n"
)


def render_rulings(rulings: list[dict[str, Any]], limit: int = RULINGS_MAX) -> str:
    """Newest first, one line each, within ``limit`` characters: the oldest
    rulings are dropped from the export (they stay in the store)."""
    out = EXPORT_HEADER
    for r in rulings:
        line = f"- {str(r['created_at'])[:10]}: {r['text']}\n"
        if len(out) + len(line) > limit:
            break
        out += line
    return out


def export_rulings(desk_id: str) -> int:
    """Rewrite ``rulings.md``; returns how many rulings it holds."""
    folder = _require_dir(desk_id)
    rulings = rulings_store().list(desk_id)
    text = render_rulings(rulings)
    _write_atomic(folder / "rulings.md", text)
    return sum(1 for line in text.splitlines() if line.startswith("- "))


def rulings_text(desk_id: str) -> str:
    """The rulings for a local turn's system prompt: the same text Hermes reads."""
    rulings = rulings_store().list(desk_id)
    return render_rulings(rulings).removeprefix(EXPORT_HEADER) if rulings else ""


def add_ruling(desk_id: str, text: str, thread: str | None = None) -> dict[str, Any]:
    get_desk(desk_id)
    _require_dir(desk_id)
    clean = _clean_ruling(text)
    rid = rulings_store().add(desk_id, clean, thread, datetime.now(timezone.utc))
    exported = export_rulings(desk_id)
    return {"id": rid, "text": clean, "exported": exported}


# ---------- routes ----------


def _desk_row(desk: Desk) -> dict[str, Any]:
    soul = read_soul(desk.id)
    return {
        **desk.public(),
        "soul": {k: soul[k] for k in ("exists", "hash", "chars", "max")},
        "rulings": len(rulings_store().list(desk.id)),
    }


@desks_router.get("")
def list_desks(request: Request):
    _local_only(request)
    return {
        "desks": [_desk_row(d) for d in DESKS.values()],
        "data_configured": _data_dir() is not None,
    }


@desks_router.get("/{desk_id}/soul")
def get_soul(desk_id: str, request: Request):
    _local_only(request)
    get_desk(desk_id)
    return read_soul(desk_id)


class SoulBody(BaseModel):
    text: str
    hash: str | None = None


@desks_router.put("/{desk_id}/soul")
def put_soul(desk_id: str, body: SoulBody, request: Request):
    _local_only(request)
    get_desk(desk_id)
    return write_soul(desk_id, body.text, body.hash)


@desks_router.get("/{desk_id}/rulings")
def get_rulings(desk_id: str, request: Request):
    _local_only(request)
    get_desk(desk_id)
    return {"rulings": rulings_store().list(desk_id), "max": RULING_MAX}


class RulingBody(BaseModel):
    text: str
    thread: str | None = None


@desks_router.post("/{desk_id}/rulings", status_code=201)
def post_ruling(desk_id: str, body: RulingBody, request: Request):
    _local_only(request)
    thread = (body.thread or "")[:64] or None
    return add_ruling(desk_id, body.text, thread)


@desks_router.put("/{desk_id}/rulings/{ruling_id}")
def put_ruling(desk_id: str, ruling_id: int, body: RulingBody, request: Request):
    _local_only(request)
    get_desk(desk_id)
    _require_dir(desk_id)
    clean = _clean_ruling(body.text)
    if not rulings_store().update(
        desk_id, ruling_id, clean, datetime.now(timezone.utc)
    ):
        raise HTTPException(status_code=404, detail="No such ruling")
    return {"id": ruling_id, "text": clean, "exported": export_rulings(desk_id)}


@desks_router.delete("/{desk_id}/rulings/{ruling_id}")
def delete_ruling(desk_id: str, ruling_id: int, request: Request):
    _local_only(request)
    get_desk(desk_id)
    _require_dir(desk_id)
    if not rulings_store().delete(desk_id, ruling_id):
        raise HTTPException(status_code=404, detail="No such ruling")
    return {"id": ruling_id, "exported": export_rulings(desk_id)}


# ---------- the paste-and-check widget (0020 P3) ----------


class PrecheckBody(BaseModel):
    propertyId: str  # noqa: N815 -- the CLI's own name
    text: str
    judge: bool = False


@desks_router.get("/compliance/properties")
def get_precheck_properties(request: Request):
    """The property ids the widget's select offers, from Foundry's bundle."""
    _local_only(request)
    from openjarvis.server import desk_tools

    return {"properties": desk_tools.property_ids()}


@desks_router.post("/compliance/precheck")
async def post_precheck(body: PrecheckBody, request: Request):
    """One pre-check. The Compliance desk's ``precheck`` tool runs the same
    ``run_precheck``: one implementation for the widget and the desk."""
    _local_only(request)
    from openjarvis.server import desk_tools

    return await desk_tools.run_precheck(body.propertyId, body.text, body.judge)
