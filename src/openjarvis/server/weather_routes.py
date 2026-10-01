"""FastAPI routes for the Weather panel -- a proxy for Hermes's `weather` feed.

Wave 4 (hq decision 0004, contract §2 "Wave 4 feeds"): Hermes regenerates
`weather` every 15 minutes. This route passes it through in the panel's
original shape (including `units`, which the panel labels by) plus
`generated_at` / `age_seconds` / `stale`; a bridge 404 means "not
configured" and stays a 404. `POST /refresh` asks Hermes for a fresh one.
The spoken weather narration is retired: it is one sentence of the general
digest now.
"""

from __future__ import annotations

from fastapi import APIRouter

from openjarvis.server.hermes_panel import HermesPanel

weather_router = APIRouter(prefix="/api/weather", tags=["weather"])

panel = HermesPanel("weather", "HERMES_WEATHER_URL")


@weather_router.get("")
async def get_weather() -> dict:
    """Current conditions and forecast from Hermes."""
    return await panel.get(not_found="Weather is not configured")


@weather_router.post("/refresh")
async def refresh_weather():
    """Queue a Hermes refresh (202); the feed regenerates within about 2 minutes."""
    return await panel.refresh()
