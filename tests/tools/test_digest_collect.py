"""Tests for the digest_collect tool."""

from __future__ import annotations

from datetime import datetime
from unittest.mock import MagicMock, patch

from openjarvis.connectors._stubs import Document
from openjarvis.core.registry import ConnectorRegistry, ToolRegistry


def test_digest_collect_registered():
    from openjarvis.tools.digest_collect import DigestCollectTool

    ToolRegistry.register_value("digest_collect", DigestCollectTool)
    assert ToolRegistry.contains("digest_collect")


def test_digest_collect_executes():
    from openjarvis.tools.digest_collect import DigestCollectTool

    tool = DigestCollectTool()

    mock_docs = [
        Document(
            doc_id="test-1",
            source="gmail",
            doc_type="email",
            content="Meeting at 3pm",
            title="Team standup",
            author="alice@example.com",
            timestamp=datetime(2026, 4, 1, 10, 0),
        )
    ]

    mock_connector = MagicMock()
    mock_connector.return_value.is_connected.return_value = True
    mock_connector.return_value.sync.return_value = mock_docs

    with patch.object(ConnectorRegistry, "contains", return_value=True):
        with patch.object(ConnectorRegistry, "get", return_value=mock_connector):
            result = tool.execute(sources=["gmail"], hours_back=24)

    assert result.success is True
    assert "=== MESSAGES ===" in result.content
    assert "[gmail id=test-1] From: alice@example.com" in result.content
    assert "Team standup" in result.content
    assert result.metadata["total_items"] == 1


def test_digest_collect_missing_connector():
    from openjarvis.tools.digest_collect import DigestCollectTool

    tool = DigestCollectTool()

    with patch.object(ConnectorRegistry, "contains", return_value=False):
        result = tool.execute(sources=["nonexistent"])

    assert result.success is True  # Partial success
    assert "not available" in result.content


def test_category_rss_sources_pass_through_unscored_even_with_watchlist():
    """news_rss_soccer/motorsport/entertainment must never be ticker-scored.

    They share the WORLD section with the watchlist-scored general news_rss/
    fmp_news/hackernews sources, so a watchlist being configured must not
    cause a soccer headline to get bucketed as "MARKET MOVERS" etc. -- these
    categories are explicitly general, unscored coverage.
    """
    from openjarvis.agents.digest_scoring import WatchlistEntry
    from openjarvis.tools.digest_collect import DigestCollectTool

    tool = DigestCollectTool()

    mock_docs = [
        Document(
            doc_id="soccer-1",
            source="news_rss",
            doc_type="article",
            content="Match report",
            title="Big club wins derby",
            timestamp=datetime(2026, 4, 1, 10, 0),
            metadata={"feed_name": "BBC Sport Football"},
        )
    ]
    mock_connector = MagicMock()
    mock_connector.return_value.is_connected.return_value = True
    mock_connector.return_value.sync.return_value = mock_docs
    watchlist = [WatchlistEntry(ticker="NVDA", aliases=["Nvidia"], category="ai")]

    with (
        patch.object(ConnectorRegistry, "contains", return_value=True),
        patch.object(ConnectorRegistry, "get", return_value=mock_connector),
        patch(
            "openjarvis.agents.digest_scoring.load_watchlist",
            return_value=watchlist,
        ),
    ):
        result = tool.execute(sources=["news_rss_soccer"], hours_back=24)

    assert result.success is True
    assert "=== WORLD ===" in result.content
    assert "Big club wins derby" in result.content
    for bucket_header in (
        "MARKET MOVERS",
        "STRATEGIC RISKS",
        "NICHE BREAKTHROUGHS",
        "GENERAL",
    ):
        assert bucket_header not in result.content
