"""FastAPI routes for "Waiting on you" and the Decisions drawer (hq 0020 P1).

One list of everything waiting on the operator, for the bell and the
Dashboard panel. It is an index, not a queue: every row links to the page
that already holds the action, and nothing here decides anything.

Sources, merged per request (the page polls every 60 s):
- Hermes's ``approvals`` feed (contract v1.17 block 2) through the bridge;
- x402 from ``trading_status``: a KILL, a failing heartbeat, a stale status;
- G0: studio manifests at ``awaiting-g0`` (foundry-studio.md);
- decision boxes: unticked ``- [ ] **Dn.`` lines in the inbox briefs (0020 A5);
- blocked work orders and failed orders from the dispatcher's reports;
- G1 and G2 rows from Foundry's G1 mirror (foundry-g1-mirror.md), when its URL
  and AWS profile are configured (``g1_routes``); they open the G1 drawer.

The local folders come from one setting, the private workspace's data root
(credentials.toml ``[desks] WORKSPACE_DATA_DIR``). Without it the local kinds
are simply absent. A missing or broken source never fails the list: its
entry in ``sources`` carries the error instead.

``POST /api/decisions/tick`` is the one write: it ticks one decision box in
exactly the A5 form. Every route answers only requests from this machine.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from openjarvis.core.credentials import get_tool_credential
from openjarvis.server.hermes_panel import HermesPanel
from openjarvis.server.stack_routes import _local_only

waiting_router = APIRouter(prefix="/api", tags=["waiting"])

TOOL = "desks"
DATA_KEY = "WORKSPACE_DATA_DIR"
approvals_panel = HermesPanel("approvals", "HERMES_APPROVALS_URL")

TRADING_STALE_S = 15 * 60  # the Trading view's own threshold
WORKORDER_DAYS = 7
DECIDED_DAYS = 14
DECIDED_MAX = 30
NOTE_MAX = 500
HERMES_KINDS = ("proposal", "thesis_prompt", "patch", "follow_up", "rec")
LOCAL_KINDS = ("g0", "decision", "x402", "workorder", "g1")


def _data_dir() -> Path | None:
    value = get_tool_credential(TOOL, DATA_KEY)
    return Path(value).expanduser() if value else None


def _iso(dt: datetime) -> str:
    return (
        dt.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    )


def _mtime(path: Path) -> datetime:
    return datetime.fromtimestamp(path.stat().st_mtime, timezone.utc)


def _parse_time(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        t = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def _source(at: datetime | None, now: datetime, **extra: Any) -> dict[str, Any]:
    age = None if at is None else max(0, int((now - at).total_seconds()))
    return {"generated_at": _iso(at) if at else None, "age_seconds": age, **extra}


def _clip(text: Any, n: int) -> str:
    s = " ".join(str(text or "").split())
    return s if len(s) <= n else s[: n - 1] + "…"


# ---------- decision boxes (0020 A5) ----------

BOX = re.compile(r"^(\s*[-*]\s+)\[([ xX])\](\s+\*\*D(\d+)\.)")
_BOLD_END = re.compile(r"\*\*")
_ALT = re.compile(r"[*_]{0,2}\bAlternatives?:[*_]{0,2}\s*", re.I)
_DEFAULT = re.compile(r"[*_]{0,2}\bDefault:[*_]{0,2}\s*", re.I)
_DECIDED = re.compile(r"\*\*DECIDED\b", re.I)


def _title(text: str, fallback: str) -> str:
    for line in text.splitlines():
        if line.startswith("# "):
            return line[2:].strip()
    return fallback


def _paragraph(lines: list[str], i: int) -> str:
    """The non-blank block around line ``i``, without the other boxes in it."""
    start = i
    while start > 0 and lines[start - 1].strip() and not BOX.match(lines[start - 1]):
        start -= 1
    end = i + 1
    while end < len(lines) and lines[end].strip() and not BOX.match(lines[end]):
        end += 1
    return "\n".join(line.rstrip("\r\n") for line in lines[start:end]).strip()


def _box(line: str) -> dict[str, Any] | None:
    m = BOX.match(line)
    if not m:
        return None
    rest = line[m.end() :].rstrip("\r\n")
    close = _BOLD_END.search(rest)
    decision = (rest[: close.start()] if close else rest).strip().rstrip(".").strip()
    after = rest[close.end() :] if close else ""
    decided = _DECIDED.search(after)
    body = after[: decided.start()] if decided else after
    alt = _ALT.search(body)
    alternative = body[alt.end() :].strip().rstrip(".;,_").strip() if alt else ""
    head = body[: alt.start()] if alt else body
    # Two forms: "**Dn. The proposal** ... Alternative: ..." (the bold part is
    # the default) and "**Dn. Topic.** *Default:* ... *Alternative:* ...".
    dflt = _DEFAULT.search(head)
    default = head[dflt.end() :].strip().rstrip(".;,_").strip() if dflt else ""
    return {
        "number": int(m.group(4)),
        "ticked": m.group(2) != " ",
        "decision": decision,
        "default": default or decision,
        "alternative": alternative or None,
        "text": rest.strip(),
        "decided_note": after[decided.start() :].strip() if decided else None,
    }


def _md_files(root: Path) -> list[Path]:
    return sorted(p for p in root.glob("*/*.md") if p.is_file())


def _result_empty(lines: list[str]) -> bool:
    """No ``## Result`` yet, or the heading with nothing under it."""
    for i, line in enumerate(lines):
        if line.strip().lower() == "## result":
            for nxt in lines[i + 1 :]:
                if nxt.startswith("## "):
                    return True
                if nxt.strip():
                    return False
            return True
    return True


def read_decisions(data: Path, now: datetime | None = None) -> dict[str, Any]:
    now = now or datetime.now(timezone.utc)
    inbox, archive = data / "inbox", data / "archive"
    open_boxes, decided, waiting = [], [], []
    for path in _md_files(inbox) if inbox.is_dir() else []:
        raw = path.read_bytes()
        text = raw.decode("utf-8", errors="replace")
        lines = text.splitlines(keepends=True)
        rel = path.relative_to(inbox).as_posix()
        brief = {
            "file": rel,
            "folder": path.parent.name,
            "title": _title(text, path.stem),
            "modified_at": _iso(_mtime(path)),
        }
        sha = hashlib.sha256(raw).hexdigest()
        for i, line in enumerate(lines):
            box = _box(line)
            if box is None:
                continue
            row = {**brief, **box, "line": i + 1, "hash": sha}
            if box["ticked"]:
                decided.append({**row, "archived": False})
            else:
                open_boxes.append({**row, "paragraph": _paragraph(lines, i)})
        if _result_empty(lines):
            waiting.append(brief)
    cutoff = now - timedelta(days=DECIDED_DAYS)
    for path in _md_files(archive) if archive.is_dir() else []:
        if _mtime(path) < cutoff:
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        for i, line in enumerate(text.splitlines()):
            box = _box(line)
            if box and box["ticked"]:
                decided.append(
                    {
                        "file": path.relative_to(archive).as_posix(),
                        "folder": path.parent.name,
                        "title": _title(text, path.stem),
                        "modified_at": _iso(_mtime(path)),
                        **box,
                        "line": i + 1,
                        "archived": True,
                    }
                )
    decided.sort(key=lambda r: r["modified_at"], reverse=True)
    return {
        "open": open_boxes,
        "waiting_briefs": waiting,
        "recently_decided": decided[:DECIDED_MAX],
    }


def tick_line(line: str, today: str, note: str) -> str:
    """``- [ ]`` to ``- [x]`` on one box line, plus the A5 stamp."""
    m = BOX.match(line)
    if not m or m.group(2) != " ":
        raise ValueError("not an unticked decision box")
    body = line.rstrip("\r\n")
    ending = line[len(body) :]
    stamp = f" **DECIDED {today} (app)**" + (f" {note}" if note else "")
    return f"{m.group(1)}[x]{body[m.end(2) + 1 :]}{stamp}{ending}"


def tick_box(
    data: Path, file: str, line_no: int, expected_hash: str, note: str, today: str
) -> dict[str, Any]:
    """Tick one box under ``<data>/inbox``; 409 when the file changed or the
    box is already ticked, 400 for anything outside the inbox."""
    inbox = (data / "inbox").resolve()
    rel = Path(file)
    if (
        rel.is_absolute()
        or ".." in rel.parts
        or rel.suffix.lower() != ".md"
        or len(rel.parts) != 2
    ):
        raise HTTPException(
            status_code=400, detail="Only an inbox brief (<folder>/<name>.md)"
        )
    path = (inbox / rel).resolve()
    if not path.is_relative_to(inbox) or not path.is_file():
        raise HTTPException(
            status_code=400, detail="Only an inbox brief (<folder>/<name>.md)"
        )
    note = (note or "").strip()
    if "\n" in note or "\r" in note or len(note) > NOTE_MAX:
        raise HTTPException(
            status_code=400,
            detail=f"The note is one line, at most {NOTE_MAX} characters",
        )
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != expected_hash:
        raise HTTPException(
            status_code=409, detail="The brief changed since it was listed; reload"
        )
    lines = raw.decode("utf-8").splitlines(keepends=True)
    if not 1 <= line_no <= len(lines):
        raise HTTPException(status_code=409, detail="That line is gone; reload")
    box = _box(lines[line_no - 1])
    if box is None:
        raise HTTPException(
            status_code=409, detail="That line is not a decision box; reload"
        )
    if box["ticked"]:
        raise HTTPException(status_code=409, detail="Already decided")
    lines[line_no - 1] = tick_line(lines[line_no - 1], today, note)
    out = "".join(lines).encode("utf-8")
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_bytes(out)
    os.replace(tmp, path)
    return {
        "file": file,
        "line": line_no,
        "text": lines[line_no - 1].rstrip("\r\n"),
        "hash": hashlib.sha256(out).hexdigest(),
    }


# ---------- local kinds ----------


def _decision_items(decisions: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        {
            "kind": "decision",
            "id": f"{b['file']}:{b['line']}",
            "source_feed": "inbox",
            "scope": b["folder"],
            "title": _clip(f"D{b['number']}. {b['decision']}", 140),
            "detail": _clip(b["title"], 280),
            "created_at": b["modified_at"],
            "due": None,
            "priority": None,
            "link": None,
            "opens": "decisions",
        }
        for b in decisions["open"]
    ]


def _g0_items(data: Path) -> tuple[list[dict[str, Any]], datetime | None]:
    studio = data / "studio"
    items, newest = [], None
    if not studio.is_dir():
        return items, None
    for manifest in studio.glob("*/*/manifest.json"):
        try:
            doc = json.loads(manifest.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        at = _mtime(manifest)
        newest = max(newest, at) if newest else at
        if not isinstance(doc, dict) or doc.get("stage") != "awaiting-g0":
            continue
        stages = doc.get("stages") if isinstance(doc.get("stages"), list) else []
        since = next(
            (
                s.get("at")
                for s in reversed(stages)
                if isinstance(s, dict) and s.get("stage") == "awaiting-g0"
            ),
            None,
        )
        eid = str(doc.get("episodeId") or manifest.parent.name)
        items.append(
            {
                "kind": "g0",
                "id": eid,
                "source_feed": "studio",
                "scope": doc.get("propertyId") or manifest.parent.parent.name,
                "title": _clip(doc.get("title") or f"Episode {eid}", 140),
                "detail": _clip(
                    f"Script review: {doc.get('episodeClass') or 'episode'}", 280
                ),
                "created_at": since or _iso(at),
                "due": None,
                "priority": None,
                "link": {"page": "/content", "focus": eid},
            }
        )
    return items, newest


def _workorder_items(
    data: Path, now: datetime
) -> tuple[list[dict[str, Any]], datetime | None]:
    root = data / "workorders"
    items, newest = [], None
    cutoff = now - timedelta(days=WORKORDER_DAYS)
    for folder, wanted in (("blocked", {"blocked", "rejected"}), ("done", {"failed"})):
        for report in (
            (root / folder).glob("*.report.json") if (root / folder).is_dir() else []
        ):
            try:
                doc = json.loads(report.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            at = _parse_time(doc.get("finishedAt")) if isinstance(doc, dict) else None
            at = at or _mtime(report)
            newest = max(newest, at) if newest else at
            if (
                not isinstance(doc, dict)
                or doc.get("status") not in wanted
                or at < cutoff
            ):
                continue
            claude = doc.get("claude") if isinstance(doc.get("claude"), dict) else {}
            detail = (
                claude.get("needsHuman") or doc.get("reason") or claude.get("summary")
            )
            items.append(
                {
                    "kind": "workorder",
                    "id": str(doc.get("id") or report.name.split(".")[0]),
                    "source_feed": "workorders",
                    "scope": doc.get("repo") or None,
                    "title": _clip(
                        f"Work order {doc.get('id')}: {doc.get('status')}", 140
                    ),
                    "detail": _clip(detail, 280) or None,
                    "created_at": _iso(at),
                    "due": None,
                    "priority": None,
                    "link": None,
                }
            )
    return items, newest


def x402_items(status: dict[str, Any] | None, now: datetime) -> list[dict[str, Any]]:
    """What should ring for the trader: a KILL, a failing heartbeat, a stale status."""
    if not status:
        return []
    at = status.get("generated_at") or _iso(now)
    rows: list[tuple[str, str, str | None]] = []
    sleeves = status.get("sleeves") if isinstance(status.get("sleeves"), dict) else {}
    killed = [
        n
        for n, s in sleeves.items()
        if isinstance(s, dict) and s.get("halt_state") == "KILL"
    ]
    for name in killed:
        rows.append((f"kill-{name}", f"KILL: {name}", None))
    kill = status.get("kill") if isinstance(status.get("kill"), dict) else {}
    if not killed and (kill.get("local_file") is True or kill.get("aws_flag") is True):
        rows.append(("kill", "Kill switch set", kill.get("last_cause")))
    hb = status.get("heartbeat") if isinstance(status.get("heartbeat"), dict) else {}
    # The Trading view's rule: `alarm` is the CloudWatch state (OK / ALARM).
    if hb.get("last_ok") is False or hb.get("alarm") == "ALARM":
        rows.append(("heartbeat", "Trader heartbeat failing", "Not reporting to AWS"))
    written = _parse_time(status.get("written_at"))
    age = status.get("age_seconds")
    if (
        status.get("stale")
        or (written and (now - written).total_seconds() > TRADING_STALE_S)
        or (isinstance(age, int) and age > TRADING_STALE_S)
    ):
        rows.append(("stale", "Trading status is stale", status.get("stale_reason")))
    return [
        {
            "kind": "x402",
            "id": rid,
            "source_feed": "trading_status",
            "scope": None,
            "title": title,
            "detail": _clip(detail, 280) or None,
            "created_at": at,
            "due": None,
            "priority": 1,
            "link": {"page": "/trading", "focus": None},
        }
        for rid, title, detail in rows
    ]


def g1_items(listing: dict[str, Any]) -> list[dict[str, Any]]:
    """The mirror's rows as "Waiting on you" rows: the card's headline, never
    its links. G2 rows are listed for reading; they're decided in Telegram."""
    rows = []
    for item in listing.get("items") or []:
        episode = item.get("contentType") == "episode"
        decidable = bool(item.get("decidable"))
        title = item.get("headline") or item.get("executionName") or "Approval"
        detail = (
            "G2: compliance flagged, decide in Telegram"
            if not decidable
            else ("Episode for YouTube" if episode else item.get("contentType"))
        )
        rows.append(
            {
                "kind": "g1",
                "id": str(item.get("approvalId")),
                "source_feed": "g1_mirror",
                "scope": item.get("propertyId"),
                "title": _clip(f"Episode: {title}" if episode else title, 140),
                "detail": _clip(detail, 280) or None,
                "created_at": item.get("createdAt"),
                "due": item.get("expiresAt"),
                "priority": 1 if decidable else None,
                "link": None,
                "opens": "g1",
            }
        )
    return rows


async def _g1() -> tuple[dict[str, Any] | None, str | None]:
    """The mirror's listing (None when not configured) or the error text."""
    from openjarvis.server.g1_routes import MirrorError, listing

    try:
        return await listing(), None
    except MirrorError as exc:
        return None, str(exc)


# ---------- the merged list ----------


async def _hermes() -> tuple[dict[str, Any] | None, str | None]:
    try:
        return await approvals_panel.get("No approvals index yet"), None
    except HTTPException as exc:
        return None, str(exc.detail)


async def _trading() -> tuple[dict[str, Any] | None, str | None]:
    from openjarvis.server.trading_routes import get_feed

    try:
        return await get_feed("trading_status"), None
    except HTTPException as exc:
        return None, str(exc.detail)


async def build_waiting(now: datetime | None = None) -> dict[str, Any]:
    now = now or datetime.now(timezone.utc)
    counts = {k: 0 for k in (*HERMES_KINDS, *LOCAL_KINDS)}
    items: list[dict[str, Any]] = []
    sources: dict[str, Any] = {}

    hermes, error = await _hermes()
    if hermes:
        hc = hermes.get("counts") if isinstance(hermes.get("counts"), dict) else {}
        for k in HERMES_KINDS:
            counts[k] = int(hc.get(k) or 0)
        items += [i for i in hermes.get("items") or [] if isinstance(i, dict)]
        sources["approvals"] = {
            "generated_at": hermes.get("generated_at"),
            "age_seconds": hermes.get("age_seconds"),
            "stale": bool(hermes.get("stale")),
            "feeds": hermes.get("sources") or {},
        }
    else:
        sources["approvals"] = {
            "generated_at": None,
            "age_seconds": None,
            "stale": True,
            "error": error,
        }

    trading, error = await _trading()
    x402 = x402_items(trading, now)
    counts["x402"] = len(x402)
    items += x402
    sources["trading_status"] = (
        {
            "generated_at": trading.get("generated_at"),
            "age_seconds": trading.get("age_seconds"),
            "stale": bool(trading.get("stale")),
        }
        if trading
        else {"generated_at": None, "age_seconds": None, "stale": True, "error": error}
    )

    data = _data_dir()
    if data is not None:
        try:
            decisions = read_decisions(data, now)
            rows = _decision_items(decisions)
            counts["decision"] = len(rows)
            items += rows
            sources["inbox"] = _source(now, now)
        except OSError as exc:
            sources["inbox"] = {"generated_at": None, "error": type(exc).__name__}
        for kind, fn in (
            ("g0", lambda: _g0_items(data)),
            ("workorder", lambda: _workorder_items(data, now)),
        ):
            name = "studio" if kind == "g0" else "workorders"
            try:
                rows, newest = fn()
                counts[kind] = len(rows)
                items += rows
                sources[name] = _source(newest, now)
            except OSError as exc:
                sources[name] = {"generated_at": None, "error": type(exc).__name__}

    g1, error = await _g1()
    if g1 is not None:
        rows = g1_items(g1)
        counts["g1"] = len(rows)
        items += rows
        at = _parse_time(g1.get("generatedAt"))
        sources["g1_mirror"] = _source(at or now, now)
    elif error:
        sources["g1_mirror"] = {"generated_at": None, "error": error}

    counts["total"] = sum(counts[k] for k in (*HERMES_KINDS, *LOCAL_KINDS))
    return {
        "generated_at": _iso(now),
        "counts": counts,
        "items": items,
        "sources": sources,
        "local": data is not None,
    }


@waiting_router.get("/waiting")
async def get_waiting(request: Request):
    _local_only(request)
    return await build_waiting()


@waiting_router.get("/decisions")
def get_decisions(request: Request):
    _local_only(request)
    data = _data_dir()
    if data is None:
        raise HTTPException(
            status_code=404, detail="Workspace data folder not configured"
        )
    return read_decisions(data)


class TickBody(BaseModel):
    file: str
    line: int
    hash: str
    note: str = ""


@waiting_router.post("/decisions/tick")
def post_tick(body: TickBody, request: Request):
    _local_only(request)
    data = _data_dir()
    if data is None:
        raise HTTPException(
            status_code=404, detail="Workspace data folder not configured"
        )
    today = datetime.now().astimezone().strftime("%Y-%m-%d")
    return tick_box(data, body.file, body.line, body.hash, body.note, today)
