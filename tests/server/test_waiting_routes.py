"""Tests for /api/waiting and /api/decisions ("Waiting on you" and the
Decisions drawer, hq 0020 P1). Invented fixtures only: this repo is public.
The Hermes feeds are mocked; nothing reaches a bridge."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

pytest.importorskip("fastapi", reason="openjarvis[server] not installed")

from fastapi import HTTPException

from openjarvis.server import waiting_routes as wr

NOW = datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


BRIEF = (
    "# Sample brief\r\n"
    "\r\n"
    "Some context about the sample.\r\n"
    "- [ ] **D1. Keep the sample default** (why). Alternative: the other way.\r\n"
    "- [ ] **D2. Sample topic.** *Default:* the usual. *Alternative:* do less.\r\n"
    "- [x] **D3. Already chosen** Alternative: no. **DECIDED 2026-01-02** fine\r\n"
    "\r\n"
    "## Result\r\n"
    "\r\n"
)


def _approvals(**over) -> dict:
    doc = {
        "counts": {
            "total": 3,
            "proposal": 1,
            "thesis_prompt": 0,
            "patch": 1,
            "follow_up": 0,
            "rec": 1,
        },
        "sources": {"content_proposals": _iso(NOW), "catalog_fixes": None},
        "items": [
            {
                "kind": "proposal",
                "id": "p-1",
                "source_feed": "content_proposals",
                "scope": "prop-a",
                "title": "A sample proposal",
                "detail": None,
                "created_at": _iso(NOW),
                "due": None,
                "priority": 1,
                "link": {"page": "/content", "focus": "p-1"},
            },
            {
                "kind": "patch",
                "id": "abcdef123456",
                "source_feed": "catalog_fixes",
                "scope": "store-a",
                "title": "Sample product · title",
                "detail": "proposed: rule",
                "created_at": _iso(NOW),
                "due": None,
                "priority": None,
                "link": {"page": "/commerce#fixes", "focus": "abcdef123456"},
            },
            {
                "kind": "rec",
                "id": "r-9",
                "source_feed": "ecom_recommendations",
                "scope": "store-a",
                "title": "A sample rec",
                "detail": None,
                "created_at": _iso(NOW),
                "due": None,
                "priority": 2,
                "link": {"page": "/commerce", "focus": "r-9"},
            },
        ],
        "generated_at": _iso(NOW),
        "age_seconds": 30,
        "stale": False,
    }
    doc.update(over)
    return doc


def _trading(**over) -> dict:
    doc = {
        "generated_at": _iso(NOW),
        "age_seconds": 60,
        "stale": False,
        "written_at": _iso(NOW - timedelta(minutes=1)),
        "kill": {"local_file": False, "aws_flag": False},
        "heartbeat": {"last_ok": True, "alarm": "OK"},
        "sleeves": {
            "equities": {"halt_state": "NORMAL"},
            "crypto": {"halt_state": "NORMAL"},
        },
    }
    doc.update(over)
    return doc


@pytest.fixture
def data(tmp_path: Path) -> Path:
    inbox = tmp_path / "inbox" / "sample"
    inbox.mkdir(parents=True)
    (inbox / "brief.md").write_bytes(BRIEF.encode())
    (inbox / "done.md").write_text(
        "# Done brief\n\n## Result\n\nBuilt.\n", encoding="utf-8"
    )
    archive = tmp_path / "archive" / "sample"
    archive.mkdir(parents=True)
    (archive / "old.md").write_text(
        "# Old\n- [x] **D1. An old call** **DECIDED 2026-01-01 (app)**\n",
        encoding="utf-8",
    )
    return tmp_path


@pytest.fixture
def wired(monkeypatch, data):
    state = {"approvals": _approvals(), "trading": _trading(), "data": data}

    async def hermes():
        a = state["approvals"]
        return (a, None) if a else (None, "Hermes approvals feed unavailable")

    async def trading():
        t = state["trading"]
        return (t, None) if t else (None, "No data yet")

    monkeypatch.setattr(wr, "_hermes", hermes)
    monkeypatch.setattr(wr, "_trading", trading)
    monkeypatch.setattr(wr, "_data_dir", lambda: state["data"])

    async def no_g1():
        return None, None  # the G1 mirror has its own tests

    monkeypatch.setattr(wr, "_g1", no_g1)
    return state


def _client(host: str = "127.0.0.1"):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(wr.waiting_router)
    return TestClient(app, client=(host, 50000))


# ---------- the merged list ----------


def test_merge_counts_match_and_hermes_items_pass_through(wired):
    body = _client().get("/api/waiting").json()
    c = body["counts"]
    assert (c["proposal"], c["patch"], c["rec"]) == (1, 1, 1)
    assert c["decision"] == 2  # D1 and D2; D3 is ticked
    assert c["x402"] == 0 and c["g0"] == 0 and c["workorder"] == 0
    assert c["total"] == 5
    kinds = [i["kind"] for i in body["items"]]
    assert kinds.count("decision") == 2 and "proposal" in kinds
    assert body["sources"]["approvals"]["feeds"]["catalog_fixes"] is None


def test_hermes_counts_stay_uncapped(wired):
    wired["approvals"] = _approvals(counts={"total": 250, "rec": 250}, items=[])
    c = _client().get("/api/waiting").json()["counts"]
    assert c["rec"] == 250 and c["total"] == 252


def test_missing_sources_give_no_failure(wired):
    wired["approvals"] = None
    wired["trading"] = None
    wired["data"] = None
    body = _client().get("/api/waiting").json()
    assert body["counts"]["total"] == 0 and body["items"] == []
    assert body["sources"]["approvals"]["error"]
    assert body["sources"]["trading_status"]["error"]
    assert body["local"] is False


def test_missing_local_folders_give_no_failure(wired, tmp_path):
    wired["data"] = tmp_path / "nothing-here"
    body = _client().get("/api/waiting").json()
    assert body["counts"]["decision"] == 0 and body["counts"]["total"] == 3


def test_x402_rows_for_kill_heartbeat_and_stale(wired):
    wired["trading"] = _trading(
        sleeves={
            "crypto": {"halt_state": "KILL"},
            "equities": {"halt_state": "NORMAL"},
        },
        heartbeat={"last_ok": True, "alarm": "ALARM"},
        written_at=_iso(NOW - timedelta(minutes=40)),
    )
    rows = [
        i for i in _client().get("/api/waiting").json()["items"] if i["kind"] == "x402"
    ]
    assert [r["id"] for r in rows] == ["kill-crypto", "heartbeat", "stale"]
    assert all(r["link"] == {"page": "/trading", "focus": None} for r in rows)


def test_x402_quiet_when_normal():
    assert wr.x402_items(_trading(), NOW) == []
    assert wr.x402_items(None, NOW) == []


def test_g0_rows_from_studio_manifests(wired, data):
    ep = data / "studio" / "prop-a" / "EP1"
    ep.mkdir(parents=True)
    (ep / "manifest.json").write_text(
        json.dumps(
            {
                "episodeId": "EP1",
                "propertyId": "prop-a",
                "stage": "awaiting-g0",
                "title": "Sample episode",
                "stages": [
                    {"stage": "scripted", "at": _iso(NOW)},
                    {"stage": "awaiting-g0", "at": _iso(NOW)},
                ],
            }
        )
    )
    other = data / "studio" / "prop-a" / "EP2"
    other.mkdir(parents=True)
    (other / "manifest.json").write_text(
        json.dumps({"episodeId": "EP2", "stage": "narrating"})
    )
    body = _client().get("/api/waiting").json()
    rows = [i for i in body["items"] if i["kind"] == "g0"]
    assert [r["id"] for r in rows] == ["EP1"]
    assert rows[0]["link"] == {"page": "/content", "focus": "EP1"}
    assert body["sources"]["studio"]["age_seconds"] is not None


def test_workorders_blocked_and_failed_within_a_week(wired, data):
    for folder, name, status, days in (
        ("blocked", "wo-1", "blocked", 1),
        ("done", "wo-2", "failed", 2),
        ("done", "wo-3", "done", 1),
        ("done", "wo-4", "failed", 30),
    ):
        d = data / "workorders" / folder
        d.mkdir(parents=True, exist_ok=True)
        (d / f"{name}.report.json").write_text(
            json.dumps(
                {
                    "id": name,
                    "status": status,
                    "dispatchedAt": _iso(NOW),
                    "reason": "sample",
                    "finishedAt": _iso(NOW - timedelta(days=days)),
                    "claude": {
                        "status": status,
                        "summary": "s",
                        "needsHuman": "please look",
                    },
                }
            )
        )
    rows = [
        i
        for i in _client().get("/api/waiting").json()["items"]
        if i["kind"] == "workorder"
    ]
    assert sorted(r["id"] for r in rows) == ["wo-1", "wo-2"]
    assert all(r["detail"] == "please look" for r in rows)


def test_routes_are_loopback_only(wired):
    c = _client("10.0.0.5")
    assert c.get("/api/waiting").status_code == 403
    assert c.get("/api/decisions").status_code == 403
    assert (
        c.post(
            "/api/decisions/tick", json={"file": "x", "line": 1, "hash": "h"}
        ).status_code
        == 403
    )


# ---------- decisions ----------


def test_decisions_list_boxes_defaults_and_paragraph(wired):
    body = _client().get("/api/decisions").json()
    d1, d2 = body["open"]
    assert (d1["number"], d1["default"], d1["alternative"]) == (
        1,
        "Keep the sample default",
        "the other way",
    )
    assert (d2["decision"], d2["default"], d2["alternative"]) == (
        "Sample topic",
        "the usual",
        "do less",
    )
    assert d1["file"] == "sample/brief.md" and d1["line"] == 4
    assert "Some context" in d1["paragraph"] and "D2" not in d1["paragraph"]
    assert d1["title"] == "Sample brief"
    assert [w["file"] for w in body["waiting_briefs"]] == ["sample/brief.md"]
    decided = {(r["file"], r["archived"]) for r in body["recently_decided"]}
    assert decided == {("sample/brief.md", False), ("sample/old.md", True)}


def _tick(file="sample/brief.md", line=4, h=None, note="", data=None):
    raw = (data / "inbox" / file).read_bytes() if data and h is None else b""
    return {
        "file": file,
        "line": line,
        "hash": h or hashlib.sha256(raw).hexdigest(),
        "note": note,
    }


def test_tick_writes_the_a5_form_and_keeps_crlf(wired, data, monkeypatch):
    r = _client().post("/api/decisions/tick", json=_tick(note="go with it", data=data))
    assert r.status_code == 200, r.text
    raw = (data / "inbox" / "sample" / "brief.md").read_bytes()
    line = raw.split(b"\r\n")[3].decode()
    today = datetime.now().astimezone().strftime("%Y-%m-%d")
    assert line == (
        "- [x] **D1. Keep the sample default** (why). Alternative: the other way."
        f" **DECIDED {today} (app)** go with it"
    )
    assert raw.count(b"\r\n") == BRIEF.count("\r\n") and b"\n" not in raw.replace(
        b"\r\n", b""
    )
    # everything else is byte-for-byte the same
    assert raw.split(b"\r\n")[:3] == BRIEF.encode().split(b"\r\n")[:3]
    assert raw.split(b"\r\n")[4:] == BRIEF.encode().split(b"\r\n")[4:]
    assert r.json()["hash"] == hashlib.sha256(raw).hexdigest()


def test_tick_without_note(wired, data):
    _client().post("/api/decisions/tick", json=_tick(line=5, data=data))
    line = (
        (data / "inbox" / "sample" / "brief.md").read_bytes().split(b"\r\n")[4].decode()
    )
    assert line.startswith("- [x] **D2.") and line.endswith("(app)**")


def test_tick_refuses_already_ticked(wired, data):
    r = _client().post("/api/decisions/tick", json=_tick(line=6, data=data))
    assert r.status_code == 409 and "Already" in r.json()["detail"]


def test_tick_refuses_a_changed_file(wired, data):
    r = _client().post("/api/decisions/tick", json=_tick(h="0" * 64))
    assert r.status_code == 409
    assert b"[x] **D1" not in (data / "inbox" / "sample" / "brief.md").read_bytes()


def test_tick_refuses_a_line_that_is_not_a_box(wired, data):
    assert (
        _client().post("/api/decisions/tick", json=_tick(line=1, data=data)).status_code
        == 409
    )


@pytest.mark.parametrize(
    "file",
    [
        "../archive/sample/old.md",
        "sample/../../archive/sample/old.md",
        "sample/brief.txt",
        "brief.md",
        "C:/x/brief.md",
    ],
)
def test_tick_refuses_paths_outside_the_inbox(wired, file):
    r = _client().post(
        "/api/decisions/tick", json={"file": file, "line": 1, "hash": "0" * 64}
    )
    assert r.status_code == 400


def test_tick_refuses_a_multiline_or_long_note(wired, data):
    for note in ("two\nlines", "x" * 501):
        assert (
            _client()
            .post("/api/decisions/tick", json=_tick(note=note, data=data))
            .status_code
            == 400
        )


def test_tick_line_keeps_its_ending():
    assert (
        wr.tick_line("- [ ] **D9. X** y\n", "2026-01-01", "")
        == "- [x] **D9. X** y **DECIDED 2026-01-01 (app)**\n"
    )
    with pytest.raises(ValueError):
        wr.tick_line("- [x] **D9. X** y\n", "2026-01-01", "")


def test_tick_box_without_config_is_404(monkeypatch):
    monkeypatch.setattr(wr, "_data_dir", lambda: None)
    r = _client().post(
        "/api/decisions/tick", json={"file": "a/b.md", "line": 1, "hash": "h"}
    )
    assert r.status_code == 404
    with pytest.raises(HTTPException):
        wr.tick_box(Path("."), "a/../b.md", 1, "h", "", "2026-01-01")


# ---------- lanes (hq 0023, v1.22) ----------


def _laned() -> dict:
    """A v1.22 index: lanes on every item, lane counts, a patch_class row."""
    a = _approvals()
    a["counts"].update(
        {"total": 6, "act": 2, "delegate": 2, "fyi": 2, "patch_class": 1}
    )
    a["items"][0].update(lane="act", delegate=None)
    a["items"][2].update(
        lane="delegate",
        delegate={"target": "desk", "desk": "commerce"},
        times_seen=3,
        last_seen=_iso(NOW),
    )
    a["items"][1].update(lane="act", delegate=None)
    a["items"].append(
        {
            "kind": "patch_class",
            "id": "store-a:seo:foundry",
            "source_feed": "catalog_fixes",
            "scope": "store-a",
            "title": "3 invalid seo:foundry patches on store-a",
            "detail": "specs: seo.description: sample",
            "created_at": _iso(NOW),
            "due": None,
            "priority": None,
            "link": {"page": "/commerce#fixes", "focus": "abcdef654321"},
            "lane": "delegate",
            "delegate": {
                "target": "workorder",
                "repo": "foundry",
                "scope": "read-only",
            },
            "times_seen": None,
            "last_seen": None,
        }
    )
    return a


def test_local_kinds_lane_table():
    assert wr.LOCAL_LANES == {
        "g0": "act",
        "g1": "act",
        "decision": "act",
        "x402": "act",
    }
    assert wr.WORKORDER_LANES == {
        "blocked": "act",
        "rejected": "act",
        "failed": "act",
        "done": "fyi",
    }


def test_lane_counts_add_the_local_rows(wired):
    wired["approvals"] = _laned()
    body = _client().get("/api/waiting").json()
    c = body["counts"]
    # Hermes's act 2 plus the two open decision boxes.
    assert (c["act"], c["delegate"], c["fyi"]) == (4, 2, 2)
    assert c["patch_class"] == 1
    assert c["total"] == 6 + 2
    rec = next(i for i in body["items"] if i["kind"] == "rec")
    assert rec["lane"] == "delegate" and rec["times_seen"] == 3
    assert rec["delegate"] == {"target": "desk", "desk": "commerce"}
    assert all(i["lane"] == "act" for i in body["items"] if i["kind"] == "decision")


def test_an_older_feed_without_lanes_is_act(wired):
    body = _client().get("/api/waiting").json()
    c = body["counts"]
    assert (c["act"], c["delegate"], c["fyi"]) == (3 + 2, 0, 0)
    hermes = [i for i in body["items"] if i["source_feed"] != "inbox"]
    assert all(i["lane"] == "act" and i["delegate"] is None for i in hermes)
    assert all(i["times_seen"] is None for i in hermes)


def _report(data: Path, folder: str, name: str, status: str, days: float = 1):
    d = data / "workorders" / folder
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{name}.report.json").write_text(
        json.dumps(
            {
                "id": name,
                "status": status,
                "dispatchedAt": _iso(NOW),
                "finishedAt": _iso(NOW - timedelta(days=days)),
                "repo": "hermes",
                "scope": "read-only",
                "branch": None,
                "costUsd": 0.42,
                "claude": {"status": status, "summary": f"summary of {name}"},
            }
        )
    )


def test_done_reports_are_counted_as_fyi_and_not_listed(wired, data):
    _report(data, "done", "wo-a", "done")
    _report(data, "done", "wo-b", "done")
    _report(data, "done", "wo-c", "failed")
    _report(data, "blocked", "wo-d", "rejected")
    _report(data, "done", "wo-old", "done", days=30)
    body = _client().get("/api/waiting").json()
    rows = [i for i in body["items"] if i["kind"] == "workorder"]
    assert sorted(r["id"] for r in rows) == ["wo-c", "wo-d"]
    assert all(r["lane"] == "act" and r["opens"] == "workorder" for r in rows)
    c = body["counts"]
    assert c["workorder"] == 2 and c["workorder_done"] == 2
    assert c["fyi"] == 2 and c["act"] == 3 + 2 + 2


def test_reports_route_is_read_only_and_recent(wired, data):
    _report(data, "done", "wo-a", "done")
    _report(data, "blocked", "wo-d", "blocked", days=2)
    _report(data, "done", "wo-old", "done", days=30)
    body = _client().get("/api/workorders/reports").json()
    assert [r["id"] for r in body["reports"]] == ["wo-a", "wo-d"]
    first = body["reports"][0]
    assert first["summary"] == "summary of wo-a" and first["costUsd"] == 0.42
    assert _client("10.0.0.5").get("/api/workorders/reports").status_code == 403


# ---------- the local chat header (0023 D8) ----------


@pytest.fixture
def real_header(monkeypatch):
    """Undo the suite-wide stub (tests/conftest.py) and the 60 s cache."""
    monkeypatch.setattr(wr, "waiting_header", REAL_HEADER)
    wr._header_cache.update(at=0.0, text=None)
    yield
    wr._header_cache.update(at=0.0, text=None)


REAL_HEADER = wr.waiting_header


def test_header_counts_top_titles_stale_and_manifest(wired):
    wired["approvals"] = _laned()
    wired["approvals"]["stale"] = True
    import asyncio

    text = wr.format_header(asyncio.run(wr.build_waiting()))
    assert len(text) <= wr.HEADER_MAX
    assert "For you: 4; dispatchable: 2; filed: 2." in text
    assert "- proposal: A sample proposal" in text
    assert "A sample rec" not in text  # a delegate row, not act
    assert "Source approvals: stale." in text
    assert text.endswith(wr.MANIFEST)


def test_header_stays_under_the_cap():
    items = [
        {"kind": "rec", "lane": "act", "title": "x" * 300, "created_at": None}
    ] * 10
    sources = {f"source-{n}-" + "y" * 40: {"error": "down"} for n in range(30)}
    text = wr.format_header({"counts": {"act": 10}, "items": items, "sources": sources})
    assert len(text) <= wr.HEADER_MAX and text.endswith(wr.MANIFEST)


def test_header_is_the_manifest_alone_when_the_list_fails(monkeypatch, real_header):
    import asyncio

    async def boom():
        raise RuntimeError("down")

    monkeypatch.setattr(wr, "build_waiting", boom)
    text = asyncio.run(wr.waiting_header())
    assert wr.MANIFEST in text and "For you" not in text
