"""Market data client -- currently backed by Financial Modeling Prep.

Used only to tier a watchlist ticker's market cap for digest_scoring's
market-cap factor. Results are cached with a 24h TTL since this only needs a
daily refresh, not a per-run fetch, keeping a free-tier API well within its
rate limit for a small watchlist.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, Optional

import httpx

from openjarvis.core.credentials import get_tool_credential
from openjarvis.core.paths import get_config_dir

logger = logging.getLogger(__name__)

_CACHE_TTL = timedelta(hours=24)
_FMP_QUOTE_URL = "https://financialmodelingprep.com/stable/quote"


def _default_cache_path() -> Path:
    return get_config_dir() / "market_cap_cache.json"


def _load_cache(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def _save_cache(path: Path, cache: Dict[str, Any]) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(cache), encoding="utf-8")
    except OSError:
        logger.warning("Could not write market cap cache to %s", path)


class MarketCapClient:
    """Fetches and caches ticker market caps from Financial Modeling Prep."""

    def __init__(
        self,
        *,
        cache_path: Optional[Path] = None,
        api_key: Optional[str] = None,
    ) -> None:
        self._cache_path = cache_path or _default_cache_path()
        self._api_key = api_key or get_tool_credential("market_data", "FMP_API_KEY")
        self._cache = _load_cache(self._cache_path)

    def get_market_cap(self, ticker: str) -> Optional[float]:
        """Return the ticker's market cap in dollars, or None if unavailable.

        Serves from the 24h cache when fresh; falls back to a stale cache
        entry (rather than None) if a live fetch fails, so a transient API
        outage doesn't zero out an otherwise-known ticker's tier.
        """
        ticker = ticker.strip().upper()
        if not ticker:
            return None

        cached = self._cache.get(ticker)
        if cached and self._is_fresh(cached.get("fetched_at", "")):
            return cached.get("market_cap")

        if not self._api_key:
            return cached.get("market_cap") if cached else None

        market_cap = self._fetch(ticker)
        if market_cap is None:
            return cached.get("market_cap") if cached else None

        self._cache[ticker] = {
            "market_cap": market_cap,
            "fetched_at": datetime.now().isoformat(),
        }
        _save_cache(self._cache_path, self._cache)
        return market_cap

    def _is_fresh(self, fetched_at: str) -> bool:
        if not fetched_at:
            return False
        try:
            return datetime.now() - datetime.fromisoformat(fetched_at) < _CACHE_TTL
        except ValueError:
            return False

    def _fetch(self, ticker: str) -> Optional[float]:
        try:
            resp = httpx.get(
                _FMP_QUOTE_URL,
                params={"symbol": ticker, "apikey": self._api_key},
                timeout=10.0,
            )
            resp.raise_for_status()
            data = resp.json()
            if not data:
                return None
            market_cap = data[0].get("marketCap")
            return float(market_cap) if market_cap is not None else None
        except (httpx.HTTPError, IndexError, KeyError, ValueError, TypeError) as exc:
            logger.warning("Market cap lookup failed for %s: %s", ticker, exc)
            return None
