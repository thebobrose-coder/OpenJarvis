"""FMP ticker news connector -- live, ticker-tagged financial news for the
watchlist, via Financial Modeling Prep's /stable/news/stock endpoint.

Unlike news_rss (generic feeds + keyword matching to guess ticker relevance),
every item here already carries an authoritative symbol from FMP itself --
digest_scoring checks Document.metadata["symbol"] before falling back to
fuzzy text matching. All API calls are in module-level functions for easy
mocking in tests, matching the hackernews/news_rss connector pattern.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, Iterator, List, Optional

import httpx

from openjarvis.connectors._stubs import BaseConnector, Document, SyncStatus
from openjarvis.core.credentials import get_tool_credential
from openjarvis.core.registry import ConnectorRegistry

_FMP_NEWS_URL = "https://financialmodelingprep.com/stable/news/stock"
_FETCH_LIMIT = 50
_TIMESTAMP_FORMAT = "%Y-%m-%d %H:%M:%S"


def _fetch_news(symbols: List[str], api_key: str, limit: int = _FETCH_LIMIT) -> List[Dict[str, Any]]:
    """Fetch ticker-tagged news for *symbols* (already-validated tickers)."""
    resp = httpx.get(
        _FMP_NEWS_URL,
        params={"symbols": ",".join(symbols), "apikey": api_key, "limit": limit},
        timeout=15.0,
    )
    resp.raise_for_status()
    data = resp.json()
    return data if isinstance(data, list) else []


def _parse_published(raw: str) -> Optional[datetime]:
    if not raw:
        return None
    try:
        return datetime.strptime(raw, _TIMESTAMP_FORMAT)
    except ValueError:
        return None


@ConnectorRegistry.register("fmp_news")
class FMPNewsConnector(BaseConnector):
    """Ticker-tagged news for the configured watchlist, via FMP."""

    connector_id = "fmp_news"
    display_name = "FMP Ticker News"
    auth_type = "local"

    def __init__(self) -> None:
        self._status = SyncStatus()

    def is_connected(self) -> bool:
        return bool(get_tool_credential("market_data", "FMP_API_KEY"))

    def disconnect(self) -> None:
        # FMP_API_KEY is shared with MarketCapClient's market-cap lookups --
        # this connector doesn't own the credential, so it has nothing of
        # its own to revoke. Remove the key via the market_data credential
        # entry directly if you want to fully disconnect FMP.
        pass

    def sync(
        self, *, since: Optional[datetime] = None, cursor: Optional[str] = None
    ) -> Iterator[Document]:
        """Yield ticker-tagged news Documents for the configured watchlist."""
        from openjarvis.agents.digest_scoring import load_watchlist

        api_key = get_tool_credential("market_data", "FMP_API_KEY")
        if not api_key:
            self._status.state = "idle"
            self._status.last_sync = datetime.now()
            return

        watchlist = load_watchlist()
        if not watchlist:
            self._status.state = "idle"
            self._status.last_sync = datetime.now()
            return

        symbols = [entry.ticker for entry in watchlist]
        items = _fetch_news(symbols, api_key)

        for item in items:
            published = _parse_published(item.get("publishedDate", ""))
            if since and published and published < since:
                continue

            symbol = item.get("symbol", "")
            url = item.get("url", "")
            title = item.get("title", "") or "(untitled)"
            doc_id = f"fmp-{symbol}-{url or title}"

            yield Document(
                doc_id=doc_id,
                source="fmp_news",
                doc_type="article",
                content=item.get("text", ""),
                title=title,
                author=item.get("publisher", ""),
                timestamp=published or datetime.now(),
                url=url or None,
                metadata={
                    "symbol": symbol,
                    "publisher": item.get("publisher", ""),
                    "site": item.get("site", ""),
                },
            )

        self._status.state = "idle"
        self._status.last_sync = datetime.now()

    def sync_status(self) -> SyncStatus:
        return self._status
