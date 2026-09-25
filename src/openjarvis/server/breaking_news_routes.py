"""FastAPI routes for the latest breaking-news alert -- a read-through proxy
for the Hermes alert feed.

Hermes (the news-monitor role) now owns detection and triage and publishes
the latest alert at `/panels/breaking_alerts` on the local bridge (contract
hq/contracts/openjarvis-hermes.md v0.3 §2). This route passes it through in
the shape the sidebar already reads, and OpenJarvis keeps speaking alerts
with its own TTS: each new alert (new `generated_at`) is synthesized once,
with the same voice settings `tools/breaking_alert_record.py` uses.

Alerts are sparse by design -- the bridge 404s until the first one fires,
which maps to the same "no alerts yet" 404 as before. The last good alert is
kept in memory, so a Hermes restart degrades to a stale-flagged copy rather
than an empty sidebar item.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

logger = logging.getLogger(__name__)

HERMES_BREAKING_URL = os.environ.get(
    "HERMES_BREAKING_URL", "http://127.0.0.1:8643/panels/breaking_alerts"
)
_TIMEOUT_S = 10.0

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
    """Synthesize audio once per new alert; later calls reuse it."""
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
                _cache = payload
                return _shape(payload, await _ensure_audio(payload), False)
        except (httpx.HTTPError, ValueError, KeyError, TypeError):
            pass

        if _cache is None:
            raise HTTPException(
                status_code=503, detail="Hermes alert feed unavailable"
            )
        return _shape(_cache, await _ensure_audio(_cache), True)

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
