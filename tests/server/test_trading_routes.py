"""Tests for /api/trading (the read-only proxy for Hermes's trading feeds,
hq/decisions/0014, contract v1.6).

Invented numbers only: this repo is public. No product ids, no URLs that
exist, no account material.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch

import pytest

pytest.importorskip("fastapi", reason="openjarvis[server] not installed")

import httpx

from openjarvis.server import trading_routes as tr


def _status_doc(**over) -> dict:
    doc = {
        "schema": 1,
        "written_at": "2026-10-06T16:44:25Z",
        "mode": "paper",
        "app": {"installed_commit": "abc1234", "run_from": "/opt/trader/app"},
        "kill": {"local_file": False, "aws_flag": False},
        "heartbeat": {
            "last_sent_at": "2026-10-06T16:44:00Z",
            "last_ok": True,
            "alarm": "OK",
        },
        "sleeves": {
            "equities": {"halt_state": "NORMAL"},
            "crypto": {"halt_state": "NORMAL"},
        },
    }
    doc.update(over)
    return doc


def _payload(
    feed: str = "trading_status", age_s: int = 60, data: dict | None = None
) -> dict:
    stamp = datetime.now(timezone.utc) - timedelta(seconds=age_s)
    return {
        "feed": feed,
        "generated_at": stamp.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "age_seconds": age_s,
        "source_role": "trading",
        "data": data if data is not None else _status_doc(),
    }


@pytest.fixture(autouse=True)
def _reset():
    tr._cache.clear()
    yield
    tr._cache.clear()


def _client(handler):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(tr.trading_router)
    real_client = httpx.AsyncClient
    seen: list[httpx.Request] = []

    def recording(req):
        seen.append(req)
        return handler(req)

    def fake_client(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(recording)
        return real_client(*args, **kwargs)

    patcher = patch.object(tr.httpx, "AsyncClient", side_effect=fake_client)
    return TestClient(app), patcher, seen


def _down(req):
    raise httpx.ConnectError("refused", request=req)


# -- GET feeds ---------------------------------------------------------------


@pytest.mark.parametrize("feed", sorted(tr.FEEDS))
def test_allowed_feed_is_unwrapped_with_freshness(feed):
    client, patcher, seen = _client(lambda r: httpx.Response(200, json=_payload(feed)))
    with patcher:
        body = client.get(f"/api/trading/{feed}").json()

    assert body["mode"] == "paper"
    assert body["sleeves"]["equities"]["halt_state"] == "NORMAL"
    assert body["age_seconds"] == 60
    assert body["stale"] is False
    assert seen[0].url.path == f"/panels/{feed}"


@pytest.mark.parametrize(
    "feed", ["ecom_daily", "bd_pipeline", "digest_general", "breaking_alerts"]
)
def test_other_feeds_are_never_forwarded(feed):
    client, patcher, seen = _client(lambda r: httpx.Response(200, json=_payload()))
    with patcher:
        resp = client.get(f"/api/trading/{feed}")

    assert resp.status_code == 404
    assert seen == []


def test_feed_before_its_first_run_is_no_data_yet():
    client, patcher, _ = _client(lambda r: httpx.Response(404))
    with patcher:
        resp = client.get("/api/trading/trading_day")

    assert resp.status_code == 404
    assert resp.json()["detail"] == "No data yet"


def test_bridge_down_without_cache_is_503():
    client, patcher, _ = _client(_down)
    with patcher:
        assert client.get("/api/trading/trading_status").status_code == 503


def test_bridge_down_serves_last_known_with_age():
    up = {"ok": True}

    def handler(req):
        return (
            httpx.Response(200, json=_payload(age_s=7200)) if up["ok"] else _down(req)
        )

    client, patcher, _ = _client(handler)
    with patcher:
        client.get("/api/trading/trading_status")
        up["ok"] = False
        body = client.get("/api/trading/trading_status").json()

    assert body["stale"] is True
    assert 7200 - 60 <= body["age_seconds"] <= 7200 + 60


def test_hermes_stale_flag_inside_the_document_is_kept():
    """Hermes marks a status older than 15 minutes `stale: true` in the
    document itself; the route must not overwrite it with its own flag."""
    data = _status_doc(stale=True, stale_reason="written_at is 22 minutes old")
    client, patcher, _ = _client(
        lambda r: httpx.Response(200, json=_payload(data=data))
    )
    with patcher:
        body = client.get("/api/trading/trading_status").json()

    assert body["stale"] is True
    assert body["stale_reason"] == "written_at is 22 minutes old"


def test_non_object_document_is_not_cached():
    client, patcher, _ = _client(
        lambda r: httpx.Response(200, json=_payload(data=None) | {"data": []})
    )
    with patcher:
        assert client.get("/api/trading/trading_status").status_code == 503
    assert tr._cache == {}


# -- no writes ---------------------------------------------------------------


@pytest.mark.parametrize(
    "path",
    [
        "/api/trading/trading_status",
        "/api/trading/trading_day",
        "/api/trading/config",
        "/api/trading/kill",
        "/api/trading/pause",
    ],
)
def test_no_post_route_exists(path):
    client, patcher, seen = _client(
        lambda r: httpx.Response(202, json={"queued": True})
    )
    with patcher:
        resp = client.post(path)

    assert resp.status_code == 405
    assert seen == []


def test_router_declares_only_get_routes():
    methods = {
        m
        for route in tr.trading_router.routes
        for m in getattr(route, "methods", set())
    }
    assert methods == {"GET"}


# -- config ------------------------------------------------------------------


def _config_with(url):
    return SimpleNamespace(trading=SimpleNamespace(page_url=url))


def test_config_reports_the_page_url_when_set():
    client, patcher, _ = _client(_down)
    with (
        patcher,
        patch.object(
            tr,
            "load_config",
            return_value=_config_with("https://approvals.example.test/queue"),
        ),
    ):
        body = client.get("/api/trading/config").json()

    assert body == {
        "page_url_set": True,
        "page_url": "https://approvals.example.test/queue",
    }


@pytest.mark.parametrize(
    "url",
    [
        "",
        "   ",
        "http://approvals.example.test",
        "javascript:alert(1)",
        "file:///etc/passwd",
    ],
)
def test_config_unset_or_non_https_reads_as_not_set(url):
    client, patcher, _ = _client(_down)
    with patcher, patch.object(tr, "load_config", return_value=_config_with(url)):
        body = client.get("/api/trading/config").json()

    assert body == {"page_url_set": False, "page_url": None}


def test_config_survives_a_broken_config_file():
    client, patcher, _ = _client(_down)
    with patcher, patch.object(tr, "load_config", side_effect=ValueError("bad toml")):
        body = client.get("/api/trading/config").json()

    assert body == {"page_url_set": False, "page_url": None}


def test_trading_section_loads_from_toml(tmp_path):
    from openjarvis.core.config import load_config

    cfg_path = tmp_path / "config.toml"
    cfg_path.write_text(
        '[trading]\npage_url = "https://approvals.example.test/queue"\n',
        encoding="utf-8",
    )
    cfg = load_config(cfg_path)

    assert cfg.trading.page_url == "https://approvals.example.test/queue"
    assert load_config(tmp_path / "missing.toml").trading.page_url == ""
