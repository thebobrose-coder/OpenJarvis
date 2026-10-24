"""Tests for /api/studio (the Content page's Episodes surface, hq 0019 Part B).

Invented fixtures in a temp folder only: this repo is public, and nothing
here touches the real studio or its scheduled task."""

from __future__ import annotations

import json
import os
import subprocess
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

pytest.importorskip("fastapi", reason="openjarvis[server] not installed")

from openjarvis.server import studio_routes as sr

EID = "01ABCDEFGHJKMNPQRSTVWXYZ00"
OTHER = "01ABCDEFGHJKMNPQRSTVWXYZ11"
NOW = datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def _manifest(stage="awaiting-g0", **over) -> dict:
    at = _iso(NOW - timedelta(minutes=5))
    doc = {
        "schemaVersion": 1,
        "episodeId": EID,
        "propertyId": "alpha",
        "channel": "youtube",
        "episodeClass": "sample-class",
        "targetMinutes": 8,
        "sources": ["https://example.com/a"],
        "topic": "Sample topic about budget rigs",
        "title": "SAMPLE TITLE",
        "operatorEdited": False,
        "stage": stage,
        "stages": [
            {"stage": "scripted", "at": at, "ok": True, "note": "1 pass"},
            {"stage": stage, "at": at, "ok": True},
        ],
        "cloud": {"capEpisodeUsd": 2, "spentUsd": 0, "omniAllowed": False, "items": []},
        "gpuMinutes": 3.5,
        "rewrites": 0,
    }
    return {**doc, **over}


CLAIMS = [
    {
        "id": "c1",
        "beat": 1,
        "text": "A sample fact.",
        "source": "https://example.com/a",
        "kind": "fact",
    },
    {
        "id": "c2",
        "beat": 2,
        "text": "A sample uncited fact.",
        "source": "unsourced",
        "kind": "fact",
    },
]
SCRIPT = (
    "## [Beat 1: ONE]\n\nSample beat one.\n\n## [Beat 2: TWO]\n\nSample beat two.\n"
)


def _old(path: Path) -> None:
    """Back-date a file to before the G0 stage entry, as the studio wrote it."""
    t = (NOW - timedelta(minutes=10)).timestamp()
    os.utime(path, (t, t))


@pytest.fixture
def studio(tmp_path, monkeypatch):
    data = tmp_path / "data"
    root = data / "studio"
    folder = root / "alpha" / EID
    folder.mkdir(parents=True)
    (folder / "manifest.json").write_text(json.dumps(_manifest()), encoding="utf-8")
    (folder / "script.md").write_text(SCRIPT, encoding="utf-8")
    (folder / "claims.json").write_text(json.dumps(CLAIMS), encoding="utf-8")
    (folder / "plan.json").write_text(
        json.dumps({"beats": [{"beat": 1}, {"beat": 2}]}), encoding="utf-8"
    )
    for name in ("script.md", "claims.json"):
        _old(folder / name)
    (root / "status.json").write_text(
        json.dumps(
            {
                "generatedAt": _iso(datetime.now(timezone.utc)),
                "paused": {"alpha": False},
                "lanes": [
                    {
                        "propertyId": "alpha",
                        "queued": 0,
                        "inProduction": 1,
                        "published30d": 0,
                        "runwayDays": 7,
                    }
                ],
                "inFlight": [
                    {
                        "episodeId": EID,
                        "propertyId": "alpha",
                        "stage": "awaiting-g0",
                        "since": _iso(NOW),
                    }
                ],
                "spend": {
                    "month": "2026-01",
                    "alpha": {"usd": 0, "capUsd": 20, "gpuMinutes": 3.5},
                },
                "lastRun": {
                    "at": _iso(datetime.now(timezone.utc)),
                    "ok": True,
                    "advanced": 1,
                },
            }
        ),
        encoding="utf-8",
    )
    (data / "foundry").mkdir()
    (data / "foundry" / "foundry-bundle.json").write_text(
        json.dumps(
            {
                "properties": [
                    {
                        "id": "alpha",
                        "commerce": {"secret": "never-read"},
                        "studio": {
                            "channelName": "SAMPLE CHANNEL",
                            "lanePerWeek": 1,
                            "cloudCapUsdPerEpisode": 2,
                            "cloudCapUsdPerMonth": 20,
                            "gpuMinutesCap": 45,
                            "firstUnlisted": 5,
                            "episodeClasses": [
                                {"id": "sample-class", "name": "Sample Class"}
                            ],
                        },
                    },
                    {"id": "beta", "studio": None},
                ]
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(sr, "_data_dir", lambda: data)
    monkeypatch.setattr(sr, "_run_last", None)
    return folder


def _client(host: str = "127.0.0.1"):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(sr.studio_router)
    return TestClient(app, client=(host, 50000))


def _set_stage(folder: Path, stage: str, **over) -> None:
    (folder / "manifest.json").write_text(
        json.dumps(_manifest(stage, **over)), encoding="utf-8"
    )


# -- reads -------------------------------------------------------------------


def test_every_route_refuses_other_hosts(studio):
    client = _client("10.0.0.5")
    for method, path in (
        ("get", "/api/studio/status"),
        ("get", "/api/studio/episodes"),
        ("get", f"/api/studio/episodes/{EID}"),
        ("get", f"/api/studio/episodes/{EID}/media/cut.mp4"),
        ("post", f"/api/studio/episodes/{EID}/g0"),
        ("post", "/api/studio/run"),
        ("post", "/api/studio/pause/alpha"),
        ("delete", "/api/studio/pause/alpha"),
    ):
        body = {"json": {"decision": "reject"}} if path.endswith("/g0") else {}
        assert getattr(client, method)(path, **body).status_code == 403, path
    resp = client.put(
        f"/api/studio/episodes/{EID}/script", json={"version": "x", "script": "x"}
    )
    assert resp.status_code == 403


def test_unconfigured_data_dir_is_404(monkeypatch):
    monkeypatch.setattr(sr, "_data_dir", lambda: None)
    assert _client().get("/api/studio/status").status_code == 404


def test_status_adds_channels_flags_and_age_without_other_bundle_keys(studio):
    (studio.parent.parent / "pause").mkdir()
    (studio.parent.parent / "pause" / "alpha").write_text("x")
    body = _client().get("/api/studio/status").json()

    assert body["paused"] == {"alpha": True}  # the flag file wins over status.json
    assert body["published"] == {"alpha": 0}
    assert body["channels"]["alpha"]["channelName"] == "SAMPLE CHANNEL"
    assert body["channels"]["alpha"]["gpuMinutesCap"] == 45
    assert "beta" not in body["channels"]
    assert "never-read" not in json.dumps(body)
    assert body["stale"] is False and body["age_seconds"] < 60


def test_status_without_a_run_is_404(studio):
    (studio.parent.parent / "status.json").unlink()
    assert _client().get("/api/studio/status").status_code == 404


def test_episode_list_and_property_filter(studio):
    client = _client()
    rows = client.get("/api/studio/episodes").json()["episodes"]
    assert [r["episodeId"] for r in rows] == [EID]
    assert rows[0]["stage"] == "awaiting-g0" and rows[0]["g0Pending"] is False
    assert client.get("/api/studio/episodes?property=beta").json() == {"episodes": []}
    assert client.get("/api/studio/episodes?property=../x").status_code == 400


def test_episode_detail(studio):
    body = _client().get(f"/api/studio/episodes/{EID}").json()
    assert body["script"] == SCRIPT
    assert body["claims"] == CLAIMS
    assert body["edited"] is False
    assert body["visibility"] == {"visibility": "unlisted", "number": 1, "first": 5}
    assert body["media"] == {"cut": None, "short": None, "thumbs": []}
    assert len(body["version"]) == 64


def test_visibility_turns_public_after_the_first_five(studio):
    (studio.parent / "published.json").write_text(
        json.dumps([f"e{i}" for i in range(5)])
    )
    body = _client().get(f"/api/studio/episodes/{EID}").json()
    assert body["visibility"] == {"visibility": "public", "number": 6, "first": 5}


@pytest.mark.parametrize(
    "eid", ["not-an-id", "01abcdefghjkmnpqrstvwxyz00", "..%2F..%2Fx"]
)
def test_bad_episode_ids(studio, eid):
    assert _client().get(f"/api/studio/episodes/{eid}").status_code in (400, 404)


def test_unknown_episode_is_404(studio):
    assert _client().get(f"/api/studio/episodes/{OTHER}").status_code == 404


# -- media -------------------------------------------------------------------


def test_media_serves_only_the_episode_files(studio):
    (studio / "thumbs").mkdir()
    (studio / "thumbs" / "thumb-1.jpg").write_bytes(b"\xff\xd8sample")
    (studio / "short.mp4").write_bytes(b"sample-video")
    client = _client()

    resp = client.get(f"/api/studio/episodes/{EID}/media/thumbs/thumb-1.jpg")
    assert resp.status_code == 200 and resp.headers["content-type"] == "image/jpeg"
    resp = client.get(f"/api/studio/episodes/{EID}/media/short.mp4")
    assert resp.status_code == 200 and resp.content == b"sample-video"
    assert client.get(f"/api/studio/episodes/{EID}/media/cut.mp4").status_code == 404
    for bad in (
        "manifest.json",
        "script.md",
        "../../status.json",
        "thumbs/../manifest.json",
        "thumbs/x.txt",
        "a/b/c.jpg",
    ):
        assert client.get(f"/api/studio/episodes/{EID}/media/{bad}").status_code in (
            400,
            404,
        ), bad


# -- script edit -------------------------------------------------------------


def _version(client) -> str:
    return client.get(f"/api/studio/episodes/{EID}").json()["version"]


def test_script_edit_writes_atomically_and_marks_edited(studio):
    client = _client()
    new = SCRIPT.replace("Sample beat one.", "An edited beat one.")
    claims = [{**CLAIMS[0], "text": "An edited fact."}, CLAIMS[1]]
    resp = client.put(
        f"/api/studio/episodes/{EID}/script",
        json={"version": _version(client), "script": new, "claims": claims},
    )
    assert resp.status_code == 200
    assert (studio / "script.md").read_text(encoding="utf-8") == new
    assert (
        json.loads((studio / "claims.json").read_text())[0]["text"] == "An edited fact."
    )
    assert not list(studio.glob(".*.tmp"))
    assert client.get(f"/api/studio/episodes/{EID}").json()["edited"] is True


def test_script_edit_with_a_stale_version_is_409(studio):
    client = _client()
    resp = client.put(
        f"/api/studio/episodes/{EID}/script", json={"version": "0" * 64, "script": "x"}
    )
    assert resp.status_code == 409
    assert (studio / "script.md").read_text(encoding="utf-8") == SCRIPT


@pytest.mark.parametrize(
    "stage", ["scripting", "narrating", "at-g1", "rewrite-requested"]
)
def test_script_edit_only_at_g0(studio, stage):
    client = _client()
    version = _version(client)
    _set_stage(studio, stage)
    resp = client.put(
        f"/api/studio/episodes/{EID}/script", json={"version": version, "script": "x"}
    )
    assert resp.status_code == 409


@pytest.mark.parametrize(
    "claims",
    [
        [CLAIMS[0]],  # removed one
        [*CLAIMS, {**CLAIMS[0], "id": "c9"}],  # added one
        [{**CLAIMS[0], "kind": "rumour"}, CLAIMS[1]],
        [{**CLAIMS[0], "source": "http://example.com"}, CLAIMS[1]],
        [{**CLAIMS[0], "text": " "}, CLAIMS[1]],
    ],
)
def test_bad_claim_edits_are_400(studio, claims):
    client = _client()
    resp = client.put(
        f"/api/studio/episodes/{EID}/script",
        json={"version": _version(client), "claims": claims},
    )
    assert resp.status_code == 400
    assert json.loads((studio / "claims.json").read_text()) == CLAIMS


def test_claim_edit_keeps_the_studio_keys(studio):
    client = _client()
    claims = [{"id": "c1", "text": "Edited.", "source": "", "kind": "lore"}, CLAIMS[1]]
    client.put(
        f"/api/studio/episodes/{EID}/script",
        json={"version": _version(client), "claims": claims},
    )
    saved = json.loads((studio / "claims.json").read_text())[0]
    assert saved == {
        "id": "c1",
        "beat": 1,
        "text": "Edited.",
        "source": "",
        "kind": "lore",
    }


# -- G0 ----------------------------------------------------------------------


def _g0(client, **body):
    return client.post(f"/api/studio/episodes/{EID}/g0", json=body)


def test_approve_needs_every_claim_checked(studio):
    client = _client()
    resp = _g0(client, decision="approve", claimsChecked=["c1"])
    assert resp.status_code == 400
    assert not (studio / "g0.json").exists()


def test_approve_writes_g0_json(studio):
    resp = _g0(
        _client(),
        decision="approve",
        claimsChecked=["c1", "c2", "zz"],
        omni=True,
        note=" ok ",
    )
    assert resp.status_code == 200
    g0 = json.loads((studio / "g0.json").read_text())
    assert g0["decision"] == "approve"
    assert g0["claimsChecked"] == ["c1", "c2"]
    assert g0["omni"] is True and g0["note"] == "ok" and g0["edited"] is False
    assert datetime.fromisoformat(g0["at"].replace("Z", "+00:00"))


def test_an_edit_marks_the_decision_edited_even_after_a_reload(studio):
    (studio / "script.md").write_text(SCRIPT + "\n")  # mtime now, after the stage entry
    _g0(_client(), decision="reject")
    assert json.loads((studio / "g0.json").read_text())["edited"] is True


def test_rewrite_needs_a_note_and_stops_at_two(studio):
    client = _client()
    assert _g0(client, decision="rewrite").status_code == 400
    _set_stage(studio, "awaiting-g0", rewrites=2)
    assert _g0(client, decision="rewrite", note="tighter").status_code == 409
    _set_stage(studio, "awaiting-g0", rewrites=1)
    resp = _g0(client, decision="rewrite", note="tighter", omni=True)
    assert resp.status_code == 200 and resp.json()["omni"] is False


def test_a_waiting_decision_blocks_another_and_the_edit(studio):
    client = _client()
    version = _version(client)
    assert _g0(client, decision="reject").status_code == 200
    assert _g0(client, decision="reject").status_code == 409
    resp = client.put(
        f"/api/studio/episodes/{EID}/script", json={"version": version, "script": "x"}
    )
    assert resp.status_code == 409


@pytest.mark.parametrize("stage", ["queued", "narrating", "at-g1", "published"])
def test_g0_only_at_g0(studio, stage):
    _set_stage(studio, stage)
    assert _g0(_client(), decision="reject").status_code == 409


def test_g0_refuses_unknown_decisions_and_long_notes(studio):
    client = _client()
    assert _g0(client, decision="publish").status_code == 400
    assert _g0(client, decision="reject", note="x" * 1001).status_code == 400


# -- publish.json ------------------------------------------------------------

PUBLISH = {
    "title": "  Sample   title ",
    "description": "A sample.",
    "tags": ["one", " two "],
    "thumbnail": "thumb-2.jpg",
}


def _thumbs(folder: Path) -> None:
    (folder / "thumbs").mkdir()
    for i in (1, 2, 3):
        (folder / "thumbs" / f"thumb-{i}.jpg").write_bytes(b"x")


def test_publish_writes_the_file_foundry_reads(studio):
    _thumbs(studio)
    _set_stage(studio, "assembling", assembledAt=_iso(NOW))
    resp = _client().put(f"/api/studio/episodes/{EID}/publish", json=PUBLISH)
    assert resp.status_code == 200
    assert json.loads((studio / "publish.json").read_text()) == {
        "title": "Sample title",
        "description": "A sample.",
        "tags": ["one", "two"],
        "thumbnail": "thumb-2.jpg",
    }


def test_publish_waits_for_thumbnails(studio):
    assert (
        _client().put(f"/api/studio/episodes/{EID}/publish", json=PUBLISH).status_code
        == 409
    )


@pytest.mark.parametrize(
    "bad",
    [
        {"title": "x"},
        {"title": "x" * 101},
        {"title": "A <b> title"},
        {"description": "x" * 5001},
        {"description": "a > b"},
        {"tags": ["x" * 90] * 6},
        {"thumbnail": "thumb-9.jpg"},
        {"thumbnail": "../manifest.json"},
    ],
)
def test_publish_checks_as_submit_does(studio, bad):
    _thumbs(studio)
    resp = _client().put(f"/api/studio/episodes/{EID}/publish", json={**PUBLISH, **bad})
    assert resp.status_code == 400
    assert not (studio / "publish.json").exists()


@pytest.mark.parametrize(
    "stage", ["scanning", "at-g1", "publishing", "published", "rejected"]
)
def test_publish_only_before_g1(studio, stage):
    _thumbs(studio)
    _set_stage(studio, stage)
    assert (
        _client().put(f"/api/studio/episodes/{EID}/publish", json=PUBLISH).status_code
        == 409
    )


def test_publish_after_submit_is_refused_even_when_stopped(studio):
    _thumbs(studio)
    _set_stage(studio, "stopped", executionArn="arn:sample")
    assert (
        _client().put(f"/api/studio/episodes/{EID}/publish", json=PUBLISH).status_code
        == 409
    )


# -- controls ----------------------------------------------------------------


def test_pause_and_resume_write_the_flag_file(studio):
    client = _client()
    flag = studio.parent.parent / "pause" / "alpha"
    assert client.post("/api/studio/pause/alpha").json() == {
        "propertyId": "alpha",
        "paused": True,
    }
    assert flag.is_file()
    assert client.post("/api/studio/pause/alpha").status_code == 200  # idempotent
    assert client.delete("/api/studio/pause/alpha").json()["paused"] is False
    assert not flag.exists()
    assert client.delete("/api/studio/pause/alpha").status_code == 200


def test_pause_refuses_unknown_channels(studio):
    client = _client()
    assert client.post("/api/studio/pause/beta").status_code == 404
    assert client.post("/api/studio/pause/..").status_code in (400, 404)
    assert not (studio.parent.parent / "pause" / "beta").exists()


class _Done:
    returncode = 0
    stdout = "SUCCESS"
    stderr = ""


def test_run_starts_the_task_then_cools_down(studio, monkeypatch):
    calls = []
    monkeypatch.setattr(sr.sys, "platform", "win32")
    monkeypatch.setattr(
        sr.subprocess, "run", lambda args, **kw: calls.append(args) or _Done()
    )
    client = _client()

    assert client.post("/api/studio/run").status_code == 202
    assert calls == [["schtasks", "/Run", "/TN", sr.STUDIO_TASK]]
    resp = client.post("/api/studio/run")
    assert resp.status_code == 429 and int(resp.headers["Retry-After"]) > 0
    assert len(calls) == 1

    monkeypatch.setattr(sr, "_run_last", time.monotonic() - sr.RUN_COOLDOWN_S - 1)
    assert client.post("/api/studio/run").status_code == 202


def test_run_reports_an_unregistered_task(studio, monkeypatch):
    class Missing:
        returncode = 1
        stdout = ""
        stderr = "ERROR: The system cannot find the file specified.\r\n"

    monkeypatch.setattr(sr.sys, "platform", "win32")
    monkeypatch.setattr(sr.subprocess, "run", lambda *a, **k: Missing())
    resp = _client().post("/api/studio/run")
    assert resp.status_code == 503
    assert "cannot find" in resp.json()["detail"]
    assert sr._run_last is None  # a failed start doesn't start the cooldown


def test_run_timeout_is_503(studio, monkeypatch):
    def boom(*a, **k):
        raise subprocess.TimeoutExpired("schtasks", 10)

    monkeypatch.setattr(sr.sys, "platform", "win32")
    monkeypatch.setattr(sr.subprocess, "run", boom)
    assert _client().post("/api/studio/run").status_code == 503


# -- v0.1.3 / v0.1.4 additions -------------------------------------------------


def test_the_card_carries_the_studio_wait_note(studio):
    m = _manifest("visualizing")
    m["stages"].append(
        {
            "stage": "visualizing",
            "at": m["stages"][-1]["at"],
            "ok": True,
            "note": "waiting for the fixed text",
        }
    )
    (studio / "manifest.json").write_text(json.dumps(m), encoding="utf-8")
    row = _client().get("/api/studio/episodes").json()["episodes"][0]
    assert row["stageNote"] == "waiting for the fixed text"


def test_no_note_from_an_earlier_stage(studio):
    row = _client().get("/api/studio/episodes").json()["episodes"][0]
    assert row["stageNote"] is None  # "1 pass" belongs to scripted, not awaiting-g0


def test_source_index_names_the_sources_when_the_snapshot_exists(studio):
    client = _client()
    assert client.get(f"/api/studio/episodes/{EID}").json()["sourceIndex"] is None
    (studio / "sources").mkdir()
    (studio / "sources" / "index.json").write_text(
        json.dumps(
            [{"n": 1, "url": "https://example.com/a", "fetchedAt": "x", "chars": 9}]
        )
    )
    body = client.get(f"/api/studio/episodes/{EID}").json()
    assert body["sourceIndex"] == [{"n": 1, "url": "https://example.com/a"}]
