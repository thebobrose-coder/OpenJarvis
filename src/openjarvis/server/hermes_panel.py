"""Read-through proxy for a Hermes hub panel feed (wave 4: day_ahead, weather).

`GET /panels/<feed>` on the Hermes bridge returns
`{feed, generated_at, age_seconds, source_role, data}`; the proxy returns
`data` unchanged plus `generated_at`, `age_seconds` and `stale`. When the
bridge is down it serves the last good copy with `stale: true` (503 before
any copy exists); a bridge 404 ("not configured / no data yet") passes
through as 404. `refresh()` forwards `POST /panels/<feed>/refresh`, which
Hermes's hub-requests job picks up within about 2 minutes.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any

import httpx
from fastapi import HTTPException
from fastapi.responses import JSONResponse

_TIMEOUT_S = 10.0


def _bridge() -> str:
    return os.environ.get("HERMES_BRIDGE_URL", "http://127.0.0.1:8643").rstrip("/")


def _age(generated_at: str) -> int:
    ts = datetime.fromisoformat(generated_at.replace("Z", "+00:00"))
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return max(0, int((datetime.now(timezone.utc) - ts).total_seconds()))


class HermesPanel:
    def __init__(self, feed: str, url_env: str) -> None:
        self.feed = feed
        self.url_env = url_env
        self.last: dict[str, Any] | None = None

    @property
    def url(self) -> str:
        return os.environ.get(self.url_env) or f"{_bridge()}/panels/{self.feed}"

    def _shape(self, payload: dict[str, Any], stale: bool) -> dict[str, Any]:
        generated_at = payload["generated_at"]
        return {
            **payload["data"],
            "generated_at": generated_at,
            "age_seconds": _age(generated_at),
            "stale": stale,
        }

    async def get(self, not_found: str) -> dict[str, Any]:
        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
                resp = await client.get(self.url)
            if resp.status_code == 404:
                raise HTTPException(status_code=404, detail=not_found)
            resp.raise_for_status()
            payload = resp.json()
            if not isinstance(payload.get("data"), dict) or not payload.get(
                "generated_at"
            ):
                raise ValueError("unusable feed document")
        except (httpx.HTTPError, ValueError):
            if self.last is None:
                raise HTTPException(
                    status_code=503, detail=f"Hermes {self.feed} feed unavailable"
                ) from None
            return self._shape(self.last, stale=True)
        self.last = payload
        return self._shape(payload, stale=False)

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
