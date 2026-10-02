"""Tests for /api/digest and /api/digest/culture (Hermes digest feed proxy)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch

import pytest

pytest.importorskip("fastapi", reason="openjarvis[server] not installed")

import httpx

from openjarvis.server import digest_routes as dr

_ARTICLE = {
    "title": "Club wins derby",
    "url": "https://example.com/derby",
    "source": "Example Sport",
    "category": "soccer",
    "score": 0.91,
    "published_at": "2026-09-28T07:00:00",
}


def _stamp(delta: timedelta = timedelta(0)) -> str:
    moment = datetime.now(timezone.utc) - delta
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def _payload(
    category: str = "general",
    generated_at: str | None = None,
    text: str = "Good morning, sir.\n\n**Markets** were calm.",
) -> dict:
    data = {
        "category": category,
        "text": text,
        "model_used": "qwen3.5:9b",
        "sources_used": ["news_rss"],
        "grounding": {"flagged": False},
        "generated_local": "2026-09-28T06:00:10.123456",
    }
    if category == "culture":
        data["articles"] = [dict(_ARTICLE)]
    else:
        data["collected"] = "raw collection"
    return {
        "feed": f"digest_{category}",
        "generated_at": generated_at or _stamp(timedelta(seconds=30)),
        "age_seconds": 30,
        "source_role": "hub",
        "data": data,
    }


@pytest.fixture(autouse=True)
def tts_calls(tmp_path, monkeypatch):
    dr._cache.clear()
    dr._tts_attempted.clear()
    audio_dir = tmp_path / "audio"
    audio_dir.mkdir()
    calls: list[tuple] = []

    def fake_synth(category, text, generated_at):
        calls.append((category, text, generated_at))
        path = audio_dir / f"{dr._audio_stem(category, generated_at)}.wav"
        path.write_bytes(b"RIFF")
        return path

    monkeypatch.setattr(dr, "_audio_dir", lambda: audio_dir)
    monkeypatch.setattr(dr, "_synthesize", fake_synth)
    monkeypatch.setattr(dr, "_POLL_INTERVAL_S", 0.0)
    monkeypatch.setattr(
        "openjarvis.core.config.load_config",
        lambda: SimpleNamespace(digest=SimpleNamespace(voice_id="test_voice")),
    )
    yield calls
    dr._cache.clear()
    dr._tts_attempted.clear()


def _client(handler, tmp_path, category: str = "general"):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    prefix = "/api/digest" if category == "general" else f"/api/digest/{category}"
    app = FastAPI()
    app.include_router(
        dr.create_digest_router(
            db_path=str(tmp_path / "digest.db"), category=category, prefix=prefix
        )
    )
    real_client = httpx.AsyncClient

    def fake_client(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return real_client(*args, **kwargs)

    return TestClient(app), patch.object(
        dr.httpx, "AsyncClient", side_effect=fake_client
    )


def _down(req):
    raise httpx.ConnectError("refused", request=req)


def test_today_passthrough_keeps_local_shape(tmp_path, tts_calls):
    payload = _payload()
    client, patcher = _client(lambda r: httpx.Response(200, json=payload), tmp_path)
    with patcher:
        resp = client.get("/api/digest")

    assert resp.status_code == 200
    body = resp.json()
    assert body["text"] == payload["data"]["text"]
    assert body["sections"] == {}
    assert body["articles"] == []
    assert body["sources_used"] == ["news_rss"]
    assert body["generated_at"] == "2026-09-28T06:00:10.123456"
    assert body["model_used"] == "qwen3.5:9b"
    assert body["voice_used"] == "test_voice"
    assert body["audio_available"] is True
    assert body["audio_path"].endswith(".wav")
    assert body["stale"] is False


def test_culture_passes_articles_through(tmp_path):
    payload = _payload("culture")
    client, patcher = _client(
        lambda r: httpx.Response(200, json=payload), tmp_path, category="culture"
    )
    with patcher:
        resp = client.get("/api/digest/culture")

    assert resp.status_code == 200
    assert resp.json()["articles"] == [_ARTICLE]


def test_general_passes_auto_fixes_through(tmp_path):
    fix = {
        "patch_id": "0123456789ab",
        "store": "store-a",
        "product_title": "Example Lamp",
        "admin_url": "https://admin.example.com/products/1",
        "fix_class": {"store": "store-a", "rule": "4", "field": "descriptionHtml"},
        "applied_at": "2026-10-03T05:10:00Z",
    }
    payload = _payload()
    payload["data"]["auto_fixes"] = [fix]
    client, patcher = _client(lambda r: httpx.Response(200, json=payload), tmp_path)
    with patcher:
        body = client.get("/api/digest").json()
    assert body["auto_fixes"] == [fix]

    # Without the key (before v1.4) it's an empty list.
    dr._cache.clear()
    client, patcher = _client(lambda r: httpx.Response(200, json=_payload()), tmp_path)
    with patcher:
        assert client.get("/api/digest").json()["auto_fixes"] == []


def test_yesterdays_document_is_404(tmp_path, tts_calls):
    payload = _payload(generated_at=_stamp(timedelta(days=2)))
    client, patcher = _client(lambda r: httpx.Response(200, json=payload), tmp_path)
    with patcher:
        resp = client.get("/api/digest")

    assert resp.status_code == 404
    assert resp.json()["detail"] == "No digest for today"
    assert tts_calls == []


def test_bridge_404_is_404(tmp_path):
    client, patcher = _client(lambda r: httpx.Response(404), tmp_path)
    with patcher:
        resp = client.get("/api/digest")

    assert resp.status_code == 404


def test_bridge_down_without_cache_is_503(tmp_path):
    client, patcher = _client(_down, tmp_path)
    with patcher:
        resp = client.get("/api/digest")

    assert resp.status_code == 503


def test_bridge_down_serves_last_known_with_age(tmp_path):
    payload = _payload(generated_at=_stamp(timedelta(minutes=2)))
    up = {"ok": True}

    def handler(req):
        if not up["ok"]:
            return _down(req)
        return httpx.Response(200, json=payload)

    client, patcher = _client(handler, tmp_path)
    with patcher:
        assert client.get("/api/digest").json()["stale"] is False
        up["ok"] = False
        resp = client.get("/api/digest")

    assert resp.status_code == 200
    body = resp.json()
    assert body["text"] == payload["data"]["text"]
    assert body["stale"] is True
    assert 110 <= body["age_seconds"] <= 130


def test_tts_once_per_generated_at(tmp_path, tts_calls):
    payloads = [_payload(generated_at=_stamp(timedelta(seconds=90)))]
    client, patcher = _client(
        lambda r: httpx.Response(200, json=payloads[-1]), tmp_path
    )
    with patcher:
        client.get("/api/digest")
        client.get("/api/digest")
        audio = client.get("/api/digest/audio")
        assert len(tts_calls) == 1
        # Markdown is stripped before speaking.
        assert tts_calls[0][1] == "Good morning, sir.\n\nMarkets were calm."
        assert audio.status_code == 200
        assert audio.content == b"RIFF"

        payloads.append(_payload(generated_at=_stamp(), text="New text."))
        client.get("/api/digest")
        client.get("/api/digest")

    assert [call[2] for call in tts_calls] == [
        payloads[0]["generated_at"],
        payloads[1]["generated_at"],
    ]


def test_tts_failure_is_not_retried_per_request(tmp_path, tts_calls, monkeypatch):
    calls = []

    def failing_synth(category, text, generated_at):
        calls.append(generated_at)
        return None

    monkeypatch.setattr(dr, "_synthesize", failing_synth)
    payload = _payload()
    client, patcher = _client(lambda r: httpx.Response(200, json=payload), tmp_path)
    with patcher:
        first = client.get("/api/digest").json()
        client.get("/api/digest")
        audio = client.get("/api/digest/audio")

    assert first["audio_available"] is False
    assert first["audio_path"] is None
    assert len(calls) == 1
    assert audio.status_code == 404


def test_generate_refreshes_and_polls_until_new_document(tmp_path, tts_calls):
    old = _payload(generated_at=_stamp(timedelta(minutes=1)), text="Old.")
    new = _payload(generated_at=_stamp(), text="Fresh.")
    feed = [old, old, old, new]
    seen: list[tuple[str, str]] = []

    def handler(req):
        seen.append((req.method, req.url.path))
        if req.method == "POST":
            return httpx.Response(
                202,
                json={
                    "feed": "digest_general",
                    "queued": True,
                    "already_queued": False,
                },
            )
        return httpx.Response(200, json=feed.pop(0) if len(feed) > 1 else feed[0])

    client, patcher = _client(handler, tmp_path)
    with patcher:
        resp = client.post("/api/digest/generate")

    assert resp.status_code == 200
    assert resp.json() == {"status": "ok", "text": "Fresh."}
    assert ("POST", "/panels/digest_general/refresh") in seen
    assert tts_calls[-1][2] == new["generated_at"]


def test_generate_times_out_with_504(tmp_path, monkeypatch):
    monkeypatch.setattr(dr, "_POLL_TIMEOUT_S", 0.05)
    monkeypatch.setattr(dr, "_POLL_INTERVAL_S", 0.01)
    payload = _payload()

    def handler(req):
        if req.method == "POST":
            return httpx.Response(202, json={"queued": True, "already_queued": True})
        return httpx.Response(200, json=payload)

    client, patcher = _client(handler, tmp_path)
    with patcher:
        resp = client.post("/api/digest/generate")

    assert resp.status_code == 504
    assert "refresh stays queued" in resp.json()["detail"]


def test_generate_with_bridge_down_is_503(tmp_path):
    client, patcher = _client(_down, tmp_path)
    with patcher:
        resp = client.post("/api/digest/generate")

    assert resp.status_code == 503


def test_general_schedule_is_read_only(tmp_path):
    client, _patcher = _client(_down, tmp_path)
    assert client.get("/api/digest/schedule").json()["managed_by"] == "hermes"
    assert (
        client.post("/api/digest/schedule", json={"enabled": False}).status_code == 409
    )


def test_culture_has_no_schedule_route(tmp_path):
    router = dr.create_digest_router(
        db_path=str(tmp_path / "digest.db"),
        category="culture",
        prefix="/api/digest/culture",
    )
    assert "/api/digest/culture/schedule" not in {route.path for route in router.routes}


def _run_warmup(handler):
    import asyncio

    real_client = httpx.AsyncClient

    def fake_client(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return real_client(*args, **kwargs)

    with patch.object(dr.httpx, "AsyncClient", side_effect=fake_client):
        asyncio.run(dr.warm_digest_audio())


def test_warmup_synthesizes_today_once_per_document(tts_calls):
    payloads = {
        "digest_general": _payload("general"),
        "digest_culture": _payload("culture"),
    }

    def handler(req):
        return httpx.Response(200, json=payloads[req.url.path.rsplit("/", 1)[-1]])

    _run_warmup(handler)
    _run_warmup(handler)

    assert sorted(call[0] for call in tts_calls) == ["culture", "general"]


def test_warmup_skips_missing_old_and_stale_documents(tts_calls):
    old = _payload(generated_at=_stamp(timedelta(days=2)))
    _run_warmup(lambda r: httpx.Response(200, json=old))
    _run_warmup(lambda r: httpx.Response(404))
    dr._cache["general"] = _payload()
    _run_warmup(_down)

    assert tts_calls == []


@pytest.mark.parametrize(
    ("now", "expected_s"),
    [
        ((5, 0), 70 * 60),  # before the first slot -> 06:10
        ((6, 10), 20 * 60),  # exactly on a slot -> the next one, 06:30
        ((6, 45), 15 * 60),  # between slots -> 07:00
        ((23, 0), (7 * 60 + 10) * 60),  # after the last slot -> 06:10 tomorrow
    ],
)
def test_seconds_until_next_warmup(now, expected_s):
    at = datetime(2026, 9, 28, *now, tzinfo=dr.HERMES_TZ)
    assert dr._seconds_until_next_warmup(at) == expected_s
