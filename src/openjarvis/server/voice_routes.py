"""FastAPI routes for the assistant's voice (contract v1.1, hq decision 0009).

Hermes writes `speech` blocks and the `voice_queue` feed; the separate voice
worker (openjarvis.voice_worker, its own venv, 127.0.0.1:8650) renders them
into a local cache keyed by block id. These routes read that cache, proxy
the worker's fast lane, and never touch the GPU themselves.

The desktop app can't play http:// or blob: audio (WebView2's media URL
safety check), so responses carry the cached file's absolute path for
Tauri's asset protocol, plus a URL for the browser build.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, Response

from openjarvis.voice_worker import paths as voice_paths
from openjarvis.voice_worker.core import SPEAK_TEXT_MAX

logger = logging.getLogger(__name__)

voice_router = APIRouter(prefix="/api/voice", tags=["voice"])

HERMES_BRIDGE_URL = os.environ.get("HERMES_BRIDGE_URL", "http://127.0.0.1:8643").rstrip(
    "/"
)
_TIMEOUT_S = 10.0
_RENDER_TIMEOUT_S = 300.0  # a fast-lane digest takes about a minute on the CPU

# Feeds that carry `speech` blocks (contract v1.1), plus the queue itself.
SPEECH_FEEDS = frozenset(
    {
        "voice_queue",
        "digest_general",
        "digest_culture",
        "ecom_briefing",
        "compliance_findings",
        "bd_prospects",
        "bd_pipeline",
        "content_proposals",
        "trading_status",
    }
)
_ITEM_FIELDS = (
    "id",
    "title",
    "mood",
    "priority",
    "lane",
    "created_at",
    "source_feed",
    "order",
)


def valid_id(block_id: str) -> bool:
    return bool(voice_paths.BLOCK_ID.match(block_id or ""))


def audio_info(block_id: str) -> dict[str, Any]:
    """Audio status for a block: missing, fast or expressive, and where."""
    hit = voice_paths.cached_audio(block_id)
    if hit is None:
        return {
            "audio": "missing",
            "audio_path": None,
            "audio_url": None,
            "audio_version": None,
        }
    wav, entry = hit
    return {
        "audio": entry.get("lane") or "fast",
        "audio_path": str(wav),
        "audio_url": f"/api/voice/audio/{block_id}",
        "audio_version": entry.get("rendered_at"),
        "duration": entry.get("duration"),
    }


async def _bridge_data(feed: str) -> dict[str, Any] | None:
    async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
        resp = await client.get(f"{HERMES_BRIDGE_URL}/panels/{feed}")
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    payload = resp.json()
    data = payload.get("data")
    if not isinstance(data, dict):
        raise ValueError("feed has no data")
    return {**data, "_generated_at": payload.get("generated_at")}


def _blocks(data: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not data:
        return []
    items = data.get("items") if "items" in data else data.get("speech")
    return [
        b
        for b in (items or [])
        if isinstance(b, dict) and valid_id(str(b.get("id", "")))
    ]


async def worker_block_fast(block: dict[str, Any]) -> Path | None:
    """Ask the worker to render one block on the fast lane into its cache.
    None when the worker is down or the render fails."""
    body = {
        k: block.get(k)
        for k in ("id", "text", "title", "source_feed", "mood", "priority")
    }
    try:
        async with httpx.AsyncClient(timeout=_RENDER_TIMEOUT_S) as client:
            resp = await client.post(f"{voice_paths.WORKER_URL}/blocks/fast", json=body)
        resp.raise_for_status()
    except httpx.HTTPError:
        logger.warning(
            "Voice worker fast render failed for %s", block.get("id"), exc_info=True
        )
        return None
    hit = voice_paths.cached_audio(str(block.get("id", "")))
    return hit[0] if hit else None


async def worker_ok() -> bool:
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            return (
                await client.get(f"{voice_paths.WORKER_URL}/health")
            ).status_code == 200
    except httpx.HTTPError:
        return False


@voice_router.get("/queue")
async def get_queue():
    """The current voice_queue items (without their text) plus audio status."""
    try:
        data = await _bridge_data("voice_queue")
    except (httpx.HTTPError, ValueError):
        raise HTTPException(
            status_code=503, detail="Hermes voice queue unavailable"
        ) from None
    items = sorted(_blocks(data), key=lambda b: b.get("order", 0))
    return {
        "run_at": (data or {}).get("run_at"),
        "generated_at": (data or {}).get("_generated_at"),
        "worker": await worker_ok(),
        "voice_name": voice_paths.voice_name(),
        "items": [
            {**{k: b.get(k) for k in _ITEM_FIELDS}, **audio_info(b["id"])}
            for b in items
        ],
    }


@voice_router.get("/audio/{block_id}")
async def get_audio(block_id: str):
    if not valid_id(block_id):
        raise HTTPException(
            status_code=400, detail="id must be 16 lowercase hex characters"
        )
    hit = voice_paths.cached_audio(block_id)
    if hit is None:
        raise HTTPException(status_code=404, detail="No audio for this block yet")
    return FileResponse(str(hit[0]), media_type="audio/wav", filename=f"{block_id}.wav")


@voice_router.post("/prepare")
async def prepare(request: Request):
    """Make sure a feed's block has audio: cached (either lane) or rendered on
    the fast lane now. Body: {feed, id}. The text is looked up on the bridge,
    so the page never sends it."""
    try:
        body = await request.json()
    except ValueError:
        raise HTTPException(status_code=400, detail="JSON body required") from None
    feed, block_id = str(body.get("feed", "")), str(body.get("id", ""))
    if feed not in SPEECH_FEEDS or not valid_id(block_id):
        raise HTTPException(status_code=400, detail="unknown feed or bad id")
    info = audio_info(block_id)
    if info["audio"] != "missing":
        return {"id": block_id, **info}
    try:
        block = next(
            (b for b in _blocks(await _bridge_data(feed)) if b["id"] == block_id), None
        )
    except (httpx.HTTPError, ValueError):
        raise HTTPException(status_code=503, detail="Hermes feed unavailable") from None
    if block is None or not block.get("text"):
        raise HTTPException(status_code=404, detail="That block is no longer current")
    if (
        await worker_block_fast(
            {**block, "source_feed": block.get("source_feed") or feed}
        )
        is None
    ):
        raise HTTPException(status_code=503, detail="Voice worker unavailable")
    return {"id": block_id, **audio_info(block_id)}


@voice_router.post("/speak")
async def speak(request: Request):
    """Ad-hoc fast-lane read-out for panels without a block. Not cached."""
    try:
        body = await request.json()
    except ValueError:
        raise HTTPException(status_code=400, detail="JSON body required") from None
    text = body.get("text") if isinstance(body, dict) else None
    if not isinstance(text, str) or not text.strip() or len(text) > SPEAK_TEXT_MAX:
        raise HTTPException(
            status_code=400, detail=f"text must be 1-{SPEAK_TEXT_MAX} characters"
        )
    try:
        async with httpx.AsyncClient(timeout=_RENDER_TIMEOUT_S) as client:
            resp = await client.post(
                f"{voice_paths.WORKER_URL}/speak", json={"text": text}
            )
        resp.raise_for_status()
    except httpx.HTTPError:
        raise HTTPException(
            status_code=503, detail="Voice worker unavailable"
        ) from None
    return Response(content=resp.content, media_type="audio/wav")


# ---------- voice input (hq 0010 phase 1): proxies for the worker ----------

_VOICE_ACTIONS = frozenset({"start", "stop", "mute", "unmute"})


@voice_router.get("/state")
async def voice_state():
    """The voice conversation's state and this conversation's turns."""
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
            resp = await client.get(f"{voice_paths.WORKER_URL}/voice/state")
    except httpx.HTTPError:
        raise HTTPException(
            status_code=503, detail="Voice worker unavailable"
        ) from None
    if resp.status_code != 200:
        raise HTTPException(status_code=503, detail="Voice input not ready")
    return resp.json()


@voice_router.get("/events")
async def voice_events():
    """Server-sent events of state changes and turns, passed through live."""
    from fastapi.responses import StreamingResponse

    client = httpx.AsyncClient(timeout=httpx.Timeout(10.0, read=None))
    try:
        req = client.build_request("GET", f"{voice_paths.WORKER_URL}/voice/events")
        resp = await client.send(req, stream=True)
    except httpx.HTTPError:
        await client.aclose()
        raise HTTPException(
            status_code=503, detail="Voice worker unavailable"
        ) from None
    if resp.status_code != 200:
        await resp.aclose()
        await client.aclose()
        raise HTTPException(status_code=503, detail="Voice input not ready")

    async def relay():
        try:
            async for chunk in resp.aiter_raw():
                yield chunk
        finally:
            await resp.aclose()
            await client.aclose()

    return StreamingResponse(
        relay(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"}
    )


@voice_router.post("/{action}")
async def voice_action(action: str):
    """Start or stop a conversation, mute or unmute the mic."""
    if action not in _VOICE_ACTIONS:
        raise HTTPException(status_code=404, detail="Unknown voice action")
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
            resp = await client.post(f"{voice_paths.WORKER_URL}/voice/{action}")
    except httpx.HTTPError:
        raise HTTPException(
            status_code=503, detail="Voice worker unavailable"
        ) from None
    if resp.status_code != 200:
        raise HTTPException(status_code=503, detail="Voice input not ready")
    return resp.json()
