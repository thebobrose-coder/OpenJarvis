"""Read-through proxy for Hermes panel feeds: the one place a route reads one.

`GET /panels/<feed>` on the Hermes bridge returns
`{feed, generated_at, age_seconds, source_role, data}`; the proxy returns
`data` unchanged plus `generated_at`, `age_seconds` and `stale`. When the
bridge is down it serves the last good copy with `stale: true` (503 before
any copy exists); a bridge 404 ("not configured / no data yet") passes
through as 404.

- `HermesPanel` is one hub feed (wave 4: day_ahead, weather, approvals), with
  its own URL override and `refresh()`, which forwards
  `POST /panels/<feed>/refresh` (Hermes's hub-requests job picks it up within
  about 2 minutes).
- `FeedProxy` is a page's allowlisted set of feeds (`/api/commerce/<feed>`,
  `/api/content/<feed>`, ...). A feed given a TTL is answered from the last
  good copy for that long before the bridge is asked again (a feed Hermes
  writes once a day needs no bridge call per poll); every other feed reads
  through on every request.
"""

from __future__ import annotations

import os
import time
from collections.abc import Iterable, Mapping
from typing import Any

import httpx
from fastapi import HTTPException
from fastapi.responses import JSONResponse

from openjarvis.server._time import age_seconds, parse_time

_TIMEOUT_S = 10.0


def _bridge() -> str:
    return os.environ.get("HERMES_BRIDGE_URL", "http://127.0.0.1:8643").rstrip("/")


def _age(generated_at: str) -> int:
    return age_seconds(generated_at) or 0


async def _fetch(url: str, not_found: str) -> dict[str, Any]:
    """One feed document from the bridge. A 404 is ``not_found``; a document
    without an object ``data`` or a readable ``generated_at`` is a ValueError,
    like a bridge that is down (httpx.HTTPError)."""
    async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
        resp = await client.get(url)
    if resp.status_code == 404:
        raise HTTPException(status_code=404, detail=not_found)
    resp.raise_for_status()
    payload = resp.json()
    if (
        not isinstance(payload, dict)
        or not isinstance(payload.get("data"), dict)
        or parse_time(payload.get("generated_at")) is None
    ):
        raise ValueError("unusable feed document")
    return payload


def _shape(
    payload: dict[str, Any], stale: bool, age: int | None = None, keep_stale=False
) -> dict[str, Any]:
    data = payload["data"]
    generated_at = payload["generated_at"]
    return {
        **data,
        "generated_at": generated_at,
        "age_seconds": _age(generated_at) if age is None else age,
        # A feed whose document says ``stale`` itself (trading, v1.6) keeps it.
        "stale": bool(stale or (keep_stale and data.get("stale"))),
    }


def _bridge_age(payload: dict[str, Any]) -> int | None:
    try:
        return int(payload.get("age_seconds")) or None
    except (TypeError, ValueError):
        return None


class HermesPanel:
    def __init__(self, feed: str, url_env: str) -> None:
        self.feed = feed
        self.url_env = url_env
        self.last: dict[str, Any] | None = None

    @property
    def url(self) -> str:
        return os.environ.get(self.url_env) or f"{_bridge()}/panels/{self.feed}"

    async def get(self, not_found: str) -> dict[str, Any]:
        try:
            payload = await _fetch(self.url, not_found)
        except (httpx.HTTPError, ValueError):
            if self.last is None:
                raise HTTPException(
                    status_code=503, detail=f"Hermes {self.feed} feed unavailable"
                ) from None
            return _shape(self.last, stale=True)
        self.last = payload
        return _shape(payload, stale=False)

    async def refresh(self) -> JSONResponse:
        url = self.url.rstrip("/") + "/refresh"
        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
                resp = await client.post(url)
            resp.raise_for_status()
            body = resp.json()
        except (httpx.HTTPError, ValueError):
            raise HTTPException(
                status_code=503, detail=f"Hermes {self.feed} refresh unavailable"
            ) from None
        return JSONResponse(status_code=202, content=body)


class FeedProxy:
    """A router's allowlisted Hermes feeds behind one stale-copy cache."""

    def __init__(
        self,
        name: str,
        feeds: Iterable[str],
        *,
        ttl_s: Mapping[str, float] | None = None,
        keep_stale: bool = False,
    ) -> None:
        self.name = name
        self.feeds = frozenset(feeds)
        self.ttl_s = dict(ttl_s or {})
        self.keep_stale = keep_stale
        # feed -> last good bridge document; tests clear it between cases.
        self.cache: dict[str, dict[str, Any]] = {}
        self._fetched: dict[str, float] = {}

    async def get_feed(self, feed: str) -> dict[str, Any]:
        """Return one feed's latest document, unwrapped."""
        if feed not in self.feeds:
            raise HTTPException(status_code=404, detail=f"Unknown {self.name} feed")
        cached = self.cache.get(feed)
        ttl = self.ttl_s.get(feed, 0)
        if (
            cached is not None
            and ttl > 0
            and time.monotonic() - self._fetched.get(feed, float("-inf")) < ttl
        ):
            return _shape(cached, False, keep_stale=self.keep_stale)
        try:
            payload = await _fetch(f"{_bridge()}/panels/{feed}", "No data yet")
        except (httpx.HTTPError, ValueError):
            if cached is None:
                raise HTTPException(
                    status_code=503, detail="Hermes feed unavailable"
                ) from None
            return _shape(cached, True, keep_stale=self.keep_stale)
        self.cache[feed] = payload
        self._fetched[feed] = time.monotonic()
        return _shape(payload, False, _bridge_age(payload), self.keep_stale)
