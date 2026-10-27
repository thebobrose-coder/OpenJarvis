"""Tests for /api/content (Hermes content-strategist feed proxy and its actions).

Neutral fixtures only (property `alpha`, pillar `grit`, product
`sample-mount`): this repo is public and real proposals name the operator's
properties, products and topics.
"""

from __future__ import annotations

import json
import subprocess
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


def _client(handler, host="127.0.0.1"):
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
    return TestClient(app, client=(host, 50000)), patcher, seen


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


def test_approve_forwards_target_queries_and_priority():
    client, patcher, seen = _client(_queued)
    with patcher:
        client.post(
            f"/api/content/proposals/{UUID}/approve",
            json={"target_queries": [" budget rig ", "sample mount"], "priority": 3},
        )
        client.post(
            f"/api/content/proposals/{UUID}/approve",
            json={"target_queries": [], "priority": None, "note": "Clear them."},
        )

    assert json.loads(seen[0].content) == {
        "target_queries": ["budget rig", "sample mount"],
        "priority": 3,
    }
    # `[]` removes the queries and null resets the priority: both are forwarded.
    assert json.loads(seen[1].content) == {
        "note": "Clear them.",
        "target_queries": [],
        "priority": None,
    }


@pytest.mark.parametrize(
    "body",
    [
        {"target_queries": ["a", "b", "c", "d"]},
        {"target_queries": ["x" * 81]},
        {"target_queries": [" "]},
        {"target_queries": "budget rig"},
        {"target_queries": [5]},
        {"priority": 9},
        {"priority": 0},
        {"priority": "2"},
        {"priority": True},
        {"target_queries": ["budget rig"], "topic": 5},
    ],
)
def test_bad_targeting_is_rejected(body):
    client, patcher, seen = _client(_queued)
    with patcher:
        resp = client.post(f"/api/content/proposals/{UUID}/approve", json=body)

    assert resp.status_code == 400
    assert seen == []


def test_reject_never_forwards_targeting():
    client, patcher, seen = _client(_queued)
    with patcher:
        resp = client.post(
            f"/api/content/proposals/{UUID}/reject", json={"priority": 1}
        )

    assert resp.status_code == 400
    assert seen == []


def test_approve_body_over_12kb_is_rejected():
    # v1.17.3: the bridge reads approve bodies up to 12,288 bytes (was 4096),
    # so a 10-source edit fits.
    sources = [f"https://example.com/{i}/" + "p" * 470 for i in range(10)]
    raw = json.dumps({"topic": "é" * 590, "note": "é" * 490})
    client, patcher, seen = _client(_queued)
    with patcher:
        ok = client.post(
            f"/api/content/proposals/{UUID}/approve",
            content=json.dumps({"topic": "x" * 600, "sources": sources}),
            headers={"Content-Type": "application/json"},
        )
        over = client.post(
            f"/api/content/proposals/{UUID}/approve",
            content=raw.encode() + b" " * 12288,
            headers={"Content-Type": "application/json"},
        )

    assert ok.status_code == 202
    assert len(json.dumps({"topic": "x" * 600, "sources": sources})) > 4096
    assert over.status_code == 413
    assert len(seen) == 1


# -- v1.17.3 episode edits, v2.7.1 range, v2.8 the episode tag -------------


def test_approve_forwards_the_episode_edits():
    client, patcher, seen = _client(_queued)
    with patcher:
        client.post(
            f"/api/content/proposals/{UUID}/approve",
            json={
                "episode_class": "sample-check",
                "sources": [" https://example.com/a ", "https://example.com/b"],
                "target_minutes": 4,
            },
        )
        client.post(
            f"/api/content/proposals/{UUID}/approve",
            json={"target_minutes": 6},
        )
        client.post(
            f"/api/content/proposals/{UUID}/approve",
            json={"target_minutes": None},
        )

    assert json.loads(seen[0].content) == {
        "episode_class": "sample-check",
        "sources": ["https://example.com/a", "https://example.com/b"],
        "target_minutes": 4,
    }
    assert json.loads(seen[1].content) == {"target_minutes": 6}
    # Blank sends null: the intake's default (5).
    assert json.loads(seen[2].content) == {"target_minutes": None}


def test_approve_forwards_the_episode_tag_and_its_removal():
    client, patcher, seen = _client(_queued)
    with patcher:
        client.post(
            f"/api/content/proposals/{UUID}/approve",
            json={"episode": {"class": "sample-check", "target_minutes": 6}},
        )
        client.post(
            f"/api/content/proposals/{UUID}/approve",
            json={"episode": {"class": "sample-check", "target_minutes": None}},
        )
        client.post(f"/api/content/proposals/{UUID}/approve", json={"episode": None})

    assert json.loads(seen[0].content) == {
        "episode": {"class": "sample-check", "target_minutes": 6}
    }
    assert json.loads(seen[1].content) == {"episode": {"class": "sample-check"}}
    assert json.loads(seen[2].content) == {"episode": None}


@pytest.mark.parametrize(
    "body, detail",
    [
        (
            {"target_minutes": 3},
            "target_minutes is a whole number 4-6, or null for the default",
        ),
        (
            {"target_minutes": 7},
            "target_minutes is a whole number 4-6, or null for the default",
        ),
        (
            {"target_minutes": 12},
            "target_minutes is a whole number 4-6, or null for the default",
        ),
        (
            {"target_minutes": True},
            "target_minutes is a whole number 4-6, or null for the default",
        ),
        ({"episode_class": ""}, "episode_class is required"),
        ({"episode_class": None}, "episode_class is required"),
        ({"sources": []}, "sources: 1-10 https links of at most 500 characters"),
        (
            {"sources": ["http://example.com/a"]},
            "sources: 1-10 https links of at most 500 characters",
        ),
        ({"episode": "x"}, "episode: {class, target_minutes?} or null"),
        ({"episode": {"klass": "x"}}, "episode: {class, target_minutes?} or null"),
        ({"episode": {"class": ""}}, "episode.class is required"),
        (
            {"episode": {"class": "sample-check", "target_minutes": 7}},
            "target_minutes is a whole number 4-6",
        ),
    ],
)
def test_bad_episode_edits_are_400_and_never_forwarded(body, detail):
    client, patcher, seen = _client(_queued)
    with patcher:
        resp = client.post(f"/api/content/proposals/{UUID}/approve", json=body)

    assert resp.status_code == 400
    assert resp.json()["detail"] == detail
    assert seen == []


def test_reject_never_forwards_episode_edits():
    client, patcher, seen = _client(_queued)
    with patcher:
        resp = client.post(
            f"/api/content/proposals/{UUID}/reject", json={"target_minutes": 5}
        )

    assert resp.status_code == 400
    assert seen == []


def test_reject_body_stays_at_2kb():
    client, patcher, seen = _client(_queued)
    with patcher:
        resp = client.post(
            f"/api/content/proposals/{UUID}/reject",
            content=json.dumps({"note": "x" * 2100}),
            headers={"Content-Type": "application/json"},
        )

    assert resp.status_code == 413
    assert seen == []


# -- v1.14 the video flag ----------------------------------------------------


def test_approve_forwards_the_motion_fields():
    client, patcher, seen = _client(_queued)
    with patcher:
        client.post(
            f"/api/content/proposals/{UUID}/approve",
            json={
                "motion": "always",
                "motion_brief": "  A rover tips over a dune crest  ",
                "video_asset_key": "assets/alpha/clip.mp4",
            },
        )
        client.post(
            f"/api/content/proposals/{UUID}/approve",
            json={"motion": None, "motion_brief": "", "video_asset_key": ""},
        )
        client.post(f"/api/content/proposals/{UUID}/approve", json={"motion": "never"})

    assert json.loads(seen[0].content) == {
        "motion": "always",
        "motion_brief": "A rover tips over a dune crest",
        "video_asset_key": "assets/alpha/clip.mp4",
    }
    # null clears to the lane default; "" removes the beat and the key.
    assert json.loads(seen[1].content) == {
        "motion": None,
        "motion_brief": "",
        "video_asset_key": "",
    }
    assert json.loads(seen[2].content) == {"motion": "never"}


@pytest.mark.parametrize(
    "body, detail",
    [
        ({"motion": "maybe"}, 'motion: "always", "never" or null'),
        ({"motion": True}, 'motion: "always", "never" or null'),
        (
            {"motion_brief": None},
            "motion_brief: a string of at most 240 characters",
        ),
        (
            {"motion_brief": "b" * 241},
            "motion_brief: a string of at most 240 characters",
        ),
        (
            {"video_asset_key": None},
            "video_asset_key: a string of at most 512 characters",
        ),
        (
            {"video_asset_key": "k" * 513},
            "video_asset_key: a string of at most 512 characters",
        ),
    ],
)
def test_bad_motion_shapes_are_400_and_never_forwarded(body, detail):
    client, patcher, seen = _client(_queued)
    with patcher:
        resp = client.post(f"/api/content/proposals/{UUID}/approve", json=body)

    assert resp.status_code == 400
    assert resp.json()["detail"] == detail
    assert seen == []


def test_reject_never_forwards_motion():
    client, patcher, seen = _client(_queued)
    with patcher:
        resp = client.post(
            f"/api/content/proposals/{UUID}/reject", json={"motion": "never"}
        )

    assert resp.status_code == 400
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


# -- v1.16 operator seeds ----------------------------------------------------

SEED = {
    "property_id": "alpha",
    "content_type": "short",
    "text": "  Sample topic about budget rigs  ",
    "pillar_hint": "grit",
    "product_handle": "sample-mount",
    "url": "https://example.com/a",
    "target_queries": [" budget rig "],
    "priority": 3,
    "source_prompt_id": UUID,
}


def _minted(req):
    return httpx.Response(202, json={"queued": True, "proposal_id": UUID})


def test_seed_is_forwarded_trimmed_and_the_202_passed_through():
    client, patcher, seen = _client(_minted)
    with patcher:
        resp = client.post("/api/content/seeds", json=SEED)

    assert resp.status_code == 202
    assert resp.json() == {"queued": True, "proposal_id": UUID}
    assert seen[0].method == "POST" and seen[0].url.path == "/content/seeds"
    assert json.loads(seen[0].content) == {
        **SEED,
        "text": "Sample topic about budget rigs",
        "target_queries": ["budget rig"],
    }


def test_minimal_seed_sends_only_what_was_given():
    body = {"property_id": "alpha", "content_type": "thesis", "text": "Title\n\nBody"}
    sent = {**body, "pillar_hint": "", "product_handle": "", "url": ""}
    sent["target_queries"] = []
    client, patcher, seen = _client(_minted)
    with patcher:
        assert client.post("/api/content/seeds", json=sent).status_code == 202

    assert json.loads(seen[0].content) == body


def test_seed_passes_the_motion_fields_and_drops_the_defaults():
    video = {
        "motion": "always",
        "motion_brief": " A rover tips over a dune crest ",
        "video_asset_key": "assets/alpha/clip.mp4",
    }
    client, patcher, seen = _client(_minted)
    with patcher:
        assert (
            client.post("/api/content/seeds", json={**SEED, **video}).status_code == 202
        )
        defaults = {"motion": None, "motion_brief": "", "video_asset_key": ""}
        assert (
            client.post("/api/content/seeds", json={**SEED, **defaults}).status_code
            == 202
        )

    sent = json.loads(seen[0].content)
    assert sent["motion"] == "always"
    assert sent["motion_brief"] == "A rover tips over a dune crest"
    assert sent["video_asset_key"] == "assets/alpha/clip.mp4"
    assert not {"motion", "motion_brief", "video_asset_key"} & set(
        json.loads(seen[1].content)
    )


EPISODE = {
    "property_id": "alpha",
    "content_type": "episode",
    "text": "Sample topic about budget rigs",
    "episode_class": "sample-class",
    "sources": [" https://example.com/a ", "https://example.com/b"],
    "target_minutes": 5,
}


def test_episode_seed_carries_its_three_fields():
    client, patcher, seen = _client(_minted)
    with patcher:
        assert client.post("/api/content/seeds", json=EPISODE).status_code == 202

    sent = json.loads(seen[0].content)
    assert sent["episode_class"] == "sample-class"
    assert sent["sources"] == ["https://example.com/a", "https://example.com/b"]
    assert sent["target_minutes"] == 5


@pytest.mark.parametrize(
    "bad",
    [
        {"episode_class": None},
        {"sources": []},
        {"sources": ["http://example.com/a"]},
        {"sources": [f"https://example.com/{i}" for i in range(11)]},
        {"target_minutes": 3},
        {"target_minutes": 7},
        {"target_minutes": 12},
        {"target_minutes": True},
        {"target_minutes": None},
    ],
)
def test_episode_seed_refuses_a_missing_or_bad_field(bad):
    client, patcher, seen = _client(_minted)
    with patcher:
        resp = client.post("/api/content/seeds", json={**EPISODE, **bad})

    assert resp.status_code == 400
    assert seen == []


def test_episode_fields_are_refused_off_the_episode_lane():
    client, patcher, seen = _client(_minted)
    with patcher:
        resp = client.post("/api/content/seeds", json={**SEED, "target_minutes": 5})

    assert resp.status_code == 400
    assert "episode lane" in resp.json()["detail"]
    assert seen == []


def test_seed_of_6000_characters_passes():
    text = "x" * 6000
    client, patcher, seen = _client(_minted)
    with patcher:
        resp = client.post("/api/content/seeds", json={**SEED, "text": text})
    assert resp.status_code == 202
    assert json.loads(seen[0].content)["text"] == text


def test_seed_over_16kb_is_413_and_never_forwarded():
    raw = json.dumps({**SEED, "text": "x" * 17000})
    client, patcher, seen = _client(_minted)
    with patcher:
        resp = client.post(
            "/api/content/seeds",
            content=raw,
            headers={"content-type": "application/json"},
        )
    assert resp.status_code == 413
    assert seen == []


@pytest.mark.parametrize(
    "change",
    [
        {"motion": "maybe"},
        {"motion_brief": None},
        {"motion_brief": "b" * 241},
        {"video_asset_key": "k" * 513},
        {"topic": "x"},
        {"property_id": ""},
        {"property_id": "../x"},
        {"content_type": None},
        {"text": "   "},
        {"text": "x" * 6001},
        {"pillar_hint": "p" * 121},
        {"product_handle": "Sample Mount"},
        {"product_handle": "h" * 121},
        {"url": "http://example.com"},
        {"url": "https://example.com/" + "a" * 500},
        {"target_queries": ["a", "b", "c", "d"]},
        {"target_queries": ["q" * 81]},
        {"priority": 4},
        {"priority": True},
        {"source_prompt_id": "not-a-uuid"},
    ],
)
def test_bad_seed_shapes_are_400_and_never_forwarded(change):
    client, patcher, seen = _client(_minted)
    with patcher:
        resp = client.post("/api/content/seeds", json={**SEED, **change})
    assert resp.status_code == 400
    assert seen == []


def test_seed_needs_a_body():
    client, patcher, seen = _client(_minted)
    with patcher:
        assert client.post("/api/content/seeds").status_code == 400
    assert seen == []


def test_bridge_seed_refusal_is_passed_through():
    client, patcher, _ = _client(
        lambda r: httpx.Response(400, json={"error": "unknown keys: x"})
    )
    with patcher:
        resp = client.post("/api/content/seeds", json=SEED)
    assert resp.status_code == 400
    assert resp.json() == {"error": "unknown keys: x"}


def test_seed_with_bridge_down_is_503():
    client, patcher, _ = _client(_down)
    with patcher:
        assert client.post("/api/content/seeds", json=SEED).status_code == 503


def test_new_routes_answer_only_this_machine():
    client, patcher, seen = _client(_minted, host="192.168.1.20")
    with patcher:
        assert client.post("/api/content/seeds", json=SEED).status_code == 403
        verify = "/api/content/verify-product?property=alpha&handle=sample-mount"
        assert client.get(verify).status_code == 403
        assert client.post("/api/content/intake/run").status_code == 403
    assert seen == []


def test_verify_product_is_forwarded_read_only():
    found = {
        "found": True,
        "title": "Sample Mount",
        "source": "bundle",
        "checked_at": "2026-10-22T04:00:00Z",
    }
    client, patcher, seen = _client(lambda r: httpx.Response(200, json=found))
    with patcher:
        resp = client.get(
            "/api/content/verify-product?property=alpha&handle=sample-mount"
        )
    assert resp.status_code == 200 and resp.json() == found
    assert seen[0].method == "GET"
    assert seen[0].url.path == "/content/verify-product"
    assert dict(seen[0].url.params) == {"property": "alpha", "handle": "sample-mount"}


@pytest.mark.parametrize(
    "status,body",
    [
        (502, {"error": "no storefront known for this property"}),
        (404, {"error": "unknown property"}),
        (200, {"found": False, "source": "storefront", "checked_at": "x"}),
    ],
)
def test_verify_product_passes_the_bridge_answer_through(status, body):
    client, patcher, _ = _client(lambda r: httpx.Response(status, json=body))
    with patcher:
        resp = client.get(
            "/api/content/verify-product?property=alpha&handle=sample-mount"
        )
    assert resp.status_code == status and resp.json() == body


@pytest.mark.parametrize(
    "query",
    ["property=alpha", "handle=sample-mount", "property=alpha&handle=Bad Handle"],
)
def test_verify_product_bad_parameters_are_400(query):
    client, patcher, seen = _client(_minted)
    with patcher:
        assert client.get(f"/api/content/verify-product?{query}").status_code == 400
    assert seen == []


def test_verify_product_is_not_taken_for_a_feed():
    client, patcher, seen = _client(_minted)
    with patcher:
        resp = client.get("/api/content/verify-product")
    assert resp.status_code == 400  # not the feed route's 404
    assert seen == []


def test_verify_product_with_bridge_down_is_503():
    client, patcher, _ = _client(_down)
    with patcher:
        resp = client.get(
            "/api/content/verify-product?property=alpha&handle=sample-mount"
        )
    assert resp.status_code == 503


@pytest.fixture
def intake(monkeypatch):
    monkeypatch.setattr(cr.sys, "platform", "win32")
    monkeypatch.setattr(cr, "_intake_last_run", None)
    calls = []

    def fake_run(args, **kwargs):
        calls.append((args, kwargs))
        return subprocess.CompletedProcess(args, 0, stdout="SUCCESS", stderr="")

    with patch.object(cr.subprocess, "run", side_effect=fake_run):
        yield calls


def test_intake_run_starts_the_foundry_task(intake):
    client, patcher, seen = _client(_minted)
    with patcher:
        resp = client.post("/api/content/intake/run")
    assert resp.status_code == 202 and "started_at" in resp.json()
    assert intake[0][0] == ["schtasks", "/Run", "/TN", r"\Foundry\ProposalIntake"]
    assert intake[0][1]["timeout"] == 10
    assert seen == []  # nothing reaches Hermes


def test_intake_run_twice_inside_2_minutes_is_429(intake, monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr(cr.time, "monotonic", lambda: clock[0])
    client, patcher, _ = _client(_minted)
    with patcher:
        assert client.post("/api/content/intake/run").status_code == 202
        clock[0] += 60
        resp = client.post("/api/content/intake/run")
        assert resp.status_code == 429
        assert resp.json()["retry_after"] == 61
        assert resp.headers["retry-after"] == "61"
        clock[0] += 61
        assert client.post("/api/content/intake/run").status_code == 202
    assert len(intake) == 2


def test_intake_run_failure_is_503_and_starts_no_cooldown(monkeypatch):
    monkeypatch.setattr(cr.sys, "platform", "win32")
    monkeypatch.setattr(cr, "_intake_last_run", None)
    failed = subprocess.CompletedProcess(
        [], 1, stdout="", stderr="ERROR: The system cannot find the file.\n"
    )
    client, patcher, _ = _client(_minted)
    with patcher, patch.object(cr.subprocess, "run", return_value=failed):
        resp = client.post("/api/content/intake/run")
        assert resp.status_code == 503
        assert resp.json()["detail"] == "ERROR: The system cannot find the file."
    assert cr._intake_last_run is None


def test_intake_run_off_windows_is_501(monkeypatch):
    monkeypatch.setattr(cr.sys, "platform", "linux")
    client, patcher, _ = _client(_minted)
    with patcher:
        assert client.post("/api/content/intake/run").status_code == 501
