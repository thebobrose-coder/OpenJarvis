"""Hermes-owned digests: feed locations and the "today" rule.

Hermes generates the general and culture digests and publishes them at
`/panels/digest_<category>` on the local bridge (contract
hq/contracts/openjarvis-hermes.md v0.4 §2). The dashboard routes proxy them
(server/digest_routes.py); the CLI and the chat intent route read them
synchronously through `fetch_today_text`.
"""

from __future__ import annotations

import os
from datetime import datetime
from zoneinfo import ZoneInfo

import httpx

HERMES_DIGEST_URLS = {
    "general": os.environ.get(
        "HERMES_DIGEST_GENERAL_URL", "http://127.0.0.1:8643/panels/digest_general"
    ),
    "culture": os.environ.get(
        "HERMES_DIGEST_CULTURE_URL", "http://127.0.0.1:8643/panels/digest_culture"
    ),
}
# Hermes generates at 06:00 Central, so "today" is a Central calendar day.
HERMES_TZ = ZoneInfo("America/Chicago")
HERMES_SCHEDULE = {"cron": "0 6 * * *", "timezone": "America/Chicago"}
_TIMEOUT_S = 10.0


def feed_time(payload: dict) -> datetime:
    return datetime.fromisoformat(payload["generated_at"].replace("Z", "+00:00"))


def is_today(payload: dict) -> bool:
    return feed_time(payload).astimezone(HERMES_TZ).date() == (
        datetime.now(HERMES_TZ).date()
    )


def fetch_today_text(category: str = "general") -> str | None:
    """Today's Hermes digest text, or None if Hermes has none for today.

    Raises httpx.HTTPError when the bridge is unreachable or errors.
    """
    resp = httpx.get(HERMES_DIGEST_URLS[category], timeout=_TIMEOUT_S)
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    payload = resp.json()
    return payload["data"]["text"] if is_today(payload) else None
