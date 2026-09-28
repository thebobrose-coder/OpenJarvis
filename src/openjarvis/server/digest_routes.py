"""FastAPI routes for the morning digest.

The general and culture digests are read-through proxies for Hermes's
`digest_general` / `digest_culture` panel feeds (contract
hq/contracts/openjarvis-hermes.md v0.4 §2): Hermes generates them, and
OpenJarvis keeps the response shape the panels already read and speaks each
new document once with its own TTS. Weather is still generated and stored
locally until wave 4.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from openjarvis.agents.digest_store import DigestStore
from openjarvis.agents.hermes_digest import (
    HERMES_DIGEST_URLS,
    HERMES_SCHEDULE,
    feed_time,
    is_today,
)

logger = logging.getLogger(__name__)


_AUDIO_MEDIA_TYPES = {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
}


_GENERATE_PROMPTS = {
    "weather": "Generate the weather briefing",
}


def _generate_digest_sync(category: str) -> str:
    """Generate a digest with the whole Jarvis lifecycle on one worker."""
    from openjarvis.sdk import Jarvis

    prompt = _GENERATE_PROMPTS[category]
    with Jarvis() as jarvis:
        return jarvis.ask(prompt, agent="morning_digest", digest_category=category)


# ---------------------------------------------------------------------------
# Hermes-owned categories
# ---------------------------------------------------------------------------

_TIMEOUT_S = 10.0
# Hermes's digest-requests job runs every 2 minutes, then generation takes
# seconds; 5 minutes covers a full job interval plus a slow model.
_POLL_INTERVAL_S = 10.0
_POLL_TIMEOUT_S = 300.0

# Last good bridge payload per category, served stale-flagged when the bridge
# is down. Audio lives on disk keyed by category + generated_at; the attempted
# set stops a failing TTS backend from being retried on every request.
_cache: dict[str, dict] = {}
_tts_attempted: set[tuple[str, str]] = set()
_audio_lock = asyncio.Lock()


def _audio_dir() -> Path:
    from openjarvis.core.paths import get_config_dir

    return get_config_dir() / "digests" / "hermes"


def _audio_stem(category: str, generated_at: str) -> str:
    return f"{category}-" + (re.sub(r"[^0-9A-Za-z]", "", generated_at) or "latest")


def _cached_audio(category: str, generated_at: str) -> Path | None:
    stem = _audio_stem(category, generated_at)
    for path in _audio_dir().glob(f"{stem}.*"):
        return path
    return None


def _speakable(text: str) -> str:
    """Strip markdown the TTS would read aloud (same rules as morning_digest)."""
    text = re.sub(r"^#{1,6}\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"^\s*[-*•]\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"\*{1,2}([^*]+)\*{1,2}", r"\1", text)
    return text.strip()


def _synthesize(category: str, text: str, generated_at: str) -> Path | None:
    """Speak one Hermes digest with the digest voice; return its audio file.

    TextToSpeechTool always writes `digest.<ext>`, so the file is renamed to
    a per-document name. Older files for the category are pruned.
    """
    from openjarvis.core.config import load_config
    from openjarvis.tools.text_to_speech import TextToSpeechTool

    dc = load_config().digest
    out_dir = _audio_dir()
    result = TextToSpeechTool().execute(
        text=text,
        voice_id=dc.voice_id,
        backend=dc.tts_backend,
        speed=dc.voice_speed,
        output_dir=str(out_dir),
    )
    raw = result.metadata.get("audio_path", "") if result.success else ""
    if not raw or not Path(raw).exists():
        logger.warning(
            "Digest TTS produced no audio (%s): %s", category, result.content
        )
        return None

    src = Path(raw)
    dest = src.with_name(f"{_audio_stem(category, generated_at)}{src.suffix}")
    src.replace(dest)
    for old in out_dir.glob(f"{category}-*"):
        if old != dest:
            old.unlink(missing_ok=True)
    return dest


async def _ensure_audio(category: str, payload: dict) -> Path | None:
    """Synthesize audio once per new Hermes document; later calls reuse it."""
    generated_at = payload["generated_at"]
    key = (category, generated_at)
    async with _audio_lock:
        path = _cached_audio(category, generated_at)
        if path is None and key not in _tts_attempted:
            _tts_attempted.add(key)
            try:
                path = await asyncio.to_thread(
                    _synthesize,
                    category,
                    _speakable(payload["data"]["text"]),
                    generated_at,
                )
            except Exception:  # noqa: BLE001 -- audio is optional; never fail the digest
                logger.warning("Digest TTS failed (%s)", category, exc_info=True)
                path = None
    return path


async def _fetch_feed(category: str) -> dict | None:
    """Latest feed document, None if Hermes has none yet (bridge 404).

    Raises httpx.HTTPError / ValueError / KeyError / TypeError when the bridge
    is unreachable or answers with something unusable.
    """
    async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
        resp = await client.get(HERMES_DIGEST_URLS[category])
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    payload = resp.json()
    payload["data"]["text"]  # validate before caching
    feed_time(payload)
    _cache[category] = payload
    return payload


async def _load_today(category: str) -> tuple[dict, bool]:
    """Today's Hermes document and whether it is a stale (bridge-down) copy."""
    try:
        payload = await _fetch_feed(category)
    except (httpx.HTTPError, ValueError, KeyError, TypeError):
        payload = _cache.get(category)
        if payload is None:
            raise HTTPException(
                status_code=503, detail="Hermes digest feed unavailable"
            )
        # Bridge down: last-known document, whatever its date, with its age.
        return payload, True
    if payload is None or not is_today(payload):
        raise HTTPException(status_code=404, detail="No digest for today")
    return payload, False


def _shape(category: str, payload: dict, audio_path: Path | None, stale: bool) -> dict:
    from openjarvis.core.config import load_config

    data = payload["data"]
    age = (datetime.now(timezone.utc) - feed_time(payload)).total_seconds()
    return {
        "text": data["text"],
        "sections": {},
        "articles": (data.get("articles") or []) if category == "culture" else [],
        "sources_used": data.get("sources_used") or [],
        "generated_at": data.get("generated_local") or payload["generated_at"],
        "model_used": data.get("model_used", ""),
        "voice_used": load_config().digest.voice_id,
        "audio_available": audio_path is not None,
        "audio_path": str(audio_path) if audio_path is not None else None,
        "stale": stale,
        "age_seconds": max(0, int(age)),
    }


def _create_hermes_digest_router(
    category: str, prefix: str, store: DigestStore
) -> APIRouter:
    router = APIRouter(prefix=prefix, tags=["digest", category])
    feed_url = HERMES_DIGEST_URLS[category]

    @router.get("")
    async def get_digest():
        """Return today's Hermes digest in the local digest shape."""
        payload, stale = await _load_today(category)
        return _shape(category, payload, await _ensure_audio(category, payload), stale)

    @router.get("/audio")
    async def get_digest_audio():
        """Stream the current Hermes digest's audio file."""
        payload, _stale = await _load_today(category)
        path = await _ensure_audio(category, payload)
        if path is None or not path.exists():
            raise HTTPException(status_code=404, detail="Audio not available")
        suffix = path.suffix.lower()
        return FileResponse(
            str(path),
            media_type=_AUDIO_MEDIA_TYPES.get(suffix, "application/octet-stream"),
            filename=f"digest{suffix}",
        )

    @router.post("/generate")
    async def generate_digest():
        """Ask Hermes to regenerate, then wait for the new document."""
        try:
            before = await _fetch_feed(category)
            async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
                resp = await client.post(f"{feed_url}/refresh")
            resp.raise_for_status()
        except (httpx.HTTPError, ValueError, KeyError, TypeError) as exc:
            raise HTTPException(
                status_code=503, detail=f"Hermes refresh unavailable: {exc}"
            )
        previous = before["generated_at"] if before else None

        deadline = time.monotonic() + _POLL_TIMEOUT_S
        while time.monotonic() < deadline:
            await asyncio.sleep(_POLL_INTERVAL_S)
            try:
                payload = await _fetch_feed(category)
            except (httpx.HTTPError, ValueError, KeyError, TypeError):
                continue  # a bridge blip mid-poll is not a failure yet
            if payload is not None and payload["generated_at"] != previous:
                await _ensure_audio(category, payload)
                return {"status": "ok", "text": payload["data"]["text"]}
        raise HTTPException(
            status_code=504,
            detail=(
                f"Hermes did not publish a new {category} digest within "
                f"{int(_POLL_TIMEOUT_S)} s; the refresh stays queued"
            ),
        )

    @router.get("/history")
    async def get_digest_history():
        """Past digests from the local store (no longer grows for this category)."""
        history = store.history(limit=10, category=category)
        return [
            {
                "text": a.text[:200],
                "generated_at": a.generated_at.isoformat(),
                "model_used": a.model_used,
                "voice_used": a.voice_used,
            }
            for a in history
        ]

    if category == "general":

        @router.get("/schedule")
        async def get_schedule():
            """Hermes's digest schedule (read-only)."""
            return {"enabled": True, **HERMES_SCHEDULE, "managed_by": "hermes"}

        @router.post("/schedule")
        async def update_schedule():
            raise HTTPException(status_code=409, detail="Schedule managed by Hermes")

    return router


def create_digest_router(
    *, db_path: str = "", category: str = "general", prefix: str = "/api/digest"
) -> APIRouter:
    """Create a digest API router with the given store path.

    `category` scopes every query to that category's rows in the shared
    DigestStore table (see digest_store.py). "general" (the world/market
    digest) and "culture" proxy Hermes's feeds; weather is a local pipeline
    until wave 4.
    """
    store = DigestStore(db_path=db_path) if db_path else DigestStore()
    if category in HERMES_DIGEST_URLS:
        return _create_hermes_digest_router(category, prefix, store)

    router = APIRouter(prefix=prefix, tags=["digest", category])

    @router.get("")
    async def get_digest():
        """Return the latest digest artifact."""
        artifact = store.get_today(category=category)
        if artifact is None:
            raise HTTPException(status_code=404, detail="No digest for today")
        audio_available = (
            artifact.audio_path.exists() if artifact.audio_path.name else False
        )
        return {
            "text": artifact.text,
            "sections": artifact.sections,
            "articles": [],
            "sources_used": artifact.sources_used,
            "generated_at": artifact.generated_at.isoformat(),
            "model_used": artifact.model_used,
            "voice_used": artifact.voice_used,
            "audio_available": audio_available,
            # Absolute filesystem path -- the desktop app loads this directly
            # via Tauri's asset protocol (convertFileSrc), which is exempt
            # from a WebView2 media-security check that blocks both plain
            # http:// and blob: audio sources in a packaged app. Only ever
            # meaningful to the Tauri build; the browser-facing copy ignores
            # it and streams from /api/digest/audio instead.
            "audio_path": str(artifact.audio_path) if audio_available else None,
        }

    @router.get("/audio")
    async def get_digest_audio():
        """Stream the digest audio file."""
        artifact = store.get_today(category=category)
        if artifact is None:
            raise HTTPException(status_code=404, detail="No digest for today")
        if not artifact.audio_path.exists():
            raise HTTPException(status_code=404, detail="Audio not available")
        suffix = artifact.audio_path.suffix.lower()
        media_type = _AUDIO_MEDIA_TYPES.get(suffix, "application/octet-stream")
        return FileResponse(
            str(artifact.audio_path),
            media_type=media_type,
            filename=f"digest{suffix}",
        )

    @router.post("/generate")
    async def generate_digest():
        """Force re-generation of the digest."""
        try:
            result = await asyncio.to_thread(_generate_digest_sync, category)
            return {"status": "ok", "text": result}
        except Exception as exc:
            raise HTTPException(status_code=500, detail=str(exc))

    @router.get("/history")
    async def get_digest_history():
        """Return past digests."""
        history = store.history(limit=10, category=category)
        return [
            {
                "text": a.text[:200],
                "generated_at": a.generated_at.isoformat(),
                "model_used": a.model_used,
                "voice_used": a.voice_used,
            }
            for a in history
        ]

    return router
