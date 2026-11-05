"""The one feed proxy and the one clock (hermes_panel.FeedProxy, server/_time).
The bridge is mocked; invented feed documents only (this repo is public)."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import httpx
import pytest

pytest.importorskip("fastapi", reason="openjarvis[server] not installed")

from fastapi import HTTPException

from openjarvis.server import hermes_panel as hp
from openjarvis.server._time import age_seconds, parse_time

NOW = datetime(2026, 10, 28, 3, 51, 13, tzinfo=timezone.utc)


def test_parse_time_reads_iso_and_rfc_1123_alike():
    assert parse_time("2026-10-28T03:51:13Z") == NOW
    assert parse_time("2026-10-28T03:51:13") == NOW  # naive is UTC
    assert parse_time("Wed, 28 Oct 2026 03:51:13 GMT") == NOW
    assert parse_time(NOW.replace(tzinfo=None)) == NOW
    for bad in (None, "", "  ", "yesterday", 12, {}):
        assert parse_time(bad) is None


def test_age_seconds_never_negative():
    assert (
        age_seconds("Wed, 28 Oct 2026 03:51:13 GMT", NOW + timedelta(hours=1)) == 3600
    )
    assert age_seconds(NOW + timedelta(minutes=5), NOW) == 0
    assert age_seconds("not a time", NOW) is None


def _doc(n: int) -> dict:
    return {
        "feed": "sample_feed",
        "generated_at": "2026-10-28T03:51:13Z",
        "age_seconds": 30,
        "data": {"n": n},
    }


def _bridge(state: dict):
    real = httpx.AsyncClient

    def handler(req: httpx.Request) -> httpx.Response:
        state["calls"] += 1
        if not state["up"]:
            raise httpx.ConnectError("refused", request=req)
        return httpx.Response(200, json=_doc(state["calls"]))

    def fake(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return real(*args, **kwargs)

    return patch.object(httpx, "AsyncClient", side_effect=fake)


def test_a_feed_with_a_ttl_is_read_once_per_ttl():
    proxy = hp.FeedProxy("sample", {"sample_feed", "other"}, ttl_s={"sample_feed": 600})
    state = {"calls": 0, "up": True}
    clock = {"t": 1000.0}
    with _bridge(state), patch.object(hp.time, "monotonic", lambda: clock["t"]):
        first = asyncio.run(proxy.get_feed("sample_feed"))
        clock["t"] += 599
        again = asyncio.run(proxy.get_feed("sample_feed"))
        assert state["calls"] == 1 and again["n"] == first["n"] == 1
        assert again["stale"] is False
        clock["t"] += 2
        assert asyncio.run(proxy.get_feed("sample_feed"))["n"] == 2
        # A feed without a TTL reads through every time.
        asyncio.run(proxy.get_feed("other"))
        asyncio.run(proxy.get_feed("other"))
    assert state["calls"] == 4


def test_bridge_down_serves_the_last_copy_stale_then_503_without_one():
    proxy = hp.FeedProxy("sample", {"sample_feed"})
    state = {"calls": 0, "up": True}
    with _bridge(state):
        asyncio.run(proxy.get_feed("sample_feed"))
        state["up"] = False
        body = asyncio.run(proxy.get_feed("sample_feed"))
        assert body["stale"] is True and body["n"] == 1
        proxy.cache.clear()
        with pytest.raises(HTTPException) as exc:
            asyncio.run(proxy.get_feed("sample_feed"))
    assert exc.value.status_code == 503


def test_an_unknown_feed_is_404_with_no_bridge_call():
    proxy = hp.FeedProxy("sample", {"sample_feed"})
    state = {"calls": 0, "up": True}
    with _bridge(state), pytest.raises(HTTPException) as exc:
        asyncio.run(proxy.get_feed("not_listed"))
    assert exc.value.status_code == 404 and exc.value.detail == "Unknown sample feed"
    assert state["calls"] == 0


def test_the_commerce_routes_give_entity_watch_alone_a_ttl():
    from openjarvis.server import commerce_routes as cr

    assert cr._feeds.ttl_s == {"entity_watch": 600}
