"""ShopifySnapshotStore -- SQLite-backed daily catalog snapshots, so the
Store Performance panel can diff today's live catalog against yesterday's
(new listings, price changes, stockouts) without a separate scheduled job.
One row per (store, calendar day); a second save for the same store/day
overwrites. Multi-store: store_slug is part of the primary key so each
store's snapshots never collide with another's."""

from __future__ import annotations

import json
import sqlite3
from typing import Any, Dict, List, Optional

from openjarvis.core.paths import get_config_dir


class ShopifySnapshotStore:
    def __init__(self, db_path: str = "") -> None:
        if not db_path:
            db_path = str(get_config_dir() / "shopify_snapshots.db")
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS snapshots (
                store_slug TEXT NOT NULL,
                date TEXT NOT NULL,
                catalog_json TEXT NOT NULL,
                PRIMARY KEY (store_slug, date)
            )
            """
        )
        self._conn.commit()

    def save_snapshot(
        self, store_slug: str, date_str: str, catalog: List[Dict[str, Any]]
    ) -> None:
        self._conn.execute(
            "INSERT OR REPLACE INTO snapshots (store_slug, date, catalog_json) VALUES (?, ?, ?)",
            (store_slug, date_str, json.dumps(catalog)),
        )
        self._conn.commit()

    def get_snapshot(
        self, store_slug: str, date_str: str
    ) -> Optional[List[Dict[str, Any]]]:
        row = self._conn.execute(
            "SELECT catalog_json FROM snapshots WHERE store_slug = ? AND date = ?",
            (store_slug, date_str),
        ).fetchone()
        if row is None:
            return None
        return json.loads(row[0])

    def close(self) -> None:
        self._conn.close()
