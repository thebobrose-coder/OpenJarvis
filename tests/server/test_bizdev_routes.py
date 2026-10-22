"""Tests for /api/bizdev (Hermes bd-researcher feed proxy and its actions).

Neutral fixtures only (Example College, a.person@example.edu): this repo is
public and real prospect data includes people's names and emails.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest

pytest.importorskip("fastapi", reason="openjarvis[server] not installed")

import httpx

from openjarvis.server import bizdev_routes as br


def _payload(feed: str = "bd_pipeline", age_s: int = 60) -> dict:
    stamp = datetime.now(timezone.utc) - timedelta(seconds=age_s)
    return {
        "feed": feed,
        "generated_at": stamp.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "age_seconds": age_s,
        "source_role": "bd-researcher",
        "data": {
            "run_at": "2026-09-28T07:30:00",
            "lines": [{"line": "line-a", "display_name": "Line A"}],
        },
    }


@pytest.fixture(autouse=True)
def _reset():
    br._cache.clear()
    yield
    br._cache.clear()


def _client(handler):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(br.bizdev_router)
    real_client = httpx.AsyncClient
    seen: list[httpx.Request] = []

    def recording(req):
        seen.append(req)
        return handler(req)

    def fake_client(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(recording)
        return real_client(*args, **kwargs)

    patcher = patch.object(br.httpx, "AsyncClient", side_effect=fake_client)
    return TestClient(app), patcher, seen


def _down(req):
    raise httpx.ConnectError("refused", request=req)


def _queued(req):
    return httpx.Response(202, json={"queued": True})


# -- GET feeds ---------------------------------------------------------------


@pytest.mark.parametrize("feed", sorted(br.FEEDS))
def test_allowed_feed_is_unwrapped_with_freshness(feed):
    client, patcher, seen = _client(lambda r: httpx.Response(200, json=_payload(feed)))
    with patcher:
        body = client.get(f"/api/bizdev/{feed}").json()

    assert body["lines"] == [{"line": "line-a", "display_name": "Line A"}]
    assert body["age_seconds"] == 60
    assert body["stale"] is False
    assert seen[0].url.path == f"/panels/{feed}"


@pytest.mark.parametrize("feed", ["ecom_daily", "digest_general", "bd_research"])
def test_other_feeds_are_never_forwarded(feed):
    client, patcher, seen = _client(lambda r: httpx.Response(200, json=_payload()))
    with patcher:
        resp = client.get(f"/api/bizdev/{feed}")

    assert resp.status_code == 404
    assert seen == []


def test_feed_before_its_first_run_is_no_data_yet():
    client, patcher, _ = _client(lambda r: httpx.Response(404))
    with patcher:
        resp = client.get("/api/bizdev/bd_stats")

    assert resp.status_code == 404
    assert resp.json()["detail"] == "No data yet"


def test_bridge_down_without_cache_is_503():
    client, patcher, _ = _client(_down)
    with patcher:
        assert client.get("/api/bizdev/bd_pipeline").status_code == 503


def test_bridge_down_serves_last_known_with_age():
    up = {"ok": True}

    def handler(req):
        return (
            httpx.Response(200, json=_payload(age_s=7200)) if up["ok"] else _down(req)
        )

    client, patcher, _ = _client(handler)
    with patcher:
        client.get("/api/bizdev/bd_pipeline")
        up["ok"] = False
        body = client.get("/api/bizdev/bd_pipeline").json()

    assert body["stale"] is True
    assert 7200 - 60 <= body["age_seconds"] <= 7200 + 60


# -- stage moves -------------------------------------------------------------


@pytest.mark.parametrize("stage", sorted(br.STAGES))
def test_stage_is_forwarded(stage):
    client, patcher, seen = _client(_queued)
    with patcher:
        resp = client.post(f"/api/bizdev/prospects/42/{stage}")

    assert resp.status_code == 202
    assert seen[0].url.path == f"/bd/prospects/42/{stage}"
    assert seen[0].content == b""


def test_stage_note_is_trimmed_and_forwarded():
    client, patcher, seen = _client(_queued)
    with patcher:
        client.post(
            "/api/bizdev/prospects/7/replied", json={"note": "  Asked for a call.  "}
        )

    assert json.loads(seen[0].content) == {"note": "Asked for a call."}


@pytest.mark.parametrize("stage", ["new", "suppressed", "recheck2", "SENT", "sent;x"])
def test_other_stages_are_rejected(stage):
    client, patcher, seen = _client(_queued)
    with patcher:
        resp = client.post(f"/api/bizdev/prospects/42/{stage}")

    assert resp.status_code in (400, 404)
    assert seen == []


@pytest.mark.parametrize("pid", ["0", "-1", "abc", "1.5", "01", "12345678901", "4%2F2"])
def test_non_integer_ids_are_rejected(pid):
    client, patcher, seen = _client(_queued)
    with patcher:
        resp = client.post(f"/api/bizdev/prospects/{pid}/sent")
        resp2 = client.post(f"/api/bizdev/prospects/{pid}/recheck")

    assert resp.status_code in (400, 404)
    assert resp2.status_code in (400, 404)
    assert seen == []


def test_note_over_500_characters_is_rejected():
    client, patcher, seen = _client(_queued)
    with patcher:
        resp = client.post("/api/bizdev/prospects/42/lost", json={"note": "x" * 501})

    assert resp.status_code == 400
    assert seen == []


def test_body_over_2kb_is_rejected():
    client, patcher, seen = _client(_queued)
    with patcher:
        resp = client.post(
            "/api/bizdev/prospects/42/lost",
            content=json.dumps({"note": "x", "pad": "y" * 2100}),
            headers={"Content-Type": "application/json"},
        )

    assert resp.status_code == 413
    assert seen == []


@pytest.mark.parametrize("raw", ["not json", "[1, 2]", '"text"'])
def test_malformed_bodies_are_rejected(raw):
    client, patcher, seen = _client(_queued)
    with patcher:
        resp = client.post(
            "/api/bizdev/prospects/42/sent",
            content=raw,
            headers={"Content-Type": "application/json"},
        )

    assert resp.status_code == 400
    assert seen == []


# -- recheck, queue, research ------------------------------------------------


def test_recheck_is_forwarded_without_a_body():
    client, patcher, seen = _client(_queued)
    with patcher:
        resp = client.post("/api/bizdev/prospects/42/recheck")

    assert resp.status_code == 202
    assert seen[0].url.path == "/bd/prospects/42/recheck"
    assert seen[0].content == b""


def test_queue_forwards_only_the_three_fields():
    client, patcher, seen = _client(_queued)
    with patcher:
        resp = client.post(
            "/api/bizdev/queue",
            json={
                "line": "line-a",
                "name": " Example College ",
                "association": "Example Association",
                "extra": "never forwarded",
            },
        )

    assert resp.status_code == 202
    assert seen[0].url.path == "/bd/queue"
    assert json.loads(seen[0].content) == {
        "line": "line-a",
        "name": "Example College",
        "association": "Example Association",
    }


@pytest.mark.parametrize(
    "body",
    [
        None,
        {"line": "line-a", "name": "Example College"},
        {"line": "line-a", "name": "", "association": "Example Association"},
        {"line": "line-a", "name": 5, "association": "Example Association"},
        {"line": "line-a", "name": "x" * 201, "association": "Example Association"},
    ],
)
def test_queue_rejects_incomplete_bodies(body):
    client, patcher, seen = _client(_queued)
    with patcher:
        resp = client.post("/api/bizdev/queue", **({"json": body} if body else {}))

    assert resp.status_code == 400
    assert seen == []


def test_research_more_hits_the_refresh_route():
    client, patcher, seen = _client(_queued)
    with patcher:
        resp = client.post("/api/bizdev/research/refresh")

    assert resp.status_code == 202
    assert seen[0].url.path == "/panels/bd_research/refresh"


def test_bridge_refusal_is_passed_through():
    client, patcher, _ = _client(
        lambda r: httpx.Response(429, json={"detail": "recheck cap reached"})
    )
    with patcher:
        resp = client.post("/api/bizdev/prospects/42/recheck")

    assert resp.status_code == 429
    assert resp.json()["detail"] == "recheck cap reached"


def test_actions_with_bridge_down_are_503():
    client, patcher, _ = _client(_down)
    with patcher:
        assert client.post("/api/bizdev/prospects/42/sent").status_code == 503
        assert client.post("/api/bizdev/research/refresh").status_code == 503


# -- Add recipient (contract v0.10.7, hq 0018 A3) -----------------------------


def _board(stage: str = "drafted") -> dict:
    card = {"id": 42, "name": "Example College", "contacts": [], "touches": []}
    stages = {"drafted": [], "sent": []}
    if stage in stages:
        stages[stage] = [card]
    return {
        "feed": "bd_pipeline",
        "generated_at": "2026-10-22T12:00:00Z",
        "data": {"lines": [{"line": "line-a", "stages": stages}]},
    }


def _contact_client(stage: str = "drafted", post=None):
    """A loopback client over a bridge that serves the board and answers the
    contact route like the live one (202 with the action)."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    def handler(req: httpx.Request):
        if req.method == "GET" and req.url.path == "/panels/bd_pipeline":
            return httpx.Response(200, json=_board(stage))
        if post is not None:
            return post(req)
        return httpx.Response(202, json={"id": 42, "action": "contact", "queued": True})

    app = FastAPI()
    app.include_router(br.bizdev_router)
    real_client = httpx.AsyncClient
    seen: list[httpx.Request] = []

    def fake_client(*args, **kwargs):
        def recording(req):
            seen.append(req)
            return handler(req)

        kwargs["transport"] = httpx.MockTransport(recording)
        return real_client(*args, **kwargs)

    patcher = patch.object(br.httpx, "AsyncClient", side_effect=fake_client)
    return TestClient(app, client=("127.0.0.1", 50000)), patcher, seen


def _posts(seen: list[httpx.Request]) -> list[httpx.Request]:
    return [r for r in seen if r.method == "POST"]


def test_add_contact_validates_and_forwards_once():
    client, patcher, seen = _contact_client()
    with patcher:
        resp = client.post(
            "/api/bizdev/prospects/42/contact",
            json={
                "name": "  A Person ",
                "title": "Sports Information Director",
                "email": " a.person@example.edu ",
                "extra": "dropped",
            },
        )
    assert resp.status_code == 202
    assert resp.json() == {"id": 42, "action": "contact", "queued": True}
    posts = _posts(seen)
    assert len(posts) == 1
    assert posts[0].url.path == "/bd/prospects/42/contact"
    assert json.loads(posts[0].content) == {
        "email": "a.person@example.edu",
        "name": "A Person",
        "title": "Sports Information Director",
    }


def test_add_contact_leaves_out_empty_name_and_title():
    client, patcher, seen = _contact_client()
    with patcher:
        resp = client.post(
            "/api/bizdev/prospects/42/contact",
            json={"name": "", "email": "b.person@example.org"},
        )
    assert resp.status_code == 202
    assert json.loads(_posts(seen)[0].content) == {"email": "b.person@example.org"}


@pytest.mark.parametrize(
    "body,status",
    [
        ({}, 400),
        ({"email": 7}, 400),
        ({"email": "not-an-address"}, 422),
        ({"email": "a@example.edu, b@example.edu"}, 422),
        ({"email": "a person@example.edu"}, 422),
        ({"email": "a" * 243 + "@example.edu"}, 422),  # 255 characters
        ({"email": "a@example.edu", "name": "n" * 121}, 422),
        ({"email": "a@example.edu", "title": "t" * 121}, 422),
        ({"email": "a@example.edu", "name": ["x"]}, 400),
    ],
)
def test_a_bad_contact_is_refused_before_the_bridge(body, status):
    client, patcher, seen = _contact_client()
    with patcher:
        resp = client.post("/api/bizdev/prospects/42/contact", json=body)
    assert resp.status_code == status
    assert seen == []


def test_an_address_of_254_characters_is_accepted():
    client, patcher, seen = _contact_client()
    with patcher:
        resp = client.post(
            "/api/bizdev/prospects/42/contact",
            json={"email": "a" * 242 + "@example.edu"},
        )
    assert resp.status_code == 202 and len(_posts(seen)) == 1


def test_a_suppressed_card_gets_nothing_forwarded():
    client, patcher, seen = _contact_client(stage="bounced")
    with patcher:
        resp = client.post(
            "/api/bizdev/prospects/42/contact", json={"email": "a@example.edu"}
        )
    assert resp.status_code == 409
    assert _posts(seen) == []


def test_a_bridge_5xx_on_add_contact_is_relayed():
    client, patcher, seen = _contact_client(
        post=lambda r: httpx.Response(500, json={"detail": "bridge error"})
    )
    with patcher:
        resp = client.post(
            "/api/bizdev/prospects/42/contact", json={"email": "a@example.edu"}
        )
    assert resp.status_code == 500
    assert len(_posts(seen)) == 1


def test_add_contact_is_local_only():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(br.bizdev_router)
    resp = TestClient(app, client=("203.0.113.9", 50000)).post(
        "/api/bizdev/prospects/42/contact", json={"email": "a@example.edu"}
    )
    assert resp.status_code == 403


def test_contact_is_never_read_as_a_stage():
    assert "contact" not in br.STAGES
