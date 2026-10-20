"""FastAPI routes for the latest breaking-news alert -- a read-through proxy
for the Hermes alert feed.

Hermes (the news-monitor role) now owns detection and triage and publishes
the latest alert at `/panels/breaking_alerts` on the local bridge (contract
hq/contracts/openjarvis-hermes.md v0.3 §2). This route passes it through in
the shape the sidebar already reads, and OpenJarvis keeps speaking alerts
with its own TTS: each new alert (new `generated_at`) is synthesized once,
with the digest voice settings (`[digest]` in config.toml).

Alerts are sparse by design -- the bridge 404s until the first one fires,
which maps to the same "no alerts yet" 404 as before. The last good alert is
kept in memory, so a Hermes restart degrades to a stale-flagged copy rather
than an empty sidebar item.

`/recent` (contract v1.7) passes through `/panels/breaking_alerts/recent`, the
last N hours of alerts newest first, for the sidebar's list. It never
synthesizes audio: only the newest alert (the root route) is spoken.

Severity gate (hq 0017 A3): only rows at `BREAKING_VOICE_MIN_SEVERITY` or
above become the latest alert and get audio. A quieter row (a maintenance
notice at 6) stays in the feed and in `/recent`, but never displaces the
latest alert. When the bridge's newest row is below the bar, the latest is
the newest passing row in the last 72 h of `/recent`, else the last passing
alert this process saw.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse

logger = logging.getLogger(__name__)

HERMES_BREAKING_URL = os.environ.get(
    "HERMES_BREAKING_URL", "http://127.0.0.1:8643/panels/breaking_alerts"
)
_TIMEOUT_S = 10.0
# hq 0017 A3 (contract `breaking_alerts` lanes): 9 and 10 wake the human, 6
# and 7 are worth seeing. Not configurable; a code change if it ever moves.
BREAKING_VOICE_MIN_SEVERITY = 9
# Bridge limits for /recent (contract v1.7); out-of-range values are clamped.
_HOURS_RANGE = (1, 72)
_LIMIT_RANGE = (1, 10)

_AUDIO_MEDIA_TYPES = {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
}

# Last good bridge payload, plus the audio synthesized for it. The audio is
# keyed by the alert's `generated_at` so each alert is spoken exactly once.
_cache: dict | None = None
_audio: dict = {"generated_at": None, "path": None}
_audio_lock = asyncio.Lock()
# Last good /recent rows, per (hours, limit).
_recent_cache: dict[tuple[int, int], list[dict]] = {}


def voiced(data: dict) -> bool:
    """A row rings and speaks at severity 9+. A missing or non-numeric
    severity counts as 9, so no legacy row goes quiet."""
    sev = data.get("severity")
    if sev is None or isinstance(sev, bool):
        return True
    try:
        return float(sev) >= BREAKING_VOICE_MIN_SEVERITY
    except (TypeError, ValueError):
        return True


async def _newest_voiced(client: httpx.AsyncClient) -> dict | None:
    """The newest passing row the bridge still lists (72 h, 10 rows)."""
    resp = await client.get(
        f"{HERMES_BREAKING_URL}/recent",
        params={"hours": _HOURS_RANGE[1], "limit": _LIMIT_RANGE[1]},
    )
    if resp.status_code != 200:
        return None
    rows = [
        r
        for r in resp.json()["rows"]
        if isinstance(r, dict) and "headline" in r["data"] and voiced(r["data"])
    ]
    rows.sort(key=lambda r: r["generated_at"], reverse=True)
    return rows[0] if rows else None


def _synthesize(headline: str, summary: str, generated_at: str) -> Path | None:
    """Speak the alert with the digest voice; return a per-alert audio file.

    TextToSpeechTool always writes `digest.<ext>`, so the file is renamed to a
    per-alert name: a path that changes per alert is what makes the sidebar's
    <audio> element reload (the d74dc501 digest fix, same cause).
    """
    from openjarvis.core.config import load_config
    from openjarvis.core.paths import get_config_dir
    from openjarvis.tools.text_to_speech import TextToSpeechTool

    dc = load_config().digest
    out_dir = get_config_dir() / "digests" / "breaking"
    result = TextToSpeechTool().execute(
        text=f"{headline}. {summary}",
        voice_id=dc.voice_id,
        backend=dc.tts_backend,
        speed=dc.voice_speed,
        output_dir=str(out_dir),
    )
    raw = result.metadata.get("audio_path", "") if result.success else ""
    if not raw or not Path(raw).exists():
        logger.warning("Breaking-news TTS produced no audio: %s", result.content)
        return None

    src = Path(raw)
    stamp = re.sub(r"[^0-9A-Za-z]", "", generated_at) or "latest"
    dest = src.with_name(f"breaking-{stamp}{src.suffix}")
    src.replace(dest)
    for old in out_dir.glob("breaking-*"):
        if old != dest:
            old.unlink(missing_ok=True)
    return dest


async def _ensure_audio(payload: dict) -> Path | None:
    """Synthesize audio once per new alert; later calls reuse it. A row
    below the severity bar never gets audio."""
    if not voiced(payload["data"]):
        return None
    generated_at = payload["generated_at"]
    async with _audio_lock:
        if _audio["generated_at"] != generated_at:
            data = payload["data"]
            try:
                path = await asyncio.to_thread(
                    _synthesize, data["headline"], data.get("summary", ""), generated_at
                )
            except Exception:  # noqa: BLE001 -- audio is optional; never fail the alert
                logger.warning("Breaking-news TTS failed", exc_info=True)
                path = None
            # Record the attempt either way: once per alert, not per request.
            _audio.update(generated_at=generated_at, path=path)
    path = _audio["path"]
    return path if path is not None and path.exists() else None


def _shape(payload: dict, audio_path: Path | None, stale: bool) -> dict:
    data = payload["data"]
    return {
        "headline": data["headline"],
        "summary": data.get("summary", ""),
        "url": data.get("url", ""),
        "alerted_at": payload["generated_at"],
        "audio_available": audio_path is not None,
        "audio_path": str(audio_path) if audio_path is not None else None,
        "severity": data.get("severity"),
        "tickers": data.get("tickers") or [],
        "why": data.get("why", ""),
        "stale": stale,
    }


def _clamp(value: int, bounds: tuple[int, int]) -> int:
    return max(bounds[0], min(bounds[1], value))


def _kind(data: dict) -> str:
    """Contract v1.7: a row without `kind` is `news`, or `trading` by source."""
    kind = data.get("kind")
    if kind:
        return kind
    return "trading" if data.get("source") == "trading" else "news"


def _shape_recent(row: dict) -> dict:
    data = row["data"]
    return {
        "headline": data["headline"],
        "summary": data.get("summary", ""),
        "url": data.get("url", ""),
        "alerted_at": row["generated_at"],
        "severity": data.get("severity"),
        "tickers": data.get("tickers") or [],
        "why": data.get("why", ""),
        "source": data.get("source", ""),
        "kind": _kind(data),
        "event_id": data.get("event_id"),
        "level": data.get("level"),
    }


def create_breaking_news_router() -> APIRouter:
    router = APIRouter(prefix="/api/breaking-news", tags=["breaking-news"])

    @router.get("")
    async def get_latest_alert():
        """Return Hermes's latest breaking-news alert, or 404 if none yet."""
        global _cache

        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
                resp = await client.get(HERMES_BREAKING_URL)
            if resp.status_code == 404:
                raise HTTPException(
                    status_code=404, detail="No breaking news alerts yet"
                )
            if resp.status_code == 200:
                payload = resp.json()
                payload["data"]["headline"]  # validate before caching
                if not voiced(payload["data"]):
                    # Below the bar: the latest stays the newest passing row.
                    async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
                        payload = await _newest_voiced(client) or _cache
                    if payload is None:
                        raise HTTPException(
                            status_code=404, detail="No breaking news alerts yet"
                        )
                _cache = payload
                return _shape(payload, await _ensure_audio(payload), False)
        except (httpx.HTTPError, ValueError, KeyError, TypeError):
            pass

        if _cache is None:
            raise HTTPException(status_code=503, detail="Hermes alert feed unavailable")
        return _shape(_cache, await _ensure_audio(_cache), True)

    @router.get("/recent")
    async def get_recent_alerts(hours: int = Query(24), limit: int = Query(3)):
        """Alerts from the last `hours` (1-72), newest first, at most `limit` (1-10)."""
        hours = _clamp(hours, _HOURS_RANGE)
        limit = _clamp(limit, _LIMIT_RANGE)
        key = (hours, limit)

        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
                resp = await client.get(
                    f"{HERMES_BREAKING_URL}/recent",
                    params={"hours": hours, "limit": limit},
                )
            if resp.status_code == 404:
                # No alerts yet (or a bridge without the route): an empty list.
                return {"alerts": [], "stale": False}
            if resp.status_code == 200:
                alerts = [_shape_recent(r) for r in resp.json()["rows"]]
                _recent_cache[key] = alerts
                return {"alerts": alerts, "stale": False}
        except (httpx.HTTPError, ValueError, KeyError, TypeError):
            pass

        if key not in _recent_cache:
            raise HTTPException(status_code=503, detail="Hermes alert feed unavailable")
        return {"alerts": _recent_cache[key], "stale": True}

    @router.get("/audio")
    async def get_latest_alert_audio():
        """Stream the latest alert's audio file."""
        path = _audio["path"]
        if path is None or not path.exists():
            raise HTTPException(status_code=404, detail="Audio not available")
        suffix = path.suffix.lower()
        return FileResponse(
            str(path),
            media_type=_AUDIO_MEDIA_TYPES.get(suffix, "application/octet-stream"),
            filename=f"breaking{suffix}",
        )

    return router
