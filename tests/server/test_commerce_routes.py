"""Tests for /api/commerce (Hermes ecom-seo feed proxy and its two writes)."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest

pytest.importorskip("fastapi", reason="openjarvis[server] not installed")

import httpx

from openjarvis.server import commerce_routes as cr

_ID = "0123456789ab"


def _payload(feed: str = "ecom_daily", age_s: int = 120) -> dict:
    stamp = datetime.now(timezone.utc) - timedelta(seconds=age_s)
    return {
        "feed": feed,
        "generated_at": stamp.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "age_seconds": age_s,
        "source_role": "ecom-seo",
        "data": {"run_at": "2026-09-28T06:45:00", "stores": [{"slug": "store-a"}]},
    }


@pytest.fixture(autouse=True)
def _reset():
    cr._cache.clear()
    yield
    cr._cache.clear()


def _client(handler):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(cr.commerce_router)
    real_client = httpx.AsyncClient
    seen: list[httpx.Request] = []

    def recording(req):
        seen.append(req)
        return handler(req)

    def fake_client(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(recording)
        return real_client(*args, **kwargs)

    patcher = patch.object(cr.httpx, "AsyncClient", side_effect=fake_client)
    return TestClient(app), patcher, seen


def _down(req):
    raise httpx.ConnectError("refused", request=req)


# -- GET feeds ---------------------------------------------------------------


@pytest.mark.parametrize("feed", sorted(cr.FEEDS))
def test_allowed_feed_is_unwrapped_with_freshness(feed):
    client, patcher, seen = _client(lambda r: httpx.Response(200, json=_payload(feed)))
    with patcher:
        resp = client.get(f"/api/commerce/{feed}")

    assert resp.status_code == 200
    body = resp.json()
    assert body["stores"] == [{"slug": "store-a"}]
    assert body["age_seconds"] == 120
    assert body["stale"] is False
    assert "generated_at" in body
    assert seen[0].url.path == f"/panels/{feed}"


@pytest.mark.parametrize("feed", ["store_performance", "digest_general", "secrets"])
def test_other_feeds_are_never_forwarded(feed):
    client, patcher, seen = _client(lambda r: httpx.Response(200, json=_payload()))
    with patcher:
        resp = client.get(f"/api/commerce/{feed}")

    assert resp.status_code == 404
    assert seen == []


def test_feed_without_a_first_run_is_no_data_yet():
    client, patcher, _ = _client(lambda r: httpx.Response(404))
    with patcher:
        resp = client.get("/api/commerce/ecom_briefing")

    assert resp.status_code == 404
    assert resp.json()["detail"] == "No data yet"


def test_bridge_down_without_cache_is_503():
    client, patcher, _ = _client(_down)
    with patcher:
        resp = client.get("/api/commerce/ecom_daily")

    assert resp.status_code == 503


def test_bridge_down_serves_last_known_with_age():
    up = {"ok": True}

    def handler(req):
        if not up["ok"]:
            return _down(req)
        return httpx.Response(200, json=_payload(age_s=3 * 3600))

    client, patcher, _ = _client(handler)
    with patcher:
        assert client.get("/api/commerce/ecom_daily").json()["stale"] is False
        up["ok"] = False
        body = client.get("/api/commerce/ecom_daily").json()

    assert body["stale"] is True
    assert 3 * 3600 - 60 <= body["age_seconds"] <= 3 * 3600 + 60
    assert body["stores"] == [{"slug": "store-a"}]


def test_caches_are_per_feed():
    def handler(req):
        if req.url.path.endswith("ecom_daily"):
            return httpx.Response(200, json=_payload("ecom_daily"))
        return _down(req)

    client, patcher, _ = _client(handler)
    with patcher:
        client.get("/api/commerce/ecom_daily")
        resp = client.get("/api/commerce/ecom_products")

    assert resp.status_code == 503


# -- POST refresh ------------------------------------------------------------


@pytest.mark.parametrize("feed", sorted(cr.REFRESHABLE))
def test_refresh_passes_allowed_flags_through(feed):
    client, patcher, seen = _client(
        lambda r: httpx.Response(202, json={"feed": feed, "queued": True})
    )
    with patcher:
        resp = client.post(f"/api/commerce/{feed}/refresh")

    assert resp.status_code == 202
    assert resp.json()["queued"] is True
    assert seen[0].method == "POST"
    assert seen[0].url.path == f"/panels/{feed}/refresh"


@pytest.mark.parametrize(
    "feed", ["ecom_products", "ecom_recommendations", "compliance_findings", "x"]
)
def test_refresh_rejects_other_feeds(feed):
    client, patcher, seen = _client(lambda r: httpx.Response(202, json={}))
    with patcher:
        resp = client.post(f"/api/commerce/{feed}/refresh")

    assert resp.status_code == 400
    assert seen == []


def test_refresh_with_bridge_down_is_503():
    client, patcher, _ = _client(_down)
    with patcher:
        resp = client.post("/api/commerce/ecom_daily/refresh")

    assert resp.status_code == 503


# -- POST decisions ----------------------------------------------------------


@pytest.mark.parametrize("decision", sorted(cr.DECISIONS))
def test_decision_is_forwarded_with_note(decision):
    client, patcher, seen = _client(
        lambda r: httpx.Response(
            202, json={"id": _ID, "decision": decision, "queued": True}
        )
    )
    with patcher:
        resp = client.post(
            f"/api/commerce/recommendations/{_ID}/{decision}",
            json={"note": "  Looks right.  "},
        )

    assert resp.status_code == 202
    assert seen[0].url.path == f"/ecom/recommendations/{_ID}/{decision}"
    assert json.loads(seen[0].content) == {"note": "Looks right."}


def test_decision_without_a_note_sends_no_body():
    client, patcher, seen = _client(lambda r: httpx.Response(202, json={}))
    with patcher:
        resp = client.post(f"/api/commerce/recommendations/{_ID}/accepted")

    assert resp.status_code == 202
    assert seen[0].content == b""


@pytest.mark.parametrize(
    "rec_id",
    ["0123456789AB", "0123456789a", "0123456789abc", "zzzzzzzzzzzz", "..%2f..%2fx"],
)
def test_decision_rejects_bad_ids(rec_id):
    client, patcher, seen = _client(lambda r: httpx.Response(202, json={}))
    with patcher:
        resp = client.post(f"/api/commerce/recommendations/{rec_id}/accepted")

    assert resp.status_code in (400, 404)
    assert seen == []


@pytest.mark.parametrize("decision", ["open", "expired", "approve", "ACCEPTED"])
def test_decision_rejects_other_decisions(decision):
    client, patcher, seen = _client(lambda r: httpx.Response(202, json={}))
    with patcher:
        resp = client.post(f"/api/commerce/recommendations/{_ID}/{decision}")

    assert resp.status_code == 400
    assert seen == []


def test_decision_note_over_500_chars_is_rejected():
    client, patcher, seen = _client(lambda r: httpx.Response(202, json={}))
    with patcher:
        resp = client.post(
            f"/api/commerce/recommendations/{_ID}/rejected", json={"note": "x" * 501}
        )

    assert resp.status_code == 422
    assert seen == []


def test_bridge_refusal_is_passed_through():
    client, patcher, _ = _client(
        lambda r: httpx.Response(409, json={"detail": "already final"})
    )
    with patcher:
        resp = client.post(f"/api/commerce/recommendations/{_ID}/done")

    assert resp.status_code == 409
    assert resp.json()["detail"] == "already final"
