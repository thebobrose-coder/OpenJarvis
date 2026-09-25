"""Tests for /api/store-performance (Hermes panel feed proxy)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest

pytest.importorskip("fastapi", reason="openjarvis[server] not installed")

import httpx

from openjarvis.server import store_performance_routes as spr

_STORES = {
    "stores": [
        {
            "slug": "demo",
            "display_name": "Demo",
            "shopify": {"connected": True, "catalog_count": 3},
            "search_console": {"connected": False},
        }
    ]
}


def _bridge_payload(age_seconds: int) -> dict:
    generated = datetime.now(timezone.utc) - timedelta(seconds=age_seconds)
    return {
        "feed": "store_performance",
        "generated_at": generated.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "age_seconds": age_seconds,
        "source_role": "ecom-seo",
        "data": _STORES,
    }


@pytest.fixture(autouse=True)
def _reset_cache():
    spr._cache = None
    yield
    spr._cache = None


def _client(handler):
    """TestClient whose outbound httpx calls go to `handler`."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(spr.store_performance_router)

    real_client = httpx.AsyncClient

    def fake_client(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return real_client(*args, **kwargs)

    patcher = patch.object(spr.httpx, "AsyncClient", side_effect=fake_client)
    return TestClient(app), patcher


def test_fresh_response_passes_through():
    payload = _bridge_payload(812)
    client, patcher = _client(lambda req: httpx.Response(200, json=payload))
    with patcher:
        resp = client.get("/api/store-performance")

    assert resp.status_code == 200
    body = resp.json()
    assert body["stores"] == _STORES["stores"]
    assert body["generated_at"] == payload["generated_at"]
    assert body["age_seconds"] == 812
    assert body["stale"] is False


def test_stale_flag_past_7200_seconds():
    client, patcher = _client(
        lambda req: httpx.Response(200, json=_bridge_payload(7201))
    )
    with patcher:
        body = client.get("/api/store-performance").json()

    assert body["stale"] is True
    assert body["stores"] == _STORES["stores"]


def test_bridge_down_serves_cache_as_stale():
    payload = _bridge_payload(60)
    up, patcher = _client(lambda req: httpx.Response(200, json=payload))
    with patcher:
        assert up.get("/api/store-performance").json()["stale"] is False

    def down(req):
        raise httpx.ConnectError("refused", request=req)

    client, patcher = _client(down)
    with patcher:
        resp = client.get("/api/store-performance")

    assert resp.status_code == 200
    body = resp.json()
    assert body["stale"] is True
    assert body["stores"] == _STORES["stores"]
    assert body["age_seconds"] >= 60


def test_bridge_non_200_serves_cache_as_stale():
    spr._cache = _bridge_payload(60)
    client, patcher = _client(lambda req: httpx.Response(503))
    with patcher:
        body = client.get("/api/store-performance").json()

    assert body["stale"] is True


def test_bridge_down_without_cache_returns_503():
    def down(req):
        raise httpx.ConnectError("refused", request=req)

    client, patcher = _client(down)
    with patcher:
        resp = client.get("/api/store-performance")

    assert resp.status_code == 503
    assert resp.json() == {"detail": "Hermes panel feed unavailable"}


def test_route_imports_no_connectors():
    import inspect

    src = inspect.getsource(spr)
    for mod in (
        "connectors.shopify",
        "connectors.google_search_console",
        "connectors.shopify_stores",
        "agents.shopify_snapshot_store",
    ):
        assert mod not in src
