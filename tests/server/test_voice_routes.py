"""Tests for /api/voice (voice worker cache + fast-lane proxy) and the digest
audio switch to the worker. Neutral fixtures only; the bridge and the worker
are mocked."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from unittest.mock import patch

import pytest

pytest.importorskip("fastapi", reason="openjarvis[server] not installed")

import httpx

from openjarvis.server import voice_routes as vr
from openjarvis.voice_worker.core import AudioCache

ID_A, ID_B, ID_C = "00000000000000aa", "00000000000000bb", "00000000000000cc"


def _block(block_id: str, order: int, lane: str = "expressive") -> dict:
    return {
        "id": block_id,
        "title": f"Sample {order}",
        "text": "Sample spoken text.",
        "mood": "neutral",
        "priority": "briefing",
        "lane": lane,
        "created_at": "2026-09-30T06:00:00Z",
        "source_feed": "sample_feed",
        "order": order,
    }


def _queue_payload() -> dict:
    return {
        "feed": "voice_queue",
        "generated_at": "2026-09-30T06:05:00Z",
        "data": {
            "run_at": "2026-09-30T06:05:00Z",
            "items": [_block(ID_B, 2), _block(ID_A, 1), _block(ID_C, 3)],
        },
    }


@pytest.fixture(autouse=True)
def voice_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENJARVIS_VOICE_DIR", str(tmp_path / "voice"))
    return tmp_path / "voice"


def _cache(voice_dir) -> AudioCache:
    return AudioCache(voice_dir / "cache")


def _client(bridge=None, worker=None):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(vr.voice_router)
    real_client = httpx.AsyncClient
    seen: list[httpx.Request] = []

    def route(req: httpx.Request):
        seen.append(req)
        if req.url.port == 8650:
            if worker is None:
                raise httpx.ConnectError("refused", request=req)
            return worker(req)
        if bridge is None:
            raise httpx.ConnectError("refused", request=req)
        return bridge(req)

    def fake_client(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(route)
        return real_client(*args, **kwargs)

    return (
        TestClient(app),
        patch.object(vr.httpx, "AsyncClient", side_effect=fake_client),
        seen,
    )


def _worker_that_renders(voice_dir):
    def worker(req: httpx.Request):
        if req.url.path == "/health":
            return httpx.Response(200, json={"ok": True})
        if req.url.path == "/blocks/fast":
            import json

            body = json.loads(req.content)
            _cache(voice_dir).save(body["id"], b"\x00\x00" * 240, 24000, "fast", "fake")
            return httpx.Response(200, json={"id": body["id"]})
        if req.url.path == "/speak":
            return httpx.Response(
                200, content=b"RIFFfake", headers={"content-type": "audio/wav"}
            )
        return httpx.Response(404)

    return worker


# -- audio -------------------------------------------------------------------


@pytest.mark.parametrize(
    "bad", ["00000000000000AA", "abc", "00000000000000aa0", "zzzzzzzzzzzzzzzz"]
)
def test_audio_id_must_be_16_lowercase_hex(bad):
    client, patcher, _ = _client()
    with patcher:
        assert client.get(f"/api/voice/audio/{bad}").status_code == 400


def test_audio_404_until_cached_then_wav(voice_dir):
    client, patcher, _ = _client()
    with patcher:
        assert client.get(f"/api/voice/audio/{ID_A}").status_code == 404
        _cache(voice_dir).save(ID_A, b"\x00\x00" * 240, 24000, "expressive", "fake")
        resp = client.get(f"/api/voice/audio/{ID_A}")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "audio/wav"
    assert resp.content[:4] == b"RIFF"


# -- queue -------------------------------------------------------------------


def test_queue_merges_audio_status_in_order_without_text(voice_dir):
    _cache(voice_dir).save(ID_A, b"\x00\x00" * 240, 24000, "expressive", "fake")
    _cache(voice_dir).save(ID_B, b"\x00\x00" * 240, 24000, "fast", "fake")
    client, patcher, _ = _client(
        bridge=lambda r: httpx.Response(200, json=_queue_payload()),
        worker=_worker_that_renders(voice_dir),
    )
    with patcher:
        body = client.get("/api/voice/queue").json()
    assert [i["id"] for i in body["items"]] == [ID_A, ID_B, ID_C]
    assert [i["audio"] for i in body["items"]] == ["expressive", "fast", "missing"]
    assert body["items"][0]["audio_url"] == f"/api/voice/audio/{ID_A}"
    assert body["items"][0]["audio_path"].endswith(f"{ID_A}.wav")
    assert body["items"][2]["audio_path"] is None
    assert all("text" not in i for i in body["items"])
    assert body["worker"] is True


def test_queue_empty_before_hermes_publishes_and_503_when_bridge_down():
    client, patcher, _ = _client(bridge=lambda r: httpx.Response(404))
    with patcher:
        body = client.get("/api/voice/queue").json()
    assert body["items"] == [] and body["worker"] is False
    client, patcher, _ = _client()
    with patcher:
        assert client.get("/api/voice/queue").status_code == 503


# -- prepare -----------------------------------------------------------------


def test_prepare_returns_cached_audio_without_calling_anyone(voice_dir):
    _cache(voice_dir).save(ID_A, b"\x00\x00" * 240, 24000, "expressive", "fake")
    client, patcher, seen = _client()
    with patcher:
        body = client.post(
            "/api/voice/prepare", json={"feed": "ecom_briefing", "id": ID_A}
        ).json()
    assert body["audio"] == "expressive" and seen == []


def test_prepare_renders_a_missing_block_on_the_fast_lane(voice_dir):
    feed = {
        "feed": "ecom_briefing",
        "generated_at": "2026-09-30T06:05:00Z",
        "data": {"speech": [_block(ID_A, 1)]},
    }
    client, patcher, seen = _client(
        bridge=lambda r: httpx.Response(200, json=feed),
        worker=_worker_that_renders(voice_dir),
    )
    with patcher:
        body = client.post(
            "/api/voice/prepare", json={"feed": "ecom_briefing", "id": ID_A}
        ).json()
    assert body["audio"] == "fast"
    worker_calls = [r for r in seen if r.url.port == 8650]
    assert worker_calls and b"Sample spoken text." in worker_calls[0].content


def test_prepare_rejects_unknown_feeds_ids_and_stale_blocks(voice_dir):
    feed = {
        "feed": "ecom_briefing",
        "generated_at": "x",
        "data": {"speech": [_block(ID_B, 1)]},
    }
    client, patcher, _ = _client(
        bridge=lambda r: httpx.Response(200, json=feed),
        worker=_worker_that_renders(voice_dir),
    )
    with patcher:
        assert (
            client.post(
                "/api/voice/prepare", json={"feed": "other", "id": ID_A}
            ).status_code
            == 400
        )
        assert (
            client.post(
                "/api/voice/prepare", json={"feed": "ecom_briefing", "id": "bad"}
            ).status_code
            == 400
        )
        assert (
            client.post(
                "/api/voice/prepare", json={"feed": "ecom_briefing", "id": ID_A}
            ).status_code
            == 404
        )


def test_prepare_503_when_the_worker_is_down():
    feed = {
        "feed": "ecom_briefing",
        "generated_at": "x",
        "data": {"speech": [_block(ID_A, 1)]},
    }
    client, patcher, _ = _client(bridge=lambda r: httpx.Response(200, json=feed))
    with patcher:
        assert (
            client.post(
                "/api/voice/prepare", json={"feed": "ecom_briefing", "id": ID_A}
            ).status_code
            == 503
        )


# -- speak -------------------------------------------------------------------


def test_speak_proxies_the_fast_lane(voice_dir):
    client, patcher, _ = _client(worker=_worker_that_renders(voice_dir))
    with patcher:
        resp = client.post("/api/voice/speak", json={"text": "Sample read-out."})
    assert resp.status_code == 200 and resp.content == b"RIFFfake"
    assert resp.headers["content-type"] == "audio/wav"


def test_speak_limits_text_and_reports_a_down_worker():
    client, patcher, _ = _client()
    with patcher:
        assert (
            client.post("/api/voice/speak", json={"text": "x" * 2001}).status_code
            == 400
        )
        assert client.post("/api/voice/speak", json={"text": "  "}).status_code == 400
        assert (
            client.post("/api/voice/speak", json={"text": "Sample."}).status_code == 503
        )


# -- digest audio moves to the worker ----------------------------------------


def _digest_payload(speech: list | None) -> dict:
    data = {"text": "Sample digest text.", "category": "general"}
    if speech is not None:
        data["speech"] = speech
    return {
        "feed": "digest_general",
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "data": data,
    }


def test_digest_audio_is_the_workers_render_of_speech0(voice_dir):
    from openjarvis.server import digest_routes as dr

    _cache(voice_dir).save(ID_A, b"\x00\x00" * 240, 24000, "expressive", "fake")
    payload = _digest_payload([_block(ID_A, 1)])
    path = asyncio.run(dr._ensure_audio("general", payload))
    assert path is not None and path.name == f"{ID_A}.wav"
    assert dr._voice_used(payload, path) == "erebus"
    assert dr._audio_version(path)


def test_digest_renders_speech0_on_the_fast_lane_on_demand(voice_dir):
    from openjarvis.server import digest_routes as dr

    dr._tts_attempted.clear()
    client, patcher, seen = _client(worker=_worker_that_renders(voice_dir))
    payload = _digest_payload([_block(ID_B, 1)])
    with patcher:
        path = asyncio.run(dr._ensure_audio("general", payload))
    assert path is not None and path.name == f"{ID_B}.wav"
    assert dr._voice_used(payload, path) == "bm_george"
    assert any(r.url.path == "/blocks/fast" for r in seen)
