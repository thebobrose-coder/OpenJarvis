"""FastAPI routes for the morning digest."""

from __future__ import annotations

import asyncio
from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from openjarvis.agents.digest_store import DigestStore
from openjarvis.cli.digest_cmd import (
    _cancel_scheduler_tasks,
    _create_scheduler_task,
    _save_digest_schedule,
)
from openjarvis.core.config import load_config


class ScheduleUpdate(BaseModel):
    """Request body for updating the digest schedule."""

    enabled: bool
    cron: Optional[str] = None


_AUDIO_MEDIA_TYPES = {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
}


_GENERATE_PROMPTS = {
    "general": "Generate my morning digest",
    "weather": "Generate the weather briefing",
}


def _generate_digest_sync(category: str) -> str:
    """Generate a digest with the whole Jarvis lifecycle on one worker."""
    from openjarvis.sdk import Jarvis

    prompt = _GENERATE_PROMPTS.get(category, _GENERATE_PROMPTS["general"])
    with Jarvis() as jarvis:
        return jarvis.ask(prompt, agent="morning_digest", digest_category=category)


def create_digest_router(
    *, db_path: str = "", category: str = "general", prefix: str = "/api/digest"
) -> APIRouter:
    """Create a digest API router with the given store path.

    `category` scopes every query to that category's rows in the shared
    DigestStore table (see digest_store.py) -- "general" is the original
    world/market digest; other values (e.g. "weather") are independent
    pipelines on their own schedule. Schedule management (/schedule) only
    makes sense for the user-configurable general digest, so it's omitted
    for any other category.
    """
    router = APIRouter(prefix=prefix, tags=["digest", category])
    store = DigestStore(db_path=db_path) if db_path else DigestStore()

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

    if category == "general":

        @router.get("/schedule")
        async def get_schedule():
            """Return the current digest schedule configuration."""
            cfg = load_config()
            return {
                "enabled": cfg.digest.enabled,
                "cron": cfg.digest.schedule,
            }

        @router.post("/schedule")
        async def update_schedule(body: ScheduleUpdate):
            """Update the digest schedule configuration."""
            cfg = load_config()
            cron = body.cron if body.cron is not None else cfg.digest.schedule

            try:
                _save_digest_schedule(enabled=body.enabled, cron=cron)
            except Exception as exc:
                raise HTTPException(
                    status_code=500,
                    detail=f"Failed to save config: {exc}",
                )

            # Sync with the TaskScheduler
            if body.enabled:
                _create_scheduler_task(cron, cfg.digest.timezone)
            else:
                _cancel_scheduler_tasks()

            return {
                "enabled": body.enabled,
                "cron": cron,
            }

    return router
