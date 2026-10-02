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


def test_confirm_sends_the_displayed_hash_with_the_token():
    client, patcher, seen = _client(_queued)
    with patcher:
        resp = client.post(
            f"/api/commerce/fixes/{_ID}/confirm", json={"patch_sha256": _SHA}
        )
    assert resp.status_code == 202
    assert seen[0].url.path == f"/fixes/{_ID}/confirm"
    assert seen[0].headers["X-Operator-Token"] == _TOKEN
    assert json.loads(seen[0].content) == {"patch_sha256": _SHA}


def test_confirm_class_lists_the_patches_and_passes_refusals_through():
    reply = {"confirmed": [], "refused": [{"id": _ID, "reason": "spot_check"}]}
    client, patcher, seen = _client(lambda req: httpx.Response(202, json=reply))
    body = {
        "store": "alpha",
        "rule": "4",
        "field": "descriptionHtml",
        "patches": [{"id": _ID, "patch_sha256": _SHA}],
    }
    with patcher:
        resp = client.post("/api/commerce/fixes/confirm-class", json=body)
    assert resp.status_code == 202
    assert resp.json() == reply
    assert seen[0].url.path == "/fixes/confirm-class"
    assert seen[0].headers["X-Operator-Token"] == _TOKEN
    assert json.loads(seen[0].content) == body


@pytest.mark.parametrize(
    "path,body",
    [
        (f"/api/commerce/fixes/{_ID}/confirm", {"patch_sha256": _SHA}),
        (
            "/api/commerce/fixes/confirm-class",
            {
                "store": "alpha",
                "rule": "4",
                "field": "descriptionHtml",
                "patches": [{"id": _ID, "patch_sha256": _SHA}],
            },
        ),
    ],
)
def test_confirm_not_live_passes_through(path, body):
    client, patcher, _ = _client(
        lambda req: httpx.Response(409, json={"reason": "not_live"})
    )
    with patcher:
        resp = client.post(path, json=body)
    assert resp.status_code == 409
    assert resp.json() == {"reason": "not_live"}


def test_bad_confirm_never_reaches_the_bridge():
    client, patcher, seen = _client(_queued)
    with patcher:
        bad_id = client.post(
            "/api/commerce/fixes/nothex/confirm", json={"patch_sha256": _SHA}
        )
        bad_sha = client.post(
            f"/api/commerce/fixes/{_ID}/confirm", json={"patch_sha256": "x"}
        )
    assert bad_id.status_code == 400 and bad_sha.status_code == 400
    assert seen == []


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


def test_withdrawing_a_confirm_patch_is_a_reject_with_the_token():
    """v1.3.4: Reject is accepted on a `confirm` patch; the proxy is the same."""
    client, patcher, seen = _client(_queued)
    with patcher:
        resp = client.post(
            f"/api/commerce/fixes/{_ID}/reject", json={"note": "withdraw"}
        )
    assert resp.status_code == 202
    assert seen[0].url.path == f"/fixes/{_ID}/reject"
    assert seen[0].headers["X-Operator-Token"] == _TOKEN
    assert json.loads(seen[0].content) == {"note": "withdraw"}


# -- the tier control (v1.4): the policy file, never the bridge ---------------

_RULES = "b" * 64
_CLASS = {"store": "store-a", "rule": "4", "field": "descriptionHtml"}


@pytest.fixture
def policy(tmp_path, monkeypatch, _token):
    path = tmp_path / "policy" / "autofix-policy.json"
    keys = {fr.TOKEN_KEY: str(_token), fr.POLICY_KEY: str(path)}
    monkeypatch.setattr(fr, "get_tool_credential", lambda tool, key: keys.get(key))
    return path


def _feed(**cls):
    klass = {**_CLASS, "eligible": True, "rules_sha256": _RULES, **cls}
    return {
        "feed": "catalog_fixes",
        "generated_at": "2026-10-02T06:00:00Z",
        "data": {"patches": [], "classes": [klass]},
    }


def _local(handler, host="127.0.0.1"):
    client, patcher, seen = _client(handler)
    from fastapi.testclient import TestClient

    return TestClient(client.app, client=(host, 50000)), patcher, seen


def _raise(**extra):
    return {**_CLASS, "tier": 1, "rules_sha256": _RULES, **extra}


def test_raise_writes_the_v14_shape_and_never_posts_to_hermes(policy):
    client, patcher, seen = _local(lambda req: httpx.Response(200, json=_feed()))
    with patcher:
        resp = client.post("/api/commerce/fixes/policy", json=_raise(note="earned"))
    assert resp.status_code == 200
    doc = json.loads(policy.read_text(encoding="utf-8"))
    assert set(doc) == {"version", "updated_at", "classes"}
    assert doc["version"] == 1
    (entry,) = doc["classes"]
    assert entry == {
        **_CLASS,
        "tier": 1,
        "since": doc["updated_at"],
        "rules_sha256": _RULES,
        "note": "earned",
    }
    # Only a read of the feed; nothing is sent to Hermes.
    assert [(r.method, r.url.path) for r in seen] == [("GET", "/panels/catalog_fixes")]
    assert "X-Operator-Token" not in seen[0].headers
    # Atomic: no temp file left behind.
    assert [p.name for p in policy.parent.iterdir()] == [policy.name]
    assert resp.json()["classes"] == doc["classes"]


def test_raise_keeps_other_classes_and_replaces_a_demoted_entry(policy):
    other = {
        **_CLASS,
        "store": "store-b",
        "tier": 1,
        "since": "x",
        "rules_sha256": _RULES,
    }
    old = {**_CLASS, "tier": 1, "since": "2026-10-01T00:00:00Z", "rules_sha256": _RULES}
    policy.parent.mkdir()
    policy.write_text(
        json.dumps({"version": 1, "updated_at": "u", "classes": [other, old]}),
        encoding="utf-8",
    )
    client, patcher, _ = _local(lambda req: httpx.Response(200, json=_feed()))
    with patcher:
        assert (
            client.post("/api/commerce/fixes/policy", json=_raise()).status_code == 200
        )
    classes = json.loads(policy.read_text(encoding="utf-8"))["classes"]
    assert classes[0] == other
    assert len(classes) == 2 and classes[1]["since"] != old["since"]


@pytest.mark.parametrize(
    "feed, body, reason",
    [
        (_feed(eligible=False), _raise(), "not_eligible"),
        (_feed(rules_sha256="c" * 64), _raise(), "changed"),
        (_feed(), _raise(rules_sha256=None), "changed"),
        (_feed(rules_sha256=None), _raise(), "no_rules_hash"),
        (_feed(store="store-z"), _raise(), "unknown"),
    ],
)
def test_raise_is_refused_unless_the_feed_vouches_for_it(policy, feed, body, reason):
    client, patcher, _ = _local(lambda req: httpx.Response(200, json=feed))
    with patcher:
        resp = client.post("/api/commerce/fixes/policy", json=body)
    assert resp.status_code == 409
    assert resp.json()["detail"] == {"reason": reason}
    assert not policy.exists()


def test_raise_with_the_bridge_down_is_503_and_writes_nothing(policy):
    def down(req):
        raise httpx.ConnectError("refused", request=req)

    client, patcher, _ = _local(down)
    with patcher:
        resp = client.post("/api/commerce/fixes/policy", json=_raise())
    assert resp.status_code == 503
    assert not policy.exists()


def test_turn_off_removes_the_class_without_the_feed(policy):
    other = {
        **_CLASS,
        "store": "store-b",
        "tier": 1,
        "since": "x",
        "rules_sha256": _RULES,
    }
    mine = {**_CLASS, "tier": 1, "since": "y", "rules_sha256": _RULES}
    policy.parent.mkdir()
    policy.write_text(
        json.dumps({"version": 1, "updated_at": "u", "classes": [other, mine]}),
        encoding="utf-8",
    )
    # Not eligible, and the bridge isn't consulted at all.
    client, patcher, seen = _local(lambda req: httpx.Response(500))
    with patcher:
        resp = client.post("/api/commerce/fixes/policy", json={**_CLASS, "tier": 0})
    assert resp.status_code == 200
    doc = json.loads(policy.read_text(encoding="utf-8"))
    assert doc["classes"] == [other]
    assert doc["updated_at"] != "u"
    assert seen == []


def test_turn_off_with_no_file_creates_none(policy):
    client, patcher, seen = _local(lambda req: httpx.Response(500))
    with patcher:
        resp = client.post("/api/commerce/fixes/policy", json={**_CLASS, "tier": 0})
    assert resp.status_code == 200
    assert resp.json() == {"exists": False, "updated_at": None, "classes": []}
    assert not policy.exists() and seen == []


def test_an_unreadable_policy_is_refused_not_overwritten(policy):
    policy.parent.mkdir()
    policy.write_text("{not json", encoding="utf-8")
    client, patcher, _ = _local(lambda req: httpx.Response(200, json=_feed()))
    with patcher:
        resp = client.post("/api/commerce/fixes/policy", json=_raise())
        got = client.get("/api/commerce/fixes/policy")
    assert resp.status_code == 409 and got.status_code == 409
    assert policy.read_text(encoding="utf-8") == "{not json"


def test_get_policy_reads_the_file(policy):
    client, patcher, _ = _local(lambda req: httpx.Response(500))
    with patcher:
        assert client.get("/api/commerce/fixes/policy").json()["exists"] is False
    policy.parent.mkdir()
    policy.write_text(
        json.dumps({"version": 1, "updated_at": "2026-10-03T00:00:00Z", "classes": []}),
        encoding="utf-8",
    )
    with patcher:
        body = client.get("/api/commerce/fixes/policy").json()
    assert body == {"exists": True, "updated_at": "2026-10-03T00:00:00Z", "classes": []}


@pytest.mark.parametrize("method", ["get", "post"])
def test_policy_is_refused_off_this_machine(policy, method):
    client, patcher, seen = _local(
        lambda req: httpx.Response(200, json=_feed()), host="192.168.1.20"
    )
    with patcher:
        if method == "get":
            resp = client.get("/api/commerce/fixes/policy")
        else:
            resp = client.post("/api/commerce/fixes/policy", json=_raise())
    assert resp.status_code == 403
    assert not policy.exists() and seen == []


def test_policy_not_configured_is_503(monkeypatch, _token):
    monkeypatch.setattr(
        fr,
        "get_tool_credential",
        lambda tool, key: str(_token) if key == fr.TOKEN_KEY else None,
    )
    client, patcher, _ = _local(lambda req: httpx.Response(200, json=_feed()))
    with patcher:
        resp = client.post("/api/commerce/fixes/policy", json=_raise())
    assert resp.status_code == 503
