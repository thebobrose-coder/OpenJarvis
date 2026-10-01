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
from datetime import datetime, timedelta, timezone
from datetime import time as dtime
from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from openjarvis.agents.digest_store import DigestStore
from openjarvis.agents.hermes_digest import (
    HERMES_DIGEST_URLS,
    HERMES_SCHEDULE,
    HERMES_TZ,
    feed_time,
    is_today,
)

logger = logging.getLogger(__name__)

HERMES_DIGEST_FEEDS = {"general": "digest_general", "culture": "digest_culture"}


_AUDIO_MEDIA_TYPES = {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
}


# ---------------------------------------------------------------------------
# Hermes-owned categories
# ---------------------------------------------------------------------------

_TIMEOUT_S = 10.0
# Hermes's digest-requests job runs every 2 minutes, then generation takes
# seconds; 5 minutes covers a full job interval plus a slow model.
_POLL_INTERVAL_S = 10.0
_POLL_TIMEOUT_S = 300.0
# Central times to pre-synthesize the day's audio: after the 06:00/06:05
# Hermes runs, with retries in case a run finishes late.
_WARMUP_TIMES = (dtime(6, 10), dtime(6, 30), dtime(7, 0))

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


def _speech_block(payload: dict) -> dict | None:
    """The digest's spoken script (contract v1.1 `speech[0]`), if Hermes sent one."""
    from openjarvis.server.voice_routes import valid_id

    speech = payload.get("data", {}).get("speech") or []
    block = speech[0] if speech and isinstance(speech[0], dict) else None
    if block and valid_id(str(block.get("id", ""))) and block.get("text"):
        return block
    return None


async def _ensure_audio(category: str, payload: dict) -> Path | None:
    """The digest's audio. With a `speech` block, it's the voice worker's
    cached render (the expressive voice, or the fast lane until the expressive render
    lands), rendered on the fast lane on demand if missing. Without one (or
    with the worker down), the digest text is spoken once per document on
    the local fast lane, as before."""
    from openjarvis.voice_worker import paths as voice_paths

    generated_at = payload["generated_at"]
    block = _speech_block(payload)
    if block is not None:
        hit = voice_paths.cached_audio(block["id"])
        if hit is not None:
            return hit[0]
        block_key = (category, f"block:{block['id']}")
        if block_key not in _tts_attempted:
            _tts_attempted.add(block_key)
            from openjarvis.server.voice_routes import worker_block_fast

            feed = HERMES_DIGEST_FEEDS[category]
            path = await worker_block_fast({**block, "source_feed": feed})
            if path is not None:
                return path
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


async def warm_digest_audio() -> None:
    """Synthesize audio for today's Hermes digests that have none yet.

    Takes the Kokoro wait off the first panel load of the day. A no-op for
    documents whose audio is already cached (or already attempted).
    """
    for category in HERMES_DIGEST_URLS:
        try:
            payload, stale = await _load_today(category)
        except HTTPException:
            continue
        if not stale:
            await _ensure_audio(category, payload)


def _seconds_until_next_warmup(now: datetime) -> float:
    """Seconds from `now` (aware, Central) to the next _WARMUP_TIMES slot."""
    for day in (0, 1):
        date = now.date() + timedelta(days=day)
        for slot in _WARMUP_TIMES:
            at = datetime.combine(date, slot, tzinfo=HERMES_TZ)
            if at > now:
                return (at - now).total_seconds()
    raise AssertionError("unreachable: tomorrow always has a slot")


async def digest_audio_warmup_loop() -> None:
    """Warm up once at startup, then at each _WARMUP_TIMES slot, forever."""
    while True:
        try:
            await warm_digest_audio()
        except Exception:  # noqa: BLE001 -- the loop must outlive any one failure
            logger.warning("Digest audio warm-up failed", exc_info=True)
        await asyncio.sleep(_seconds_until_next_warmup(datetime.now(HERMES_TZ)))


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
        "voice_used": _voice_used(payload, audio_path) or load_config().digest.voice_id,
        "audio_available": audio_path is not None,
        "audio_path": str(audio_path) if audio_path is not None else None,
        # Changes when the worker upgrades fast audio to the expressive render
        # (same file path), so a long-lived <audio> element reloads.
        "audio_version": _audio_version(audio_path),
        "stale": stale,
        "age_seconds": max(0, int(age)),
    }


def _voice_used(payload: dict, audio_path: Path | None) -> str | None:
    """"expressive" or "bm_george" when the audio is the voice worker's render."""
    from openjarvis.voice_worker import paths as voice_paths

    block = _speech_block(payload)
    hit = voice_paths.cached_audio(block["id"]) if block else None
    if hit is None or audio_path is None or hit[0] != audio_path:
        return None
    return "expressive" if hit[1].get("lane") == "expressive" else "bm_george"


def _audio_version(audio_path: Path | None) -> str | None:
    if audio_path is None:
        return None
    try:
        return str(int(audio_path.stat().st_mtime))
    except OSError:
        return None


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
    """Create a digest API router for a Hermes-generated category.

    "general" (the world/market digest) and "culture" proxy Hermes's feeds.
    The local digest pipeline is retired (wave 4 removed its last category,
    weather), so any other category is an error. The store only serves the
    legacy local rows on `/history`.
    """
    if category not in HERMES_DIGEST_URLS:
        raise ValueError(f"No Hermes digest feed for category {category!r}")
    store = DigestStore(db_path=db_path) if db_path else DigestStore()
    return _create_hermes_digest_router(category, prefix, store)
