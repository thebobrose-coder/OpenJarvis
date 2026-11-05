"""One clock for the server routes: parse a feed's time and age it.

Feeds carry ISO 8601 (``2026-10-28T03:51:13Z``), and some cloud rows (AWS
Health) carry RFC 1123 (``Wed, 28 Oct 2026 03:51:13 GMT``). A time that
doesn't parse is ``None``: a row with no time has no age, and a notice with
no age never leaves its window. A naive time is read as UTC.
"""

from __future__ import annotations

from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any


def parse_time(value: Any) -> datetime | None:
    """ISO 8601 or RFC 1123 text (or a datetime) as an aware datetime."""
    if isinstance(value, datetime):
        t = value
    elif not isinstance(value, str) or not value.strip():
        return None
    else:
        text = value.strip()
        try:
            t = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            try:
                t = parsedate_to_datetime(text)
            except (TypeError, ValueError, IndexError):
                return None
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def age_seconds(value: Any, now: datetime | None = None) -> int | None:
    """Whole seconds since ``value`` (never negative), or None if it won't parse."""
    t = parse_time(value)
    if t is None:
        return None
    now = now or datetime.now(timezone.utc)
    return max(0, int((now - t).total_seconds()))
