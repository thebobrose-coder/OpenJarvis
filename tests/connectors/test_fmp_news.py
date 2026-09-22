"""Tests for FMPNewsConnector — ticker-tagged financial news via FMP."""

from __future__ import annotations

from datetime import datetime
from unittest.mock import patch

from openjarvis.connectors._stubs import Document
from openjarvis.core.registry import ConnectorRegistry


def test_fmp_news_registered():
    from openjarvis.connectors.fmp_news import FMPNewsConnector

    ConnectorRegistry.register_value("fmp_news", FMPNewsConnector)
    assert ConnectorRegistry.contains("fmp_news")
    cls = ConnectorRegistry.get("fmp_news")
    assert cls.connector_id == "fmp_news"
    assert cls.auth_type == "local"


def test_is_connected_true_with_key():
    from openjarvis.connectors.fmp_news import FMPNewsConnector

    connector = FMPNewsConnector()
    with patch(
        "openjarvis.connectors.fmp_news.get_tool_credential",
        return_value="fake-key",
    ):
        assert connector.is_connected() is True


def test_is_connected_false_without_key():
    from openjarvis.connectors.fmp_news import FMPNewsConnector

    connector = FMPNewsConnector()
    with patch(
        "openjarvis.connectors.fmp_news.get_tool_credential",
        return_value=None,
    ):
        assert connector.is_connected() is False


_SAMPLE_NEWS = [
    {
        "symbol": "NVDA",
        "publishedDate": "2026-09-21 22:53:01",
        "publisher": "The Motley Fool",
        "title": "Nvidia's Forecast Assumes No China Sales",
        "text": "Nvidia's revenue forecast excludes China data center sales.",
        "site": "fool.com",
        "url": "https://fool.com/nvda-forecast",
    },
    {
        "symbol": "IONQ",
        "publishedDate": "2026-09-21 10:00:00",
        "publisher": "Seeking Alpha",
        "title": "IonQ Partnership Announced",
        "text": "IonQ and SDT announce a strategic partnership.",
        "site": "seekingalpha.com",
        "url": "https://seekingalpha.com/ionq-partnership",
    },
]


def test_sync_yields_documents():
    from openjarvis.connectors.fmp_news import FMPNewsConnector
    from openjarvis.agents.digest_scoring import WatchlistEntry

    connector = FMPNewsConnector()
    watchlist = [WatchlistEntry(ticker="NVDA"), WatchlistEntry(ticker="IONQ")]

    with (
        patch("openjarvis.connectors.fmp_news.get_tool_credential", return_value="fake-key"),
        patch("openjarvis.agents.digest_scoring.load_watchlist", return_value=watchlist),
        patch("openjarvis.connectors.fmp_news._fetch_news", return_value=_SAMPLE_NEWS),
    ):
        docs = list(connector.sync())

    assert len(docs) == 2
    assert all(isinstance(d, Document) for d in docs)
    first = docs[0]
    assert first.source == "fmp_news"
    assert first.doc_type == "article"
    assert first.title == "Nvidia's Forecast Assumes No China Sales"
    assert first.metadata["symbol"] == "NVDA"
    assert first.metadata["publisher"] == "The Motley Fool"
    assert first.url == "https://fool.com/nvda-forecast"


def test_sync_filters_by_since():
    from openjarvis.connectors.fmp_news import FMPNewsConnector
    from openjarvis.agents.digest_scoring import WatchlistEntry

    connector = FMPNewsConnector()
    watchlist = [WatchlistEntry(ticker="NVDA"), WatchlistEntry(ticker="IONQ")]

    with (
        patch("openjarvis.connectors.fmp_news.get_tool_credential", return_value="fake-key"),
        patch("openjarvis.agents.digest_scoring.load_watchlist", return_value=watchlist),
        patch("openjarvis.connectors.fmp_news._fetch_news", return_value=_SAMPLE_NEWS),
    ):
        docs = list(connector.sync(since=datetime(2026, 9, 21, 12, 0, 0)))

    assert len(docs) == 1
    assert docs[0].metadata["symbol"] == "NVDA"


def test_sync_no_api_key_yields_nothing():
    from openjarvis.connectors.fmp_news import FMPNewsConnector

    connector = FMPNewsConnector()
    with patch("openjarvis.connectors.fmp_news.get_tool_credential", return_value=None):
        docs = list(connector.sync())
    assert docs == []


def test_sync_no_watchlist_yields_nothing():
    from openjarvis.connectors.fmp_news import FMPNewsConnector

    connector = FMPNewsConnector()
    with (
        patch("openjarvis.connectors.fmp_news.get_tool_credential", return_value="fake-key"),
        patch("openjarvis.agents.digest_scoring.load_watchlist", return_value=[]),
    ):
        docs = list(connector.sync())
    assert docs == []


def test_disconnect_is_noop():
    from openjarvis.connectors.fmp_news import FMPNewsConnector

    connector = FMPNewsConnector()
    connector.disconnect()  # must not raise
