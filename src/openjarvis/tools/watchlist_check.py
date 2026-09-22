"""watchlist_check tool -- scores an ad-hoc headline/story against the
configured ticker watchlist, for agents (like the breaking-news operator)
deciding whether a specific candidate story is worth acting on."""

from __future__ import annotations

import json
from typing import Any

from openjarvis.core.registry import ToolRegistry
from openjarvis.core.types import ToolResult
from openjarvis.tools._stubs import BaseTool, ToolSpec


@ToolRegistry.register("watchlist_check")
class WatchlistCheckTool(BaseTool):
    """Score a single headline or story against the portfolio watchlist."""

    tool_id = "watchlist_check"
    is_local = True

    @property
    def spec(self) -> ToolSpec:
        return ToolSpec(
            name="watchlist_check",
            description=(
                "Check a specific headline or story against the configured "
                "portfolio ticker watchlist. Returns matched tickers, an "
                "event-impact score, a market-cap factor, and a final "
                "priority score -- use this to decide whether a story "
                "warrants alerting even when it would not lead a global "
                "newscast on its own."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "text": {
                        "type": "string",
                        "description": "The headline and/or summary text to check.",
                    },
                },
                "required": ["text"],
            },
            category="data",
            timeout_seconds=15.0,
        )

    def execute(self, **params: Any) -> ToolResult:
        from openjarvis.agents.digest_scoring import load_watchlist, score_text
        from openjarvis.market_data import MarketCapClient

        text = str(params.get("text", "")).strip()
        if not text:
            return ToolResult(
                tool_name="watchlist_check",
                content="No text provided.",
                success=False,
            )

        watchlist = load_watchlist()
        if not watchlist:
            payload = {"matched_tickers": [], "event_impact_score": 0.0, "market_cap_factor": 0.0, "final_score": 0.0}
            return ToolResult(
                tool_name="watchlist_check",
                content="No watchlist configured -- nothing to check against.",
                success=True,
                metadata=payload,
            )

        result = score_text(text, watchlist, MarketCapClient())
        payload = {
            "matched_tickers": result.matched_tickers,
            "event_impact_score": round(result.event_impact_score, 2),
            "market_cap_factor": round(result.market_cap_factor, 2),
            "final_score": round(result.final_score, 2),
        }
        return ToolResult(
            tool_name="watchlist_check",
            content=json.dumps(payload),
            success=True,
            metadata=payload,
        )
