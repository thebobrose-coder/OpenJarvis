"""FastAPI routes for the sidebar's stack-health dock (hq decision 0017 A2).

The operator's stack-health check runs as a scheduled task every 6 h and
writes its result file atomically; the cloud Health relay (0017) exports open
AWS and Google events to a second file. Both paths are local config in
credentials.toml (`[stack]`: `STACK_HEALTH_FILE`, `HEALTH_EVENTS_FILE`, and
`STACK_HEALTH_TASK`, the scheduled task's full name),
read per request with no cache: the files are local, like the Fixes tab's
auto-fix policy file. Nothing here reaches Hermes.

`GET /api/stack/health` summarises the result file for the dock: counts, the
FAIL and WARN rows in full, and the open cloud events within their window.
It also carries a `speech` block composed from that summary, which the voice
routes read as the local `stack_health` feed. `POST /api/stack/health/run`
starts the scheduled task; the server never runs the check itself. Both
routes answer only requests from this machine.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from openjarvis.core.credentials import get_tool_credential

stack_router = APIRouter(prefix="/api/stack", tags=["stack"])

TOOL = "stack"
HEALTH_KEY = "STACK_HEALTH_FILE"
EVENTS_KEY = "HEALTH_EVENTS_FILE"
TASK_KEY = "STACK_HEALTH_TASK"
STALE_AFTER_S = 7 * 3600  # the check runs every 6 h
_GOOGLE_NOTICE_DAYS = 14  # the same windows the check itself uses
_NOTICE_DAYS = 30
_OPEN = frozenset({"open", "upcoming"})
_LOOPBACK = frozenset({"127.0.0.1", "::1", "localhost"})
NO_RUN = "No stack-health run yet"


def _local_only(request: Request) -> None:
    """The dock reads the operator's own machine: refuse anything that didn't
    arrive over loopback."""
    host = request.client.host if request.client else ""
    if host not in _LOOPBACK:
        raise HTTPException(status_code=403, detail="Only from this machine")


def _parse_time(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        t = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def _age(t: datetime | None, now: datetime) -> int | None:
    return None if t is None else max(0, int((now - t).total_seconds()))


def _read_json(path: Path) -> Any:
    """The file's JSON; 503 naming the file (never its content) when it won't parse."""
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeDecodeError, ValueError):
        raise HTTPException(
            status_code=503, detail=f"{path.name} could not be read"
        ) from None


def _first_line(text: Any) -> str:
    lines = str(text or "").strip().splitlines()
    return lines[0].strip() if lines else ""


def _cloud_events(doc: Any, now: datetime) -> list[dict[str, Any]]:
    """Open or upcoming events within their window, newest first."""
    events = doc.get("events") if isinstance(doc, dict) else None
    out = []
    for e in events if isinstance(events, list) else []:
        if not isinstance(e, dict) or str(e.get("statusCode", "")).lower() not in _OPEN:
            continue
        category = str(e.get("eventTypeCategory") or "")
        updated = _parse_time(e.get("lastUpdatedTime")) or _parse_time(
            e.get("startTime")
        )
        age = _age(updated, now)
        if category != "issue" and age is not None:
            google = e.get("eventTypeCode") == "GOOGLE_NOTICE"
            days = _GOOGLE_NOTICE_DAYS if google else _NOTICE_DAYS
            if age > days * 86400:
                continue
        description = str(e.get("description") or "").strip()
        out.append(
            {
                "alias": e.get("account") or "unknown",
                "service": e.get("service") or "",
                "type": e.get("eventTypeCode") or "",
                "category": category,
                "status": str(e.get("statusCode", "")).lower(),
                "region": e.get("region") or "",
                "last_updated": e.get("lastUpdatedTime") or e.get("startTime"),
                "age_seconds": age,
                "description_first_line": _first_line(description),
                "description": description,
            }
        )
    out.sort(key=lambda ev: (ev["age_seconds"] is None, ev["age_seconds"] or 0))
    return out


def _rows(results: list[Any], status: str) -> list[dict[str, Any]]:
    return [
        {
            "area": str(r.get("area") or ""),
            "check": str(r.get("check") or ""),
            "status": status,
            "evidence": str(r.get("evidence") or ""),
        }
        for r in results
        if isinstance(r, dict) and str(r.get("status", "")).upper() == status
    ]


def _plural(n: int, word: str) -> str:
    return f"{n} {word}" if n == 1 else f"{n} {word}s"


def speech_text(summary: dict[str, Any]) -> str:
    """What Speak reads: the counts, then each warning and failure by name."""
    counts = summary["counts"]
    ran = _parse_time(summary.get("ran_at"))
    at = ran.astimezone().strftime("%H:%M") if ran else "an unknown time"
    parts = [
        f"Stack health at {at}: {counts.get('OK', 0)} OK, "
        f"{_plural(counts.get('WARN', 0), 'warning')}, "
        f"{_plural(counts.get('FAIL', 0), 'failure')}."
    ]
    for label, key in (("Warnings", "warning"), ("Failures", "failing")):
        rows = summary[key]
        if rows:
            names = "; ".join(f"{r['area']} {r['check']}".strip() for r in rows)
            parts.append(f"{label}: {names}.")
    events = summary["cloud_events"]
    if events:
        names = "; ".join(f"{e['alias']} {e['service']}".strip() for e in events[:5])
        parts.append(f"{_plural(len(events), 'open cloud event')}: {names}.")
    return " ".join(parts)


def _speech_block(summary: dict[str, Any]) -> dict[str, Any]:
    text = speech_text(summary)
    return {
        # Content-addressed, so the voice worker's cache follows the text.
        "id": hashlib.sha256(text.encode("utf-8")).hexdigest()[:16],
        "title": "Stack health",
        "text": text,
        "mood": "neutral",
        "priority": "alert" if summary["counts"].get("FAIL") else "info",
        "lane": "fast",
        "created_at": summary.get("ran_at"),
        "source_feed": "stack_health",
    }


def _configured(key: str) -> Path | None:
    value = get_tool_credential(TOOL, key)
    return Path(value).expanduser() if value else None


def read_summary(now: datetime | None = None) -> dict[str, Any]:
    """The dock's summary of the local files; raises 404 / 503 as the route does."""
    now = now or datetime.now(timezone.utc)
    path = _configured(HEALTH_KEY)
    if path is None or not path.is_file():
        raise HTTPException(status_code=404, detail=NO_RUN)
    doc = _read_json(path)
    if not isinstance(doc, dict) or not isinstance(doc.get("results"), list):
        raise HTTPException(status_code=503, detail=f"{path.name} could not be read")
    results = doc["results"]
    raw_counts = doc.get("counts") if isinstance(doc.get("counts"), dict) else {}
    counts = {}
    for k in ("OK", "WARN", "FAIL", "SKIP"):
        n = raw_counts.get(k)
        counts[k] = (
            n
            if isinstance(n, int)
            else sum(
                1
                for r in results
                if isinstance(r, dict) and str(r.get("status", "")).upper() == k
            )
        )
    ran_at = doc.get("ran_at")
    age = _age(_parse_time(ran_at), now)

    cloud_events: list[dict[str, Any]] = []
    cloud_error = None
    events_path = _configured(EVENTS_KEY)
    if events_path is not None and events_path.is_file():
        try:
            cloud_events = _cloud_events(_read_json(events_path), now)
        except HTTPException as exc:
            cloud_error = exc.detail  # the local checks still show

    summary = {
        "ran_at": ran_at,
        "duration_ms": doc.get("duration_ms"),
        "age_seconds": age,
        "stale": age is None or age > STALE_AFTER_S,
        "counts": counts,
        "failing": _rows(results, "FAIL"),
        "warning": _rows(results, "WARN"),
        "skipped": counts["SKIP"],
        "cloud_events": cloud_events,
        "cloud_error": cloud_error,
    }
    summary["speech"] = [_speech_block(summary)]
    return summary


def speech_blocks() -> list[dict[str, Any]]:
    """The local `stack_health` feed's speech, for the voice routes."""
    return read_summary()["speech"]


@stack_router.get("/health")
def get_health(request: Request):
    _local_only(request)
    return read_summary()


@stack_router.post("/health/run", status_code=202)
def run_health(request: Request):
    """Start the operator's scheduled task now; it writes a new result file."""
    _local_only(request)
    if sys.platform != "win32":
        raise HTTPException(status_code=501, detail="Only on Windows")
    task = get_tool_credential(TOOL, TASK_KEY)
    if not task:
        raise HTTPException(status_code=503, detail="Stack-health task not configured")
    try:
        proc = subprocess.run(
            ["schtasks", "/Run", "/TN", task],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise HTTPException(
            status_code=503, detail=f"schtasks failed: {type(exc).__name__}"
        ) from None
    if proc.returncode != 0:
        detail = _first_line(proc.stderr) or _first_line(proc.stdout)
        raise HTTPException(status_code=503, detail=detail[:200] or "schtasks failed")
    return JSONResponse(status_code=202, content={"started": True})
