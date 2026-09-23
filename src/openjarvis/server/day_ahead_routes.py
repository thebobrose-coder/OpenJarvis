"""FastAPI route for the Day Ahead panel -- a live, uncached agenda view.

Unlike the digest/briefing endpoints, this never caches: a stale calendar
is actively wrong, not just stale, so every request fetches fresh from
gcalendar/google_tasks. No LLM call, no TTS -- a live data view, not a
narrated pipeline.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta
from typing import Any, Optional

from fastapi import APIRouter

day_ahead_router = APIRouter(prefix="/api/day-ahead", tags=["day-ahead"])


def _connected_connector(connector_id: str) -> Optional[Any]:
    """Return a connected connector instance, or None if unavailable."""
    import openjarvis.connectors  # noqa: F401 -- ensure registration
    from openjarvis.core.registry import ConnectorRegistry

    if not ConnectorRegistry.contains(connector_id):
        return None
    connector = ConnectorRegistry.get(connector_id)()
    return connector if connector.is_connected() else None


@day_ahead_router.get("")
async def get_day_ahead() -> dict:
    """Return the rolling next-24h calendar events and open tasks, live."""
    now = datetime.now()
    # gcalendar/google_tasks .sync() make synchronous httpx calls (real
    # timeouts, but still blocking). Run off the event loop thread --
    # inline, this froze the entire single-worker server for every other
    # request for the full duration of the fetch (observed: 35s of total
    # unresponsiveness, including /health, for one Day Ahead load).
    return await asyncio.to_thread(_fetch_day_ahead, now)


def _fetch_day_ahead(now: datetime) -> dict:
    window_end = now + timedelta(hours=24)

    events: list[dict] = []
    calendar_connected = False
    calendar = _connected_connector("gcalendar")
    if calendar is not None:
        calendar_connected = True
        try:
            for doc in calendar.sync(since=now):
                ts = doc.timestamp.replace(tzinfo=None) if doc.timestamp.tzinfo else doc.timestamp
                if ts > window_end:
                    continue
                events.append(
                    {
                        "id": doc.doc_id,
                        "title": doc.title or "(No title)",
                        "time": ts.isoformat(),
                    }
                )
        except Exception:  # noqa: BLE001 -- a flaky sync must not break the panel
            pass
    events.sort(key=lambda e: e["time"])

    tasks: list[dict] = []
    tasks_connected = False
    google_tasks = _connected_connector("google_tasks")
    if google_tasks is not None:
        tasks_connected = True
        try:
            for doc in google_tasks.sync():
                if doc.metadata.get("status", "needsAction") == "completed":
                    continue
                tasks.append(
                    {
                        "id": doc.doc_id,
                        "title": doc.title or "(No title)",
                        "due": doc.metadata.get("due", ""),
                    }
                )
        except Exception:  # noqa: BLE001
            pass

    return {
        "events": events,
        "tasks": tasks,
        "calendar_connected": calendar_connected,
        "tasks_connected": tasks_connected,
    }
