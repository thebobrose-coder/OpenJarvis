"""BreakingAlertStore -- SQLite-backed storage for breaking_news_monitor
alerts, so the dashboard/sidebar can show the latest one instead of only
delivering alerts via Telegram. Deliberately separate from DigestStore:
digests are one-per-category-per-day on a schedule, while breaking alerts
are sparse and event-driven (the whole point of the operator is that most
of its 15-minute cycles produce nothing)."""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Optional

from openjarvis.core.paths import get_config_dir


@dataclass
class BreakingAlert:
    """A single breaking-news alert the operator judged worth surfacing."""

    headline: str
    summary: str
    url: str
    audio_path: Path
    alerted_at: datetime


class BreakingAlertStore:
    """SQLite store for breaking news alerts -- only ever queried for the
    single latest row; history isn't surfaced anywhere today, but is kept
    so nothing is thrown away."""

    def __init__(self, db_path: str = "") -> None:
        if not db_path:
            db_path = str(get_config_dir() / "breaking_alerts.db")
        self._db_path = db_path
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS breaking_alerts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                headline TEXT NOT NULL,
                summary TEXT NOT NULL,
                url TEXT NOT NULL,
                audio_path TEXT NOT NULL,
                alerted_at TEXT NOT NULL
            )
            """
        )
        self._conn.commit()

    def save(self, alert: BreakingAlert) -> None:
        self._conn.execute(
            """
            INSERT INTO breaking_alerts (headline, summary, url, audio_path, alerted_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                alert.headline,
                alert.summary,
                alert.url,
                str(alert.audio_path),
                alert.alerted_at.isoformat(),
            ),
        )
        self._conn.commit()

    def get_latest(self) -> Optional[BreakingAlert]:
        row = self._conn.execute(
            "SELECT headline, summary, url, audio_path, alerted_at"
            " FROM breaking_alerts ORDER BY id DESC LIMIT 1"
        ).fetchone()
        if row is None:
            return None
        return BreakingAlert(
            headline=row[0],
            summary=row[1],
            url=row[2],
            audio_path=Path(row[3]),
            alerted_at=datetime.fromisoformat(row[4]),
        )

    def close(self) -> None:
        self._conn.close()
