"""Tests for /api/stack (the sidebar's stack-health dock, hq 0017 A2) and its
local speech feed. Invented fixture files only: this repo is public."""

from __future__ import annotations

import json
import subprocess
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest

pytest.importorskip("fastapi", reason="openjarvis[server] not installed")

import httpx

from openjarvis.server import stack_routes as sr
from openjarvis.server import voice_routes as vr
from openjarvis.voice_worker.core import AudioCache

NOW = datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _result(area, check, status, evidence="all good"):
    return {"area": area, "check": check, "status": status, "evidence": evidence}


def _health(hours_ago: float = 1, results=None, counts=None) -> dict:
    results = (
        results
        if results is not None
        else [
            _result("local", "disk", "OK"),
            _result("local", "backup", "OK"),
            _result("cloud", "relay", "SKIP", "not configured"),
        ]
    )
    doc = {
        "version": 1,
        "ran_at": _iso(NOW - timedelta(hours=hours_ago)),
        "duration_ms": 12345,
        "fetch": "ok",
        "results": results,
    }
    if counts is not None:
        doc["counts"] = counts
    return doc


def _event(days_ago: float, **over) -> dict:
    t = _iso(NOW - timedelta(days=days_ago))
    return {
        "arn": "arn:example:event/1",
        "service": "EC2",
        "eventTypeCode": "AWS_EC2_OPERATIONAL_ISSUE",
        "eventTypeCategory": "issue",
        "statusCode": "open",
        "startTime": t,
        "endTime": None,
        "lastUpdatedTime": t,
        "region": "us-east-1",
        "account": "sample-prod",
        "description": "First line of the event.\nSecond line with detail.",
        **over,
    }


@pytest.fixture
def files(tmp_path, monkeypatch):
    paths = {
        sr.HEALTH_KEY: tmp_path / "stack-health.json",
        sr.EVENTS_KEY: tmp_path / "events.json",
    }
    config = {k: str(v) for k, v in paths.items()}
    monkeypatch.setattr(sr, "get_tool_credential", lambda tool, key: config.get(key))
    return paths, config


def _write(path, doc):
    path.write_text(json.dumps(doc), encoding="utf-8")


def _client(host="127.0.0.1", *routers):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    for r in routers or (sr.stack_router,):
        app.include_router(r)
    return TestClient(app, client=(host, 50000))


# -- GET /api/stack/health ---------------------------------------------------


def test_green_file_summarises_counts_and_lists_nothing(files):
    paths, _ = files
    _write(paths[sr.HEALTH_KEY], _health())
    body = _client().get("/api/stack/health").json()
    assert body["counts"] == {"OK": 2, "WARN": 0, "FAIL": 0, "SKIP": 1}
    assert body["failing"] == [] and body["warning"] == []
    assert body["skipped"] == 1 and body["stale"] is False
    assert 3500 <= body["age_seconds"] <= 3700
    assert body["cloud_events"] == [] and body["duration_ms"] == 12345


def test_fail_and_warn_rows_carry_the_full_evidence(files):
    paths, _ = files
    long = "x" * 900
    _write(
        paths[sr.HEALTH_KEY],
        _health(
            results=[
                _result("local", "disk", "WARN", "disk at 91 %"),
                _result("web", "site-a", "FAIL", long),
                _result("local", "backup", "OK"),
            ],
            counts={"OK": 1, "WARN": 1, "FAIL": 1, "SKIP": 0},
        ),
    )
    body = _client().get("/api/stack/health").json()
    assert body["failing"] == [
        {"area": "web", "check": "site-a", "status": "FAIL", "evidence": long}
    ]
    assert body["warning"][0]["evidence"] == "disk at 91 %"
    assert body["counts"]["FAIL"] == 1


def test_an_old_run_is_stale(files):
    paths, _ = files
    _write(paths[sr.HEALTH_KEY], _health(hours_ago=9))
    body = _client().get("/api/stack/health").json()
    assert body["stale"] is True and body["age_seconds"] >= 9 * 3600 - 5


def test_missing_or_unconfigured_file_is_404(files, monkeypatch):
    resp = _client().get("/api/stack/health")
    assert resp.status_code == 404 and resp.json()["detail"] == sr.NO_RUN
    monkeypatch.setattr(sr, "get_tool_credential", lambda tool, key: None)
    assert _client().get("/api/stack/health").status_code == 404


def test_unparsable_file_is_503_naming_the_file_not_the_content(files):
    paths, _ = files
    paths[sr.HEALTH_KEY].write_text("{secret-ish content", encoding="utf-8")
    resp = _client().get("/api/stack/health")
    assert resp.status_code == 503
    assert resp.json()["detail"] == "stack-health.json could not be read"
    assert "secret" not in resp.text
    _write(paths[sr.HEALTH_KEY], {"version": 1})  # no results list
    assert _client().get("/api/stack/health").status_code == 503


def test_cloud_events_are_open_within_their_window_newest_first(files):
    paths, _ = files
    _write(paths[sr.HEALTH_KEY], _health())
    events = [
        _event(2, service="S3"),
        _event(0.5, service="EC2"),
        _event(1, statusCode="closed", service="closed-one"),
        _event(40, eventTypeCategory="scheduledChange", service="old-notice"),
        _event(20, eventTypeCategory="scheduledChange", service="notice"),
        _event(
            20,
            eventTypeCode="GOOGLE_NOTICE",
            eventTypeCategory="accountNotification",
            service="old-google",
        ),
        _event(60, service="old-issue"),  # an open issue has no window
        _event(1, statusCode="upcoming", service="upcoming-one"),
    ]
    doc = {"version": 1, "updated_at": _iso(NOW), "events": events}
    _write(paths[sr.EVENTS_KEY], doc)
    body = _client().get("/api/stack/health").json()
    services = [e["service"] for e in body["cloud_events"]]
    assert services == ["EC2", "upcoming-one", "S3", "notice", "old-issue"]
    first = body["cloud_events"][0]
    assert first["alias"] == "sample-prod" and first["category"] == "issue"
    assert first["description_first_line"] == "First line of the event."
    assert "Second line" in first["description"]


def test_a_broken_events_file_never_hides_the_local_checks(files):
    paths, _ = files
    _write(paths[sr.HEALTH_KEY], _health())
    paths[sr.EVENTS_KEY].write_text("not json", encoding="utf-8")
    body = _client().get("/api/stack/health").json()
    assert body["cloud_events"] == []
    assert body["cloud_error"] == "events.json could not be read"


def test_speech_block_reads_the_counts_and_names(files):
    paths, _ = files
    _write(
        paths[sr.HEALTH_KEY],
        _health(
            results=[
                _result("local", "disk", "WARN"),
                _result("web", "site-a", "FAIL"),
                _result("local", "backup", "OK"),
            ]
        ),
    )
    block = _client().get("/api/stack/health").json()["speech"][0]
    assert vr.valid_id(block["id"])
    text = block["text"]
    assert text.startswith("Stack health at ")
    assert "1 OK, 1 warning, 1 failure." in text
    assert "Warnings: local disk." in text and "Failures: web site-a." in text


def test_non_loopback_requests_are_403(files):
    paths, _ = files
    _write(paths[sr.HEALTH_KEY], _health())
    remote = _client("192.168.1.20")
    assert remote.get("/api/stack/health").status_code == 403
    assert remote.post("/api/stack/health/run").status_code == 403


# -- POST /api/stack/health/run ------------------------------------------------


@pytest.fixture
def task(monkeypatch):
    config = {sr.TASK_KEY: r"\Sample\StackHealth"}
    monkeypatch.setattr(sr, "get_tool_credential", lambda tool, key: config.get(key))
    monkeypatch.setattr(sr.sys, "platform", "win32")
    return config


def test_run_starts_the_scheduled_task(task):
    calls = []

    def fake_run(args, **kwargs):
        calls.append((args, kwargs))
        return subprocess.CompletedProcess(args, 0, stdout="SUCCESS", stderr="")

    with patch.object(sr.subprocess, "run", side_effect=fake_run):
        resp = _client().post("/api/stack/health/run")
    assert resp.status_code == 202 and resp.json() == {"started": True}
    assert calls[0][0] == ["schtasks", "/Run", "/TN", r"\Sample\StackHealth"]
    assert calls[0][1]["timeout"] == 10


def test_run_failure_is_503_with_the_first_stderr_line(task):
    failed = subprocess.CompletedProcess(
        [], 1, stdout="", stderr="  ERROR: The system cannot find the file.  \nmore\n"
    )
    with patch.object(sr.subprocess, "run", return_value=failed):
        resp = _client().post("/api/stack/health/run")
    assert resp.status_code == 503
    assert resp.json()["detail"] == "ERROR: The system cannot find the file."


def test_run_timeout_is_503(task):
    with patch.object(
        sr.subprocess, "run", side_effect=subprocess.TimeoutExpired("schtasks", 10)
    ):
        assert _client().post("/api/stack/health/run").status_code == 503


def test_run_without_a_configured_task_is_503(task):
    task.clear()
    with patch.object(sr.subprocess, "run") as run:
        assert _client().post("/api/stack/health/run").status_code == 503
    run.assert_not_called()


def test_run_elsewhere_than_windows_is_501(task, monkeypatch):
    monkeypatch.setattr(sr.sys, "platform", "linux")
    with patch.object(sr.subprocess, "run") as run:
        assert _client().post("/api/stack/health/run").status_code == 501
    run.assert_not_called()


# -- the local speech feed (voice routes) ----------------------------------


def test_prepare_renders_the_local_stack_health_block(files, tmp_path, monkeypatch):
    monkeypatch.setenv("OPENJARVIS_VOICE_DIR", str(tmp_path / "voice"))
    paths, _ = files
    _write(paths[sr.HEALTH_KEY], _health())
    block = sr.read_summary()["speech"][0]
    seen = []

    def route(req: httpx.Request):
        seen.append(req)
        if req.url.port != 8650:
            raise AssertionError("the local feed never reaches the bridge")
        body = json.loads(req.content)
        AudioCache(tmp_path / "voice" / "cache").save(
            body["id"], b"\x00\x00" * 240, 24000, "fast", "fake"
        )
        return httpx.Response(200, json={"id": body["id"]})

    real_client = httpx.AsyncClient

    def fake_client(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(route)
        return real_client(*args, **kwargs)

    client = _client("127.0.0.1", vr.voice_router)
    body = {"feed": "stack_health", "id": block["id"]}
    with patch.object(vr.httpx, "AsyncClient", side_effect=fake_client):
        resp = client.post("/api/voice/prepare", json=body)
        assert resp.status_code == 200 and resp.json()["audio"] == "fast"
        assert block["text"].encode() in seen[0].content
        stale = client.post(
            "/api/voice/prepare", json={"feed": "stack_health", "id": "0" * 16}
        )
        assert stale.status_code == 404
        remote = _client("192.168.1.20", vr.voice_router)
        assert remote.post("/api/voice/prepare", json=body).status_code == 403
