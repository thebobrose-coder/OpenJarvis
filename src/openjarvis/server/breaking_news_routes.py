"""FastAPI routes for the breaking_news_monitor operator's latest alert.

Separate from digest_routes.py's create_digest_router: digests are one
scheduled generation per category per day, while breaking alerts are
sparse and event-driven -- there is no "today's alert" concept, just
"whatever the latest one is, if any."
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from openjarvis.agents.breaking_alert_store import BreakingAlertStore

_AUDIO_MEDIA_TYPES = {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
}


def create_breaking_news_router(*, db_path: str = "") -> APIRouter:
    router = APIRouter(prefix="/api/breaking-news", tags=["breaking-news"])
    store = BreakingAlertStore(db_path=db_path) if db_path else BreakingAlertStore()

    @router.get("")
    async def get_latest_alert():
        """Return the latest breaking-news alert, or 404 if none has ever fired."""
        alert = store.get_latest()
        if alert is None:
            raise HTTPException(status_code=404, detail="No breaking news alerts yet")
        audio_available = alert.audio_path.exists() if alert.audio_path.name else False
        return {
            "headline": alert.headline,
            "summary": alert.summary,
            "url": alert.url,
            "alerted_at": alert.alerted_at.isoformat(),
            "audio_available": audio_available,
            "audio_path": str(alert.audio_path) if audio_available else None,
        }

    @router.get("/audio")
    async def get_latest_alert_audio():
        """Stream the latest alert's audio file."""
        alert = store.get_latest()
        if alert is None or not alert.audio_path.exists():
            raise HTTPException(status_code=404, detail="Audio not available")
        suffix = alert.audio_path.suffix.lower()
        media_type = _AUDIO_MEDIA_TYPES.get(suffix, "application/octet-stream")
        return FileResponse(
            str(alert.audio_path),
            media_type=media_type,
            filename=f"breaking{suffix}",
        )

    return router
