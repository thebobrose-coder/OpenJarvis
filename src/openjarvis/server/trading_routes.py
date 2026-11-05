"""FastAPI routes for the Trading view -- a read-only proxy for Hermes's
``trading_status`` and ``trading_day`` feeds (hq/decisions/0014, contract
v1.6 "Trading").

The trader writes its own status export; Hermes publishes it unchanged with
no agent and no model call; these routes pass it through like
``bizdev_routes.py`` (``data`` unwrapped, tagged with ``generated_at`` /
``age_seconds`` / ``stale``, the last good copy served when the bridge is
down). **There are no POST routes here, and none may be added:** the view
shows and never acts (0014 D2; the ``trader/kill`` scope stays unbuilt).

``GET /api/trading/config`` returns whether the AWS approval page URL is
configured (``[trading] page_url`` in the machine-local ``config.toml``) and
the URL itself for the open-in-browser link. The URL is never in the repo or
in a feed.
"""

from __future__ import annotations

import os

from fastapi import APIRouter

from openjarvis.core.config import load_config
from openjarvis.server.hermes_panel import FeedProxy

trading_router = APIRouter(prefix="/api/trading", tags=["trading"])

HERMES_BRIDGE_URL = os.environ.get("HERMES_BRIDGE_URL", "http://127.0.0.1:8643").rstrip(
    "/"
)
_TIMEOUT_S = 10.0

FEEDS = frozenset({"trading_status", "trading_day"})

_feeds = FeedProxy("trading", FEEDS, keep_stale=True)
_cache = _feeds.cache


def page_url_from_config() -> str | None:
    """The approval page URL from ``[trading] page_url``, or None when unset
    or not an https URL (the link opens the system browser, so nothing else
    is ever handed to it)."""
    try:
        trading = getattr(load_config(), "trading", None)
        url = (getattr(trading, "page_url", "") or "").strip()
    except Exception:  # noqa: BLE001 - a broken config means "not set"
        return None
    if not url.lower().startswith("https://"):
        return None
    return url


@trading_router.get("/config")
async def get_config() -> dict:
    """Whether the AWS approval page URL is set, and the URL for the link."""
    url = page_url_from_config()
    return {"page_url_set": url is not None, "page_url": url}


get_feed = trading_router.get("/{feed}")(_feeds.get_feed)
