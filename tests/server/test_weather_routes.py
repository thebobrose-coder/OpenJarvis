"""Tests for /api/weather."""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest

pytest.importorskip("fastapi", reason="openjarvis[server] not installed")

from openjarvis.core.types import ToolResult


def _make_app():
    from fastapi import FastAPI

    from openjarvis.server.weather_routes import weather_router

    app = FastAPI()
    app.include_router(weather_router)
    return app


def test_weather_not_connected_returns_404():
    from fastapi.testclient import TestClient

    app = _make_app()
    client = TestClient(app)

    mock_connector = MagicMock()
    mock_connector.is_connected.return_value = False

    with patch(
        "openjarvis.connectors.weather.WeatherConnector",
        return_value=mock_connector,
    ):
        resp = client.get("/api/weather")

    assert resp.status_code == 404
    assert "not configured" in resp.json()["detail"]


def test_weather_no_stored_location_returns_404():
    from fastapi.testclient import TestClient

    app = _make_app()
    client = TestClient(app)

    mock_connector = MagicMock()
    mock_connector.is_connected.return_value = True
    mock_connector.stored_location.return_value = None

    with patch(
        "openjarvis.connectors.weather.WeatherConnector",
        return_value=mock_connector,
    ):
        resp = client.get("/api/weather")

    assert resp.status_code == 404
    assert "location" in resp.json()["detail"]


def test_weather_returns_structured_payload():
    from fastapi.testclient import TestClient

    app = _make_app()
    client = TestClient(app)

    mock_connector = MagicMock()
    mock_connector.is_connected.return_value = True
    mock_connector.stored_location.return_value = "San Francisco,CA"

    payload = {
        "provider": "openweathermap",
        "location": {"requested": "San Francisco,CA", "name": "San Francisco"},
        "current": {"temperature": 18.0, "icon": "01d"},
        "forecast": [],
    }
    mock_tool = MagicMock()
    mock_tool.execute.return_value = ToolResult(
        tool_name="get_weather",
        content=json.dumps(payload),
        success=True,
    )

    with (
        patch(
            "openjarvis.connectors.weather.WeatherConnector",
            return_value=mock_connector,
        ),
        patch("openjarvis.tools.weather.WeatherTool", return_value=mock_tool),
    ):
        resp = client.get("/api/weather")

    assert resp.status_code == 200
    data = resp.json()
    assert data["location"]["name"] == "San Francisco"
    assert data["current"]["icon"] == "01d"
    mock_tool.execute.assert_called_once_with(
        location="San Francisco,CA", include_forecast=True, forecast_hours=24
    )


def test_weather_tool_failure_returns_502():
    from fastapi.testclient import TestClient

    app = _make_app()
    client = TestClient(app)

    mock_connector = MagicMock()
    mock_connector.is_connected.return_value = True
    mock_connector.stored_location.return_value = "San Francisco,CA"

    mock_tool = MagicMock()
    mock_tool.execute.return_value = ToolResult(
        tool_name="get_weather",
        content="Weather lookup failed unexpectedly.",
        success=False,
    )

    with (
        patch(
            "openjarvis.connectors.weather.WeatherConnector",
            return_value=mock_connector,
        ),
        patch("openjarvis.tools.weather.WeatherTool", return_value=mock_tool),
    ):
        resp = client.get("/api/weather")

    assert resp.status_code == 502
