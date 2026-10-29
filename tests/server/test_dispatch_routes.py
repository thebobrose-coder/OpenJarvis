"""Tests for POST /api/dispatch (the Dispatch action, hq 0023 D2). Invented
fixtures only: this repo is public. The bridge is mocked and the queue is a
temp folder; nothing reaches the real work-order queue."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

pytest.importorskip("fastapi", reason="openjarvis[server] not installed")
pytest.importorskip("jsonschema")

import jsonschema
from fastapi.responses import JSONResponse

from openjarvis.server import commerce_routes as cr
from openjarvis.server import dispatch_routes as dr
from openjarvis.server import waiting_routes as wr

SCHEMA = json.loads(
    (Path(__file__).parents[1] / "fixtures" / "work-order.schema.json").read_text(
        encoding="utf-8"
    )
)

REC = {
    "kind": "rec",
    "id": "abc123abc123",
    "source_feed": "ecom_recommendations",
    "scope": "store-a",
    "title": "Rewrite the sample collection page intro",
    "detail": "short action",
    "created_at": "2026-01-01T00:00:00Z",
    "due": None,
    "priority": 2,
    "link": {"page": "/commerce", "focus": "abc123abc123"},
    "lane": "delegate",
    "delegate": {"target": "workorder", "repo": "foundry", "scope": "edit"},
    "times_seen": 1,
    "last_seen": None,
}
PATCH_CLASS = {
    "kind": "patch_class",
    "id": "store-a:seo:foundry",
    "source_feed": "catalog_fixes",
    "scope": "store-a",
    "title": "3 invalid seo:foundry patches on store-a",
    "detail": "specs: seo.description: sample",
    "created_at": "2026-01-01T00:00:00Z",
    "due": None,
    "priority": None,
    "link": {"page": "/commerce#fixes", "focus": "def456def456"},
    "lane": "delegate",
    "delegate": {"target": "workorder", "repo": "foundry", "scope": "read-only"},
    "times_seen": None,
    "last_seen": None,
}
DESK = {
    **REC,
    "id": "fed987fed987",
    "delegate": {"target": "desk", "desk": "commerce"},
}
ACT = {**REC, "id": "aaa111aaa111", "lane": "act", "delegate": None}
LEDGER = {
    "open": [
        {
            "id": "abc123abc123",
            "category": "content",
            "detail": {
                "action": "Rewrite the intro in the sample voice.",
                "rationale": "The intro repeats the title.",
                "target": {"type": "page", "ref": "/collections/sample"},
            },
            "latest": None,
        }
    ]
}


@pytest.fixture
def queue(tmp_path: Path, monkeypatch):
    root = tmp_path / "workorders"
    for state in ("pending", "running", "done", "blocked"):
        (root / state).mkdir(parents=True)
    state = {"items": [REC, PATCH_CLASS, DESK, ACT], "decisions": [], "edit": False}

    async def index(_msg):
        return {"items": state["items"]}

    async def feed(name):
        assert name == "ecom_recommendations"
        return LEDGER

    async def decide(rec_id, decision, body=None):
        state["decisions"].append((rec_id, decision, body.note if body else None))
        return JSONResponse(status_code=202, content={"queued": True})

    monkeypatch.setattr(wr.approvals_panel, "get", index)
    monkeypatch.setattr(cr, "get_feed", feed)
    monkeypatch.setattr(cr, "decide", decide)
    monkeypatch.setattr(dr, "_data_dir", lambda: tmp_path)
    monkeypatch.setattr(dr, "edit_scope_allowed", lambda: state["edit"])
    state["root"] = root
    return state


def _client(host: str = "127.0.0.1"):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(dr.dispatch_router)
    return TestClient(app, client=(host, 50000))


def _pending(root: Path) -> list[Path]:
    return sorted((root / "pending").iterdir())


def test_a_delegate_rec_writes_a_schema_valid_operator_order(queue):
    r = _client().post("/api/dispatch", json=REC)
    assert r.status_code == 200, r.text
    body = r.json()
    files = _pending(queue["root"])
    assert [f.name for f in files] == [f"{body['order_id']}.json"]
    order = json.loads(files[0].read_text(encoding="utf-8"))
    jsonschema.validate(order, SCHEMA)
    assert order["issuedBy"] == "operator"
    assert order["planRef"] == "approvals:rec:abc123abc123"
    assert order["repo"] == "foundry" and order["priority"] == "normal"
    assert order["id"].startswith(f"wo-{datetime.now(timezone.utc):%Y%m%d}-")
    assert "The recommendation, as written by the ecom-seo model:" in order["goal"]
    assert "Rewrite the intro in the sample voice." in order["goal"]
    assert "The intro repeats the title." in order["goal"]
    assert order["acceptance"] == [dr.ACCEPTANCE[("rec", "read-only")]]
    assert "source_feed: ecom_recommendations" in order["context"]
    assert body["path"] == f"workorders/pending/{files[0].name}"
    # The rec is decided accepted with the order id in the note.
    assert queue["decisions"] == [
        ("abc123abc123", "accepted", f"dispatched {order['id']}")
    ]
    assert body["decided"] is True


def test_scope_is_clamped_while_edit_scope_is_off(queue):
    body = _client().post("/api/dispatch", json=REC).json()
    assert body["scope"] == "read-only"
    queue["edit"] = True
    for f in _pending(queue["root"]):
        f.unlink()
    body = _client().post("/api/dispatch", json=REC).json()
    assert body["scope"] == "edit"
    order = json.loads(_pending(queue["root"])[0].read_text(encoding="utf-8"))
    assert order["acceptance"] == [dr.ACCEPTANCE[("rec", "edit")]]


def test_a_patch_class_order_names_the_check_and_decides_nothing(queue):
    r = _client().post("/api/dispatch", json=PATCH_CLASS)
    assert r.status_code == 200, r.text
    order = json.loads(_pending(queue["root"])[0].read_text(encoding="utf-8"))
    jsonschema.validate(order, SCHEMA)
    assert order["planRef"] == "approvals:patch_class:store-a:seo:foundry"
    assert "specs: seo.description: sample" in order["goal"]
    assert "store-a" in order["goal"]
    assert order["acceptance"] == [dr.ACCEPTANCE[("patch_class", "read-only")]]
    assert queue["decisions"] == [] and r.json()["decided"] is None


def test_a_duplicate_plan_ref_is_409(queue):
    assert _client().post("/api/dispatch", json=PATCH_CLASS).status_code == 200
    r = _client().post("/api/dispatch", json=PATCH_CLASS)
    assert r.status_code == 409 and "Already dispatched" in r.json()["detail"]
    assert len(_pending(queue["root"])) == 1


def test_the_guard_reads_order_files_by_report_status(queue):
    root = queue["root"]
    order = {"id": "wo-20260101-sample-aaaaaa", "planRef": "approvals:rec:x"}

    def place(state, status, rejected=False):
        for f in (root / state).iterdir():
            f.unlink()
        name = order["id"] + (".rejected-1" if rejected else "")
        (root / state / f"{name}.json").write_text(json.dumps(order))
        if status:
            (root / state / f"{name}.report.json").write_text(
                json.dumps({"id": order["id"], "status": status})
            )

    place("running", None)
    assert dr.find_duplicate(root, "approvals:rec:x") == order["id"]
    for f in (root / "running").iterdir():
        f.unlink()
    place("done", "failed")
    assert dr.find_duplicate(root, "approvals:rec:x") is None
    place("done", "done")
    assert dr.find_duplicate(root, "approvals:rec:x") == order["id"]
    for f in (root / "done").iterdir():
        f.unlink()
    place("blocked", "blocked")
    assert dr.find_duplicate(root, "approvals:rec:x") is None
    place("done", "done", rejected=True)
    assert dr.find_duplicate(root, "approvals:rec:x") is None


def test_a_non_delegate_row_is_refused(queue):
    r = _client().post("/api/dispatch", json=ACT)
    assert r.status_code == 400
    assert _pending(queue["root"]) == []


def test_a_desk_target_writes_nothing(queue):
    r = _client().post("/api/dispatch", json=DESK)
    assert r.status_code == 400
    assert _pending(queue["root"]) == [] and queue["decisions"] == []


def test_a_row_no_longer_in_the_index_is_409(queue):
    queue["items"] = []
    assert _client().post("/api/dispatch", json=REC).status_code == 409
    assert _pending(queue["root"]) == []


def test_the_index_wins_over_the_request_body(queue):
    forged = {**PATCH_CLASS, "delegate": {"target": "workorder", "repo": "hq"}}
    _client().post("/api/dispatch", json=forged)
    order = json.loads(_pending(queue["root"])[0].read_text(encoding="utf-8"))
    assert order["repo"] == "foundry"


def test_write_is_atomic_and_never_overwrites(queue):
    root = queue["root"]
    order = {"id": "wo-20260101-sample-bbbbbb", "goal": "g"}
    path = dr.write_order(root, order)
    assert path.name == "wo-20260101-sample-bbbbbb.json"
    assert [f.name for f in _pending(root)] == [path.name]  # no temp left
    with pytest.raises(Exception) as exc:
        dr.write_order(root, {**order, "goal": "other"})
    assert getattr(exc.value, "status_code", None) == 409
    assert json.loads(path.read_text(encoding="utf-8"))["goal"] == "g"


def test_past_the_daily_cap_the_order_waits(queue):
    root = queue["root"]
    today = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    for n in range(dr.DAILY_CAP):
        (root / "done" / f"wo-20260101-ran-{n:06d}.report.json").write_text(
            json.dumps({"id": f"r{n}", "status": "done", "finishedAt": today})
        )
    body = _client().post("/api/dispatch", json=PATCH_CLASS).json()
    assert body["waits_for_tomorrow"] is True
    assert len(_pending(root)) == 1


def test_dispatch_is_loopback_only(queue):
    assert _client("10.0.0.5").post("/api/dispatch", json=REC).status_code == 403


def test_the_id_matches_hermes_form():
    now = datetime(2026, 1, 2, tzinfo=timezone.utc)
    oid = dr.new_id("Fix the Sample page, now!", now)
    assert oid.startswith("wo-20260102-fix-the-sample-page-now-")
    assert len(oid.rsplit("-", 1)[1]) == 6
