"""Tests for the synchronous Hermes digest reader."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import httpx
import pytest

from openjarvis.agents import hermes_digest as hd


def _payload(delta: timedelta) -> dict:
    stamp = (datetime.now(timezone.utc) - delta).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {"feed": "digest_general", "generated_at": stamp, "data": {"text": "Hi."}}


def _get(response: httpx.Response):
    def fake_get(url, timeout):
        assert url == hd.HERMES_DIGEST_URLS["general"]
        return response.__class__(
            response.status_code,
            content=response.content,
            request=httpx.Request("GET", url),
        )

    return patch.object(hd.httpx, "get", side_effect=fake_get)


def test_today_text():
    with _get(httpx.Response(200, json=_payload(timedelta(seconds=30)))):
        assert hd.fetch_today_text("general") == "Hi."


def test_older_document_is_none():
    with _get(httpx.Response(200, json=_payload(timedelta(days=2)))):
        assert hd.fetch_today_text("general") is None


def test_bridge_404_is_none():
    with _get(httpx.Response(404)):
        assert hd.fetch_today_text("general") is None


def test_bridge_error_raises():
    with _get(httpx.Response(503)), pytest.raises(httpx.HTTPStatusError):
        hd.fetch_today_text("general")


@pytest.mark.parametrize(
    "text",
    [
        "good morning",
        "Good morning!",
        "  good   morning, Jarvis.  ",
        "Morning",
        "morning sir",
        "morning brief",
        "Morning briefing!",
        "daily brief",
        "Daily briefing please",
        "my daily briefing",
        "the morning brief.",
        "what's my briefing",
        "whats my briefing?",
        "what’s my morning briefing",
    ],
)
def test_briefing_request_triggers(text):
    assert hd.is_briefing_request(text)


@pytest.mark.parametrize(
    "text",
    [
        "I had a good morning run",
        "good morning, how are you?",
        "morning run",
        "good morning what is the weather",
        "goodmorning",
        "morning briefing about nvidia",
        "tell me the daily briefing",
        "what is my briefing",
        "Hermes, good morning",
        "",
    ],
)
def test_briefing_request_non_triggers(text):
    assert not hd.is_briefing_request(text)
