"""FastAPI route for the graphical Weather panel -- live, uncached conditions.

Reuses WeatherTool directly rather than duplicating its fetch/credential
logic, and resolves the same stored location the weather digest narration
uses (WeatherConnector.stored_location()) so the panel and the spoken
briefing never disagree about where "weather" means.
"""

from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException

weather_router = APIRouter(prefix="/api/weather", tags=["weather"])


@weather_router.get("")
async def get_weather() -> dict:
    """Return current conditions and forecast for the configured location."""
    from openjarvis.connectors.weather import WeatherConnector
    from openjarvis.tools.weather import WeatherTool

    connector = WeatherConnector()
    if not connector.is_connected():
        raise HTTPException(status_code=404, detail="Weather is not configured")

    location = connector.stored_location()
    if not location:
        raise HTTPException(status_code=404, detail="No weather location configured")

    tool = WeatherTool(connector=connector)
    result = tool.execute(location=location, include_forecast=True, forecast_hours=24)
    if not result.success:
        raise HTTPException(status_code=502, detail=result.content)

    return json.loads(result.content)
