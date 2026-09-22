"""Tests for the watchlist_check tool."""

from __future__ import annotations

import json
from unittest.mock import patch

from openjarvis.core.registry import ToolRegistry


def test_watchlist_check_registered():
    from openjarvis.tools.watchlist_check import WatchlistCheckTool

    ToolRegistry.register_value("watchlist_check", WatchlistCheckTool)
    assert ToolRegistry.contains("watchlist_check")


def test_watchlist_check_no_text_fails():
    from openjarvis.tools.watchlist_check import WatchlistCheckTool

    tool = WatchlistCheckTool()
    result = tool.execute(text="")
    assert result.success is False


def test_watchlist_check_no_watchlist_configured():
    from openjarvis.tools.watchlist_check import WatchlistCheckTool

    tool = WatchlistCheckTool()
    with patch("openjarvis.agents.digest_scoring.load_watchlist", return_value=[]):
        result = tool.execute(text="Some headline about NVDA")

    assert result.success is True
    assert result.metadata["matched_tickers"] == []
    assert result.metadata["final_score"] == 0.0


def test_watchlist_check_scores_matched_ticker():
    from openjarvis.agents.digest_scoring import WatchlistEntry
    from openjarvis.tools.watchlist_check import WatchlistCheckTool

    tool = WatchlistCheckTool()
    watchlist = [WatchlistEntry(ticker="NVDA", aliases=("Nvidia",))]

    with patch("openjarvis.agents.digest_scoring.load_watchlist", return_value=watchlist):
        with patch("openjarvis.market_data.MarketCapClient") as mock_client_cls:
            mock_client_cls.return_value.get_market_cap.return_value = 3_000_000_000_000
            result = tool.execute(text="Nvidia announces breakthrough partnership")

    assert result.success is True
    payload = json.loads(result.content)
    assert payload["matched_tickers"] == ["NVDA"]
    assert payload["final_score"] > 0
    assert result.metadata["matched_tickers"] == ["NVDA"]
