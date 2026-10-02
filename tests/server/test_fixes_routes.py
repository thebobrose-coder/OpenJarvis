"""Tests for /api/commerce/fixes (catalog-fix decisions, contract v1.3)."""

from __future__ import annotations

import json
from unittest.mock import patch

import pytest

pytest.importorskip("fastapi", reason="openjarvis[server] not installed")

import httpx

from openjarvis.server import commerce_routes as cr
from openjarvis.server import fixes_routes as fr

_ID = "0123456789ab"
_SHA = "a" * 64
_TOKEN = "f" * 64


@pytest.fixture(autouse=True)
def _token(tmp_path, monkeypatch):
    path = tmp_path / "token"
    path.write_text(_TOKEN + "\n", encoding="utf-8")
    monkeypatch.setattr(
        fr,
        "get_tool_credential",
        lambda tool, key: str(path) if key == fr.TOKEN_KEY else None,
    )
    return path


def _client(handler):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(fr.fixes_router)
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


def _queued(req):
    action = req.url.path.rsplit("/", 1)[-1]
    return httpx.Response(202, json={"id": _ID, "action": action, "queued": True})


def test_approve_sends_the_displayed_hash_with_the_token():
    client, patcher, seen = _client(_queued)
    with patcher:
        resp = client.post(
            f"/api/commerce/fixes/{_ID}/approve", json={"patch_sha256": _SHA}
        )
    assert resp.status_code == 202
    assert resp.json() == {"id": _ID, "action": "approve", "queued": True}
    assert seen[0].url.path == f"/fixes/{_ID}/approve"
    assert seen[0].headers["X-Operator-Token"] == _TOKEN
    assert json.loads(seen[0].content) == {"patch_sha256": _SHA}


def test_approve_over_judge_forwards_the_flag():
    client, patcher, seen = _client(_queued)
    with patcher:
        resp = client.post(
            f"/api/commerce/fixes/{_ID}/approve",
            json={"patch_sha256": _SHA, "over_judge": True, "note": "spec is right"},
        )
    assert resp.status_code == 202
    assert json.loads(seen[0].content) == {
        "patch_sha256": _SHA,
        "over_judge": True,
        "note": "spec is right",
    }


def test_approve_class_review_only_refusal_passes_through():
    reply = {"approved": [], "refused": [{"id": _ID, "reason": "review_only"}]}
    client, patcher, _ = _client(lambda req: httpx.Response(202, json=reply))
    body = {
        "store": "alpha",
        "rule": "4",
        "field": "descriptionHtml",
        "patches": [{"id": _ID, "patch_sha256": _SHA}],
    }
    with patcher:
        resp = client.post("/api/commerce/fixes/approve-class", json=body)
    assert resp.status_code == 202
    assert resp.json() == reply


@pytest.mark.parametrize(
    "status,body",
    [
        (409, {"reason": "changed"}),
        (409, {"reason": "status"}),
        (401, {"detail": "operator token required"}),
    ],
)
def test_bridge_refusals_pass_through(status, body):
    client, patcher, _ = _client(lambda req: httpx.Response(status, json=body))
    with patcher:
        resp = client.post(
            f"/api/commerce/fixes/{_ID}/approve", json={"patch_sha256": _SHA}
        )
    assert resp.status_code == status
    assert resp.json() == body


def test_edit_forwards_changes_and_note():
    client, patcher, seen = _client(_queued)
    body = {
        "patch_sha256": _SHA,
        "changes": [
            {
                "field": "descriptionHtml",
                "after": "<p>A sample light rated at 1000 lm.</p>",
            }
        ],
        "note": "  tightened  ",
    }
    with patcher:
        resp = client.post(f"/api/commerce/fixes/{_ID}/edit", json=body)
    assert resp.status_code == 202
    assert json.loads(seen[0].content) == {**body, "note": "tightened"}


def test_edit_rejects_fields_outside_the_allowlist():
    client, patcher, seen = _client(_queued)
    with patcher:
        resp = client.post(
            f"/api/commerce/fixes/{_ID}/edit",
            json={"patch_sha256": _SHA, "changes": [{"field": "vendor", "after": "x"}]},
        )
    assert resp.status_code == 400
    assert seen == []


def test_edit_over_256kb_is_refused_locally():
    client, patcher, seen = _client(_queued)
    with patcher:
        resp = client.post(
            f"/api/commerce/fixes/{_ID}/edit",
            json={
                "patch_sha256": _SHA,
                "changes": [{"field": "title", "after": "x" * 270_000}],
            },
        )
    assert resp.status_code == 413
    assert seen == []


@pytest.mark.parametrize("action", ["reject", "revert"])
def test_reject_and_revert_send_only_the_note(action):
    client, patcher, seen = _client(_queued)
    with patcher:
        resp = client.post(f"/api/commerce/fixes/{_ID}/{action}", json={"note": "no"})
    assert resp.status_code == 202
    assert seen[0].url.path == f"/fixes/{_ID}/{action}"
    assert json.loads(seen[0].content) == {"note": "no"}


def test_reject_without_body_sends_empty_object():
    client, patcher, seen = _client(_queued)
    with patcher:
        resp = client.post(f"/api/commerce/fixes/{_ID}/reject")
    assert resp.status_code == 202
    assert json.loads(seen[0].content) == {}


def test_approve_class_lists_the_patches():
    reply = {
        "approved": [_ID],
        "refused": [{"id": "ba9876543210", "reason": "changed"}],
    }
    client, patcher, seen = _client(lambda req: httpx.Response(202, json=reply))
    body = {
        "store": "alpha",
        "rule": "4",
        "field": "descriptionHtml",
        "patches": [
            {"id": _ID, "patch_sha256": _SHA},
            {"id": "ba9876543210", "patch_sha256": "b" * 64},
        ],
    }
    with patcher:
        resp = client.post("/api/commerce/fixes/approve-class", json=body)
    assert resp.status_code == 202
    assert resp.json() == reply
    assert seen[0].url.path == "/fixes/approve-class"
    assert json.loads(seen[0].content) == body


def test_approve_class_caps_at_100():
    client, patcher, seen = _client(_queued)
    body = {
        "store": "alpha",
        "rule": "4",
        "field": "descriptionHtml",
        "patches": [{"id": f"{i:012x}", "patch_sha256": _SHA} for i in range(101)],
    }
    with patcher:
        resp = client.post("/api/commerce/fixes/approve-class", json=body)
    assert resp.status_code == 422
    assert seen == []


@pytest.mark.parametrize("action", ["pause", "resume"])
def test_pause_and_resume(action):
    client, patcher, seen = _client(
        lambda req: httpx.Response(202, json={"paused": action == "pause"})
    )
    with patcher:
        resp = client.post(f"/api/commerce/fixes/{action}")
    assert resp.status_code == 202
    assert seen[0].url.path == f"/fixes/{action}"
    assert seen[0].headers["X-Operator-Token"] == _TOKEN


@pytest.mark.parametrize(
    "path,body",
    [
        ("/api/commerce/fixes/NOT-AN-ID/approve", {"patch_sha256": _SHA}),
        (f"/api/commerce/fixes/{_ID}/approve", {"patch_sha256": "short"}),
        (f"/api/commerce/fixes/{_ID}/delete", {}),
    ],
)
def test_bad_ids_hashes_and_actions_never_reach_the_bridge(path, body):
    client, patcher, seen = _client(_queued)
    with patcher:
        resp = client.post(path, json=body)
    assert resp.status_code == 400
    assert seen == []


def test_missing_token_config_is_503_without_calling_the_bridge(monkeypatch):
    monkeypatch.setattr(fr, "get_tool_credential", lambda tool, key: None)
    client, patcher, seen = _client(_queued)
    with patcher:
        resp = client.post(
            f"/api/commerce/fixes/{_ID}/approve", json={"patch_sha256": _SHA}
        )
    assert resp.status_code == 503
    assert seen == []


def test_token_never_appears_in_any_response(_token):
    """Even when the bridge echoes nothing, no route ever returns the token."""
    replies = iter(
        [
            httpx.Response(202, json={"id": _ID, "action": "approve", "queued": True}),
            httpx.Response(401, json={"detail": "operator token required"}),
            httpx.Response(409, json={"reason": "changed"}),
            httpx.Response(500, text="boom"),
        ]
    )
    client, patcher, _ = _client(lambda req: next(replies))
    with patcher:
        for _ in range(4):
            resp = client.post(
                f"/api/commerce/fixes/{_ID}/approve", json={"patch_sha256": _SHA}
            )
            assert _TOKEN not in resp.text
            assert all(_TOKEN not in v for v in resp.headers.values())


def test_bridge_down_is_503():
    def down(req):
        raise httpx.ConnectError("refused", request=req)

    client, patcher, _ = _client(down)
    with patcher:
        resp = client.post(
            f"/api/commerce/fixes/{_ID}/approve", json={"patch_sha256": _SHA}
        )
    assert resp.status_code == 503


def test_catalog_fixes_feed_is_proxied():
    payload = {
        "feed": "catalog_fixes",
        "generated_at": "2026-10-02T06:00:00Z",
        "age_seconds": 60,
        "source_role": "ecom-seo",
        "data": {
            "run_at": "2026-10-02T06:00:00Z",
            "paused": False,
            "patches": [],
            "classes": [],
        },
    }
    client, patcher, seen = _client(lambda req: httpx.Response(200, json=payload))
    cr._cache.clear()
    with patcher:
        resp = client.get("/api/commerce/catalog_fixes")
    cr._cache.clear()
    assert resp.status_code == 200
    assert resp.json()["paused"] is False
    assert "X-Operator-Token" not in seen[0].headers
