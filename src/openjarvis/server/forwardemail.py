"""A thin client for Forward Email's outbound email API (hq decision 0018).

The Business Development page sends outreach on the operator's click through
`POST /v1/emails`, reads a mail's delivery status with `GET /v1/emails/:id`,
and checks the daily cap with `GET /v1/emails/limit`. Auth is Basic with the
API token as the username and an empty password.

The token is read from the file named by `FORWARDEMAIL_API_KEY_FILE`
(credentials.toml, `[bizdev]`) on each call, by this server process only. It
is never logged, never returned, and never sent anywhere but the API; nor is
a payload (it carries a prospect's address and the mail's text) ever logged.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import httpx

API_URL = "https://api.forwardemail.net/v1"
_TIMEOUT_S = 15.0


class ForwardEmailError(Exception):
    """A refused or failed call. `message` is safe to show: the API's own
    first line, never the payload or the token."""

    def __init__(self, status: int | None, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def read_token(path: str | Path) -> str:
    try:
        token = Path(path).expanduser().read_text(encoding="utf-8-sig").strip()
    except OSError:
        raise ForwardEmailError(None, "API key file could not be read") from None
    if not token:
        raise ForwardEmailError(None, "API key file is empty")
    return token


def _first_line(resp: httpx.Response) -> str:
    try:
        body = resp.json()
        text = (
            (body.get("message") or body.get("error")) if isinstance(body, dict) else ""
        )
    except ValueError:
        text = resp.text
    lines = str(text or "").strip().splitlines()
    return (lines[0].strip() if lines else f"HTTP {resp.status_code}")[:200]


class ForwardEmail:
    def __init__(self, token: str, *, base_url: str = API_URL) -> None:
        self._auth = httpx.BasicAuth(token, "")
        self._base = base_url.rstrip("/")

    async def _call(self, method: str, path: str, json: Any = None) -> dict:
        """One call; no retry on a 4xx, one retry on a 5xx or a timeout."""
        last: ForwardEmailError | None = None
        for _attempt in range(2):
            try:
                async with httpx.AsyncClient(timeout=_TIMEOUT_S, auth=self._auth) as c:
                    resp = await c.request(method, f"{self._base}{path}", json=json)
            except httpx.TimeoutException:
                last = ForwardEmailError(None, "Forward Email timed out")
                continue
            except httpx.HTTPError:
                raise ForwardEmailError(None, "Forward Email unreachable") from None
            if resp.status_code >= 500:
                last = ForwardEmailError(resp.status_code, _first_line(resp))
                continue
            if resp.status_code >= 400:
                raise ForwardEmailError(resp.status_code, _first_line(resp))
            try:
                body = resp.json()
            except ValueError:
                raise ForwardEmailError(resp.status_code, "Unreadable reply") from None
            return body if isinstance(body, dict) else {}
        assert last is not None
        raise last

    async def send(self, payload: dict) -> dict:
        """`{id, message_id, status}` for a queued mail."""
        body = await self._call("POST", "/emails", payload)
        return {
            "id": str(body.get("id") or body.get("_id") or ""),
            "message_id": body.get("messageId") or body.get("message_id"),
            "status": body.get("status"),
        }

    async def status(self, email_id: str) -> dict:
        body = await self._call("GET", f"/emails/{email_id}")
        return {
            "status": body.get("status"),
            "rejectedErrors": body.get("rejectedErrors") or [],
        }

    async def limit(self) -> dict:
        body = await self._call("GET", "/emails/limit")
        return {
            "count": int(body.get("count") or 0),
            "limit": int(body.get("limit") or 0),
        }
