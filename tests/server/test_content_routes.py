"""Tests for /api/content (Hermes content-strategist feed proxy and its actions).

Neutral fixtures only (property `alpha`, pillar `grit`, product
`sample-mount`): this repo is public and real proposals name the operator's
properties, products and topics.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest

pytest.importorskip("fastapi", reason="openjarvis[server] not installed")

import httpx

from openjarvis.server import content_routes as cr

UUID = "0f8fad5b-d9cb-469f-a165-70867728950e"


def _payload(feed: str = "content_proposals", age_s: int = 60) -> dict:
    stamp = datetime.now(timezone.utc) - timedelta(seconds=age_s)
    return {
        "feed": feed,
        "generated_at": stamp.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "age_seconds": age_s,
        "source_role": "content-strategist",
        "data": {"run_at": "2026-09-29T05:30:00Z", "properties": [{"id": "alpha"}]},
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
    app.include_router(cr.content_router)
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


def _queued(req):
    return httpx.Response(202, json={"queued": True})


# -- GET feeds ---------------------------------------------------------------


@pytest.mark.parametrize("feed", sorted(cr.FEEDS))
def test_allowed_feed_is_unwrapped_with_freshness(feed):
    client, patcher, seen = _client(lambda r: httpx.Response(200, json=_payload(feed)))
    with patcher:
        body = client.get(f"/api/content/{feed}").json()

    assert body["properties"] == [{"id": "alpha"}]
    assert body["age_seconds"] == 60
    assert body["stale"] is False
    assert seen[0].url.path == f"/panels/{feed}"


@pytest.mark.parametrize("feed", ["content_ideation", "bd_pipeline", "digest_general"])
def test_other_feeds_are_never_forwarded(feed):
    client, patcher, seen = _client(lambda r: httpx.Response(200, json=_payload()))
    with patcher:
        resp = client.get(f"/api/content/{feed}")

    assert resp.status_code == 404
    assert seen == []


def test_feed_before_its_first_run_is_no_data_yet():
    client, patcher, _ = _client(lambda r: httpx.Response(404))
    with patcher:
        resp = client.get("/api/content/content_performance")

    assert resp.status_code == 404
    assert resp.json()["detail"] == "No data yet"


def test_bridge_down_without_cache_is_503():
    client, patcher, _ = _client(_down)
    with patcher:
        assert client.get("/api/content/content_seedbank").status_code == 503


def test_bridge_down_serves_last_known_per_feed():
    up = {"ok": True}

    def handler(req):
        feed = req.url.path.rsplit("/", 1)[-1]
        return (
            httpx.Response(200, json=_payload(feed, age_s=7200))
            if up["ok"]
            else _down(req)
        )

    client, patcher, _ = _client(handler)
    with patcher:
        client.get("/api/content/content_seedbank")
        up["ok"] = False
        body = client.get("/api/content/content_seedbank").json()
        other = client.get("/api/content/content_health")

    assert body["stale"] is True
    assert 7200 - 60 <= body["age_seconds"] <= 7200 + 60
    # The last-known copy is per feed: one feed's copy never stands in for another.
    assert other.status_code == 503


# -- proposal decisions ------------------------------------------------------


@pytest.mark.parametrize("action", sorted(cr.PROPOSAL_ACTIONS))
def test_decision_without_body_is_forwarded(action):
    client, patcher, seen = _client(_queued)
    with patcher:
        resp = client.post(f"/api/content/proposals/{UUID}/{action}")

    assert resp.status_code == 202
    assert seen[0].url.path == f"/content/proposals/{UUID}/{action}"
    assert seen[0].content == b""


def test_approve_forwards_the_trimmed_edits():
    client, patcher, seen = _client(_queued)
    with patcher:
        client.post(
            f"/api/content/proposals/{UUID}/approve",
            json={
                "topic": "  Sample topic about budget rigs  ",
                "pillar_hint": "grit",
                "product_handle": "sample-mount",
                "note": " ",
            },
        )

    assert json.loads(seen[0].content) == {
        "topic": "Sample topic about budget rigs",
        "pillar_hint": "grit",
        "product_handle": "sample-mount",
    }


def test_reject_forwards_only_a_note():
    client, patcher, seen = _client(_queued)
    with patcher:
        ok = client.post(
            f"/api/content/proposals/{UUID}/reject", json={"note": "Off brand."}
        )
        bad = client.post(
            f"/api/content/proposals/{UUID}/reject", json={"topic": "Sample topic"}
        )

    assert ok.status_code == 202
    assert json.loads(seen[0].content) == {"note": "Off brand."}
    assert bad.status_code == 400
    assert len(seen) == 1


@pytest.mark.parametrize(
    "field, limit",
    [("topic", 600), ("note", 500), ("pillar_hint", 120), ("product_handle", 120)],
)
def test_field_limits(field, limit):
    client, patcher, seen = _client(_queued)
    with patcher:
        at_limit = client.post(
            f"/api/content/proposals/{UUID}/approve", json={field: "x" * limit}
        )
        over = client.post(
            f"/api/content/proposals/{UUID}/approve", json={field: "x" * (limit + 1)}
        )

    assert at_limit.status_code == 202
    assert over.status_code == 400
    assert len(seen) == 1


@pytest.mark.parametrize(
    "body", [{"topic": 5}, {"note": ["a"]}, {"extra": "never forwarded"}]
)
def test_bad_fields_are_rejected(body):
    client, patcher, seen = _client(_queued)
    with patcher:
        resp = client.post(f"/api/content/proposals/{UUID}/approve", json=body)

    assert resp.status_code == 400
    assert seen == []


def test_body_over_2kb_is_rejected():
    client, patcher, seen = _client(_queued)
    with patcher:
        resp = client.post(
            f"/api/content/proposals/{UUID}/approve",
            content=json.dumps({"topic": "x" * 2100}),
            headers={"Content-Type": "application/json"},
        )

    assert resp.status_code == 413
    assert seen == []


@pytest.mark.parametrize("raw", ["not json", "[1, 2]", '"text"'])
def test_malformed_bodies_are_rejected(raw):
    client, patcher, seen = _client(_queued)
    with patcher:
        resp = client.post(
            f"/api/content/proposals/{UUID}/approve",
            content=raw,
            headers={"Content-Type": "application/json"},
        )

    assert resp.status_code == 400
    assert seen == []


@pytest.mark.parametrize("action", ["accept", "APPROVE", "used", "approve;x", "delete"])
def test_other_proposal_actions_are_rejected(action):
    client, patcher, seen = _client(_queued)
    with patcher:
        resp = client.post(f"/api/content/proposals/{UUID}/{action}")

    assert resp.status_code in (400, 404)
    assert seen == []


@pytest.mark.parametrize(
    "bad_id",
    [
        "42",
        UUID.upper(),
        UUID[:-1],
        UUID + "0",
        UUID.replace("-", ""),
        "0f8fad5b-d9cb-469f-a165-70867728950g",
        "0f8fad5b-d9cb-469f-a165-7086772895-e",
        "..%2F..%2Fpanels%2Fx",
    ],
)
def test_non_uuid_ids_are_rejected(bad_id):
    client, patcher, seen = _client(_queued)
    with patcher:
        r1 = client.post(f"/api/content/proposals/{bad_id}/approve")
        r2 = client.post(f"/api/content/prompts/{bad_id}/used")

    assert r1.status_code in (400, 404)
    assert r2.status_code in (400, 404)
    assert seen == []


# -- thesis prompts and research ---------------------------------------------


@pytest.mark.parametrize("action", sorted(cr.PROMPT_ACTIONS))
def test_prompt_mark_is_forwarded_without_a_body(action):
    client, patcher, seen = _client(_queued)
    with patcher:
        resp = client.post(f"/api/content/prompts/{UUID}/{action}", json={"note": "x"})

    assert resp.status_code == 202
    assert seen[0].url.path == f"/content/prompts/{UUID}/{action}"
    assert seen[0].content == b""


@pytest.mark.parametrize("action", ["approve", "reject", "open", "USED"])
def test_other_prompt_actions_are_rejected(action):
    client, patcher, seen = _client(_queued)
    with patcher:
        resp = client.post(f"/api/content/prompts/{UUID}/{action}")

    assert resp.status_code == 400
    assert seen == []


def test_research_more_hits_the_ideation_refresh_route():
    client, patcher, seen = _client(_queued)
    with patcher:
        resp = client.post("/api/content/ideation/refresh")

    assert resp.status_code == 202
    assert seen[0].url.path == "/panels/content_ideation/refresh"


def test_bridge_refusal_is_passed_through():
    client, patcher, _ = _client(
        lambda r: httpx.Response(405, json={"error": "read-only"})
    )
    with patcher:
        resp = client.post(f"/api/content/proposals/{UUID}/approve")

    assert resp.status_code == 405
    assert resp.json() == {"error": "read-only"}


def test_actions_with_bridge_down_are_503():
    client, patcher, _ = _client(_down)
    with patcher:
        assert client.post(f"/api/content/proposals/{UUID}/reject").status_code == 503
        assert client.post(f"/api/content/prompts/{UUID}/dismissed").status_code == 503
        assert client.post("/api/content/ideation/refresh").status_code == 503
