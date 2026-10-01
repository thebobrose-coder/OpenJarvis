"""Tests for /api/day-ahead and /api/weather: proxies for Hermes's wave-4
hub feeds (day_ahead, weather). Neutral fixtures only; the bridge is mocked."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest

pytest.importorskip("fastapi", reason="openjarvis[server] not installed")

import httpx

from openjarvis.server import hermes_panel


def _stamp(age_s: int = 120) -> str:
    return (datetime.now(timezone.utc) - timedelta(seconds=age_s)).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )


DAY_AHEAD = {
    "events": [
        {"id": "evt-1", "title": "Sample meeting", "time": "2026-10-01T09:00:00"}
    ],
    "tasks": [
        {"id": "task-1", "title": "Sample task", "due": "", "list": "Sample list"}
    ],
    "calendar_connected": True,
    "tasks_connected": True,
    "window_hours": 24,
    "as_of": "2026-10-01T08:00:00",
    "errors": {},
}
WEATHER = {
    "provider": "openweathermap",
    "location": {"name": "Example City"},
    "units": "imperial",
    "language": "en",
    "current": {"temp": 72.0, "wind_speed": 5.0, "description": "clear sky"},
    "forecast": [],
}


def _payload(feed: str, data: dict, age_s: int = 120) -> dict:
    return {
        "feed": feed,
        "generated_at": _stamp(age_s),
        "age_seconds": age_s,
        "source_role": "hub",
        "data": data,
    }


@pytest.fixture(autouse=True)
def _reset():
    from openjarvis.server import day_ahead_routes, weather_routes

    day_ahead_routes.panel.last = None
    weather_routes.panel.last = None
    yield


def _client(handler):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from openjarvis.server.day_ahead_routes import day_ahead_router
    from openjarvis.server.weather_routes import weather_router

    app = FastAPI()
    app.include_router(day_ahead_router)
    app.include_router(weather_router)
    real = httpx.AsyncClient
    seen: list[httpx.Request] = []

    def route(req):
        seen.append(req)
        return handler(req)

    def fake(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(route)
        return real(*args, **kwargs)

    return (
        TestClient(app),
        patch.object(hermes_panel.httpx, "AsyncClient", side_effect=fake),
        seen,
    )


def _bridge(req: httpx.Request):
    if req.url.path == "/panels/day_ahead":
        return httpx.Response(200, json=_payload("day_ahead", DAY_AHEAD))
    if req.url.path == "/panels/weather":
        return httpx.Response(200, json=_payload("weather", WEATHER))
    if req.url.path.endswith("/refresh") and req.method == "POST":
        feed = req.url.path.split("/")[2]
        return httpx.Response(
            202, json={"feed": feed, "queued": True, "already_queued": False}
        )
    return httpx.Response(404)


def _down(req):
    raise httpx.ConnectError("refused", request=req)


@pytest.mark.parametrize(
    ("route", "data"), [("/api/day-ahead", DAY_AHEAD), ("/api/weather", WEATHER)]
)
def test_feed_is_unwrapped_in_the_panel_shape_with_freshness(route, data):
    client, patcher, seen = _client(_bridge)
    with patcher:
        body = client.get(route).json()
    assert {k: body[k] for k in data} == data
    assert body["stale"] is False
    assert 100 <= body["age_seconds"] <= 200
    assert body["generated_at"]
    assert [r.url.port for r in seen] == [8643]


def test_weather_units_pass_through():
    client, patcher, _ = _client(_bridge)
    with patcher:
        assert client.get("/api/weather").json()["units"] == "imperial"


@pytest.mark.parametrize("route", ["/api/day-ahead", "/api/weather"])
def test_bridge_down_serves_the_last_copy_as_stale_then_503_without_one(route):
    client, patcher, _ = _client(_bridge)
    with patcher:
        assert client.get(route).status_code == 200
    client, patcher, _ = _client(_down)
    with patcher:
        body = client.get(route).json()
    assert body["stale"] is True
    from openjarvis.server import day_ahead_routes, weather_routes

    day_ahead_routes.panel.last = None
    weather_routes.panel.last = None
    with patcher:
        assert client.get(route).status_code == 503


def test_weather_404_passes_through_as_not_configured():
    client, patcher, _ = _client(lambda r: httpx.Response(404))
    with patcher:
        resp = client.get("/api/weather")
    assert resp.status_code == 404
    assert "not configured" in resp.json()["detail"]


@pytest.mark.parametrize(
    ("route", "feed"),
    [("/api/day-ahead/refresh", "day_ahead"), ("/api/weather/refresh", "weather")],
)
def test_refresh_forwards_to_the_bridge(route, feed):
    client, patcher, seen = _client(_bridge)
    with patcher:
        resp = client.post(route)
    assert resp.status_code == 202
    assert resp.json() == {"feed": feed, "queued": True, "already_queued": False}
    assert seen[-1].method == "POST" and seen[-1].url.path == f"/panels/{feed}/refresh"


def test_refresh_503_when_the_bridge_is_down():
    client, patcher, _ = _client(_down)
    with patcher:
        assert client.post("/api/day-ahead/refresh").status_code == 503


def test_env_override_for_the_feed_url(monkeypatch):
    monkeypatch.setenv("HERMES_DAY_AHEAD_URL", "http://127.0.0.1:9999/panels/day_ahead")
    client, patcher, seen = _client(
        lambda r: httpx.Response(200, json=_payload("day_ahead", DAY_AHEAD))
    )
    with patcher:
        assert client.get("/api/day-ahead").status_code == 200
    assert seen[0].url.port == 9999


def test_no_live_calendar_or_weather_calls_remain():
    import inspect

    from openjarvis.server import day_ahead_routes, weather_routes

    for mod in (day_ahead_routes, weather_routes):
        src = inspect.getsource(mod)
        assert "ConnectorRegistry" not in src and "WeatherTool" not in src


def test_weather_digest_route_is_unregistered():
    import inspect

    import openjarvis.server.app as app_mod

    assert "/api/digest/weather" not in inspect.getsource(app_mod)
