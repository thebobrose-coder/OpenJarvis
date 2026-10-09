"""Tests for /api/breaking-news (Hermes alert feed proxy)."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest

pytest.importorskip("fastapi", reason="openjarvis[server] not installed")

import httpx

from openjarvis.server import breaking_news_routes as bnr

_DATA = {
    "headline": "Chipmaker halts exports",
    "summary": "Two sentences. Of summary.",
    "why": "Hits a watchlist name.",
    "severity": 9,
    "url": "https://example.com/story",
    "source": "BBC World",
    "published": "2026-09-25T19:10:00Z",
    "tickers": ["NVDA"],
    "portfolio_bar": True,
    "triaged_by": "qwen3.5:9b",
}


def _payload(generated_at: str = "2026-09-25T19:15:07Z") -> dict:
    return {
        "feed": "breaking_alerts",
        "generated_at": generated_at,
        "age_seconds": 40,
        "source_role": "news-monitor",
        "data": dict(_DATA),
    }


@pytest.fixture(autouse=True)
def _reset(tmp_path, monkeypatch):
    bnr._cache = None
    bnr._recent_cache.clear()
    bnr._audio.update(generated_at=None, path=None)
    calls: list[tuple] = []

    def fake_synth(headline, summary, generated_at):
        calls.append((headline, summary, generated_at))
        path = tmp_path / f"breaking-{len(calls)}.mp3"
        path.write_bytes(b"ID3")
        return path

    monkeypatch.setattr(bnr, "_synthesize", fake_synth)
    yield calls
    bnr._cache = None
    bnr._audio.update(generated_at=None, path=None)


def _client(handler):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(bnr.create_breaking_news_router())
    real_client = httpx.AsyncClient

    def fake_client(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return real_client(*args, **kwargs)

    return TestClient(app), patch.object(
        bnr.httpx, "AsyncClient", side_effect=fake_client
    )


def _down(req):
    raise httpx.ConnectError("refused", request=req)


def test_passthrough_shape(_reset):
    client, patcher = _client(lambda r: httpx.Response(200, json=_payload()))
    with patcher:
        resp = client.get("/api/breaking-news")

    assert resp.status_code == 200
    body = resp.json()
    assert body["headline"] == _DATA["headline"]
    assert body["summary"] == _DATA["summary"]
    assert body["url"] == _DATA["url"]
    assert body["alerted_at"] == "2026-09-25T19:15:07Z"
    assert body["audio_available"] is True
    assert Path(body["audio_path"]).exists()
    assert body["severity"] == 9
    assert body["tickers"] == ["NVDA"]
    assert body["why"] == _DATA["why"]
    assert body["stale"] is False
    assert _reset == [(_DATA["headline"], _DATA["summary"], "2026-09-25T19:15:07Z")]


def test_bridge_404_is_no_alerts_yet():
    client, patcher = _client(
        lambda r: httpx.Response(404, json={"error": "no data yet"})
    )
    with patcher:
        resp = client.get("/api/breaking-news")

    assert resp.status_code == 404
    assert resp.json() == {"detail": "No breaking news alerts yet"}


def test_bridge_down_serves_cache_as_stale(_reset):
    up, patcher = _client(lambda r: httpx.Response(200, json=_payload()))
    with patcher:
        assert up.get("/api/breaking-news").json()["stale"] is False

    client, patcher = _client(_down)
    with patcher:
        resp = client.get("/api/breaking-news")

    assert resp.status_code == 200
    body = resp.json()
    assert body["stale"] is True
    assert body["headline"] == _DATA["headline"]
    assert body["audio_available"] is True
    assert len(_reset) == 1  # the cached alert is not re-spoken


def test_bridge_down_without_cache_returns_503():
    client, patcher = _client(_down)
    with patcher:
        resp = client.get("/api/breaking-news")

    assert resp.status_code == 503


def test_tts_once_per_new_alert(_reset):
    current = {"payload": _payload("2026-09-25T19:15:07Z")}
    client, patcher = _client(lambda r: httpx.Response(200, json=current["payload"]))
    with patcher:
        for _ in range(3):
            client.get("/api/breaking-news")
        assert len(_reset) == 1

        current["payload"] = _payload("2026-09-25T21:02:44Z")
        first = client.get("/api/breaking-news").json()
        client.get("/api/breaking-news")

    assert [c[2] for c in _reset] == ["2026-09-25T19:15:07Z", "2026-09-25T21:02:44Z"]
    assert first["alerted_at"] == "2026-09-25T21:02:44Z"


def test_tts_failure_still_serves_alert_and_is_not_retried(monkeypatch):
    calls = []

    def boom(*args):
        calls.append(args)
        raise RuntimeError("no TTS backend")

    monkeypatch.setattr(bnr, "_synthesize", boom)
    client, patcher = _client(lambda r: httpx.Response(200, json=_payload()))
    with patcher:
        a = client.get("/api/breaking-news").json()
        b = client.get("/api/breaking-news").json()

    assert a["headline"] == _DATA["headline"]
    assert a["audio_available"] is False and b["audio_available"] is False
    assert len(calls) == 1


def test_audio_endpoint_serves_current_alert_audio():
    client, patcher = _client(lambda r: httpx.Response(200, json=_payload()))
    with patcher:
        assert client.get("/api/breaking-news/audio").status_code == 404
        client.get("/api/breaking-news")
        resp = client.get("/api/breaking-news/audio")

    assert resp.status_code == 200
    assert resp.headers["content-type"] == "audio/mpeg"
    assert resp.content == b"ID3"


def test_synthesize_uses_digest_voice_and_per_alert_file(tmp_path, monkeypatch):
    """The real _synthesize: TextToSpeechTool with the digest voice settings."""
    from openjarvis.core import config as config_mod
    from openjarvis.tools import text_to_speech

    monkeypatch.setenv("OPENJARVIS_HOME", str(tmp_path))
    seen = {}

    class FakeTTS:
        def execute(self, **kwargs):
            seen.update(kwargs)
            out = Path(kwargs["output_dir"])
            out.mkdir(parents=True, exist_ok=True)
            (out / "digest.mp3").write_bytes(b"ID3")
            (out / "breaking-old.mp3").write_bytes(b"old")

            class R:
                success = True
                content = "ok"
                metadata = {"audio_path": str(out / "digest.mp3")}

            return R()

    monkeypatch.setattr(text_to_speech, "TextToSpeechTool", FakeTTS)
    # Restore the real function (the autouse fixture stubbed it).
    monkeypatch.setattr(bnr, "_synthesize", _real_synthesize)

    path = bnr._synthesize("Head", "Sum.", "2026-09-25T19:15:07Z")

    dc = config_mod.load_config().digest
    assert seen["text"] == "Head. Sum."
    assert seen["voice_id"] == dc.voice_id
    assert seen["backend"] == dc.tts_backend
    assert seen["speed"] == dc.voice_speed
    assert Path(seen["output_dir"]) == tmp_path / "digests" / "breaking"
    assert path.name == "breaking-20260925T191507Z.mp3"
    assert path.exists()
    assert not (path.parent / "digest.mp3").exists()
    assert not (path.parent / "breaking-old.mp3").exists()


# --- /recent (contract v1.7) ---------------------------------------------

_HAZARD = {
    **_DATA,
    "headline": "M7.1 earthquake, Example Region (PAGER red)",
    "source": "USGS",
    "kind": "hazard",
    "event_id": "usgs:example1",
    "level": "red",
    "severity": 10,
    "tickers": [],
}
_TRADING = {
    **_DATA,
    "headline": "Trader status stale",
    "source": "trading",
    "severity": "high",
}


def _recent(*datas: dict) -> dict:
    stamps = ["2026-10-09T19:20:18Z", "2026-10-09T15:00:00Z", "2026-10-09T09:00:00Z"]
    return {
        "feed": "breaking_alerts",
        "rows": [
            {
                "generated_at": stamps[i],
                "age_seconds": 60,
                "source_role": "news-monitor",
                "data": dict(d),
            }
            for i, d in enumerate(datas)
        ],
    }


def test_recent_passes_v17_keys_through_and_defaults_kind(_reset):
    seen = []

    def handler(req):
        seen.append(req.url)
        return httpx.Response(200, json=_recent(_HAZARD, _TRADING, _DATA))

    client, patcher = _client(handler)
    with patcher:
        resp = client.get("/api/breaking-news/recent")

    assert resp.status_code == 200
    body = resp.json()
    assert body["stale"] is False
    hazard, trading, news = body["alerts"]
    assert hazard["kind"] == "hazard"
    assert hazard["event_id"] == "usgs:example1"
    assert hazard["level"] == "red"
    assert hazard["source"] == "USGS"
    assert hazard["alerted_at"] == "2026-10-09T19:20:18Z"
    assert trading["kind"] == "trading" and trading["severity"] == "high"
    assert news["kind"] == "news" and news["level"] is None and news["event_id"] is None
    # No audio for the list: nothing synthesized, no audio keys.
    assert _reset == []
    assert "audio_path" not in hazard
    assert seen[0].path == "/panels/breaking_alerts/recent"
    assert dict(seen[0].params) == {"hours": "24", "limit": "3"}


@pytest.mark.parametrize(
    ("query", "expected"),
    [
        ("", {"hours": "24", "limit": "3"}),
        ("?hours=0&limit=0", {"hours": "1", "limit": "1"}),
        ("?hours=500&limit=99", {"hours": "72", "limit": "10"}),
        ("?hours=48&limit=5", {"hours": "48", "limit": "5"}),
    ],
)
def test_recent_clamps_hours_and_limit(query, expected):
    seen = []

    def handler(req):
        seen.append(dict(req.url.params))
        return httpx.Response(200, json=_recent())

    client, patcher = _client(handler)
    with patcher:
        assert client.get(f"/api/breaking-news/recent{query}").status_code == 200

    assert seen == [expected]


def test_recent_bridge_down_serves_last_good_as_stale():
    up, patcher = _client(lambda r: httpx.Response(200, json=_recent(_HAZARD)))
    with patcher:
        assert up.get("/api/breaking-news/recent").json()["stale"] is False

    client, patcher = _client(_down)
    with patcher:
        resp = client.get("/api/breaking-news/recent")

    assert resp.status_code == 200
    body = resp.json()
    assert body["stale"] is True
    assert [a["headline"] for a in body["alerts"]] == [_HAZARD["headline"]]


def test_recent_bridge_down_without_cache_returns_503():
    client, patcher = _client(_down)
    with patcher:
        assert client.get("/api/breaking-news/recent").status_code == 503


def test_recent_bridge_404_is_an_empty_list():
    client, patcher = _client(
        lambda r: httpx.Response(404, json={"error": "no data yet"})
    )
    with patcher:
        resp = client.get("/api/breaking-news/recent")

    assert resp.status_code == 200
    assert resp.json() == {"alerts": [], "stale": False}


def test_latest_route_unchanged_by_v17_keys(_reset):
    """`/api/breaking-news` keeps its shape (and speaks) with v1.7 rows."""
    payload = _payload()
    payload["data"] = dict(_HAZARD)
    client, patcher = _client(lambda r: httpx.Response(200, json=payload))
    with patcher:
        body = client.get("/api/breaking-news").json()

    assert set(body) == {
        "headline",
        "summary",
        "url",
        "alerted_at",
        "audio_available",
        "audio_path",
        "severity",
        "tickers",
        "why",
        "stale",
    }
    assert len(_reset) == 1


def test_route_no_longer_uses_alert_store():
    import inspect

    assert "BreakingAlertStore" not in inspect.getsource(bnr)


_real_synthesize = bnr._synthesize
