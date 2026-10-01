"""FastAPI routes for the Day Ahead panel -- a proxy for Hermes's `day_ahead` feed.

Wave 4 (hq decision 0004, contract §2 "Wave 4 feeds"): Hermes owns the hub
reads. It regenerates `day_ahead` every 5 minutes (latest only, no calendar
history); this route passes it through in the panel's original shape plus
`generated_at` / `age_seconds` / `stale`, and `POST /refresh` asks Hermes for
a fresh one. No live calendar or task calls remain here.
"""

from __future__ import annotations

from fastapi import APIRouter

from openjarvis.server.hermes_panel import HermesPanel

day_ahead_router = APIRouter(prefix="/api/day-ahead", tags=["day-ahead"])

panel = HermesPanel("day_ahead", "HERMES_DAY_AHEAD_URL")


@day_ahead_router.get("")
async def get_day_ahead() -> dict:
    """The next-24h events and open tasks from Hermes."""
    return await panel.get(not_found="No Day Ahead data yet")


@day_ahead_router.post("/refresh")
async def refresh_day_ahead():
    """Queue a Hermes refresh (202); the feed regenerates within about 2 minutes."""
    return await panel.refresh()
