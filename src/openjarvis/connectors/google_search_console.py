"""Google Search Console connector -- query/click/impression/position data
via the Search Console API (webmasters.readonly scope, folded into the
shared Google OAuth bundle -- see connectors/oauth.py GOOGLE_ALL_SCOPES).

Uses the shared google.json credentials file via resolve_google_credentials(),
same minimal pattern as google_tasks.py: no custom auth_url()/handle_callback(),
the generic /oauth/start -> /oauth/callback flow (connectors_router.py) covers
this connector automatically once it's listed in the "google" OAuthProvider's
connector_ids/credential_files.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, Iterator, Optional
from urllib.parse import quote

import httpx

from openjarvis.connectors._stubs import BaseConnector, Document, SyncStatus
from openjarvis.connectors.google_auth import call_with_refresh
from openjarvis.connectors.oauth import load_tokens, resolve_google_credentials
from openjarvis.core.config import DEFAULT_CONFIG_DIR
from openjarvis.core.registry import ConnectorRegistry

_GSC_API_BASE = "https://www.googleapis.com/webmasters/v3"
_DEFAULT_CREDENTIALS_PATH = str(
    DEFAULT_CONFIG_DIR / "connectors" / "google_search_console.json"
)


class GoogleSearchConsoleAPIError(RuntimeError):
    """A Search Console API error, with Google's own message preserved."""


def _gsc_api_search_analytics(
    token: str, site_url: str, *, days: int
) -> Dict[str, Any]:
    """Call searchAnalytics.query for the last *days* days, grouped by query.

    Deliberately lets httpx.HTTPStatusError propagate unmodified (not
    caught/converted here) -- call_with_refresh specifically catches that
    exact exception type to detect a 401 and retry after refreshing the
    access token. Converting it to a different exception type here (as an
    earlier version of this function did) silently broke that retry: a
    routinely-expired access token surfaced as a hard "invalid credentials"
    failure instead of transparently refreshing, since call_with_refresh's
    `except httpx.HTTPStatusError` clause never saw the substituted
    exception. The nice Google-error-message extraction now happens one
    level up, in fetch_search_analytics, after any refresh+retry has
    already had its chance.
    """
    end = datetime.now().date()
    start = end - timedelta(days=days)
    resp = httpx.post(
        f"{_GSC_API_BASE}/sites/{quote(site_url, safe='')}/searchAnalytics/query",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "startDate": start.isoformat(),
            "endDate": end.isoformat(),
            "dimensions": ["query"],
            "rowLimit": 25,
        },
        timeout=30.0,
    )
    resp.raise_for_status()
    return resp.json()


@ConnectorRegistry.register("google_search_console")
class GoogleSearchConsoleConnector(BaseConnector):
    """Read-only Search Console query performance for a verified property."""

    connector_id = "google_search_console"
    display_name = "Google Search Console"
    auth_type = "oauth"

    def __init__(self, *, credentials_path: str = "") -> None:
        self._credentials_path = resolve_google_credentials(
            credentials_path or _DEFAULT_CREDENTIALS_PATH
        )
        self._status = SyncStatus()

    def is_connected(self) -> bool:
        tokens = load_tokens(self._credentials_path)
        if tokens is None:
            return False
        return bool(tokens.get("access_token") or tokens.get("token"))

    def disconnect(self) -> None:
        p = Path(self._credentials_path)
        if p.exists():
            p.unlink()

    def fetch_search_analytics(
        self, site_url: str, *, days: int = 28
    ) -> Dict[str, Any]:
        """Return top queries (clicks/impressions/ctr/position) for *site_url*.

        ``site_url`` must exactly match a verified Search Console property --
        either a URL-prefix property (e.g. "https://shop.example.com/") or a
        domain property ("sc-domain:example.com").
        """
        try:
            data = call_with_refresh(
                _gsc_api_search_analytics,
                self._credentials_path,
                site_url,
                days=days,
            )
        except httpx.HTTPStatusError as exc:
            # Reached only if call_with_refresh's own 401-refresh-retry
            # either didn't apply (non-401) or was exhausted (refresh
            # succeeded but the retried call still failed, or refresh
            # itself failed and raised past this). Surface Google's actual
            # error body -- httpx's default message is just "403 Forbidden
            # for url ...", dropping the detail that distinguishes
            # insufficient scope vs. API-not-enabled vs. missing property
            # permission, three very different fixes.
            try:
                detail = exc.response.json().get("error", {}).get("message", exc.response.text)
            except Exception:
                detail = exc.response.text
            raise GoogleSearchConsoleAPIError(
                f"Search Console API returned {exc.response.status_code}: {detail}"
            ) from None
        rows = data.get("rows", [])
        queries = [
            {
                "query": row["keys"][0],
                "clicks": row.get("clicks", 0),
                "impressions": row.get("impressions", 0),
                "ctr": row.get("ctr", 0.0),
                "position": row.get("position", 0.0),
            }
            for row in rows
        ]
        total_clicks = sum(q["clicks"] for q in queries)
        total_impressions = sum(q["impressions"] for q in queries)
        avg_position = (
            sum(q["position"] * q["impressions"] for q in queries) / total_impressions
            if total_impressions
            else 0.0
        )
        return {
            "top_queries": queries,
            "total_clicks": total_clicks,
            "total_impressions": total_impressions,
            "avg_position": round(avg_position, 1),
        }

    def sync(
        self, *, since: Optional[datetime] = None, cursor: Optional[str] = None
    ) -> Iterator[Document]:
        # No RAG/search participation -- this connector exists only to feed
        # the Store Performance panel, same as WeatherConnector/ShopifyConnector.
        self._status.state = "idle"
        self._status.last_sync = datetime.now()
        return iter(())

    def sync_status(self) -> SyncStatus:
        return self._status
