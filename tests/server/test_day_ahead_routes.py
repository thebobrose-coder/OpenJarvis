"""Tests for /api/day-ahead."""

from __future__ import annotations

from datetime import datetime, timedelta
from unittest.mock import MagicMock, patch

import pytest

pytest.importorskip("fastapi", reason="openjarvis[server] not installed")

from openjarvis.connectors._stubs import Document


def _make_app():
    from fastapi import FastAPI

    from openjarvis.server.day_ahead_routes import day_ahead_router

    app = FastAPI()
    app.include_router(day_ahead_router)
    return app


def test_day_ahead_no_connectors_connected():
    from fastapi.testclient import TestClient

    app = _make_app()
    client = TestClient(app)

    with patch(
        "openjarvis.server.day_ahead_routes._connected_connector",
        return_value=None,
    ):
        resp = client.get("/api/day-ahead")

    assert resp.status_code == 200
    data = resp.json()
    assert data["events"] == []
    assert data["tasks"] == []
    assert data["calendar_connected"] is False
    assert data["tasks_connected"] is False


def test_day_ahead_returns_events_within_24h_window():
    from fastapi.testclient import TestClient

    app = _make_app()
    client = TestClient(app)

    now = datetime.now()
    in_window = Document(
        doc_id="cal-1",
        source="gcalendar",
        doc_type="event",
        content="",
        title="Team standup",
        timestamp=now + timedelta(hours=2),
    )
    beyond_window = Document(
        doc_id="cal-2",
        source="gcalendar",
        doc_type="event",
        content="",
        title="Next week's review",
        timestamp=now + timedelta(hours=48),
    )
    mock_calendar = MagicMock()
    mock_calendar.sync.return_value = [in_window, beyond_window]

    def fake_connector(connector_id):
        return mock_calendar if connector_id == "gcalendar" else None

    with patch(
        "openjarvis.server.day_ahead_routes._connected_connector",
        side_effect=fake_connector,
    ):
        resp = client.get("/api/day-ahead")

    data = resp.json()
    assert data["calendar_connected"] is True
    assert len(data["events"]) == 1
    assert data["events"][0]["title"] == "Team standup"


def test_day_ahead_filters_out_completed_tasks():
    from fastapi.testclient import TestClient

    app = _make_app()
    client = TestClient(app)

    open_task = Document(
        doc_id="task-1",
        source="google_tasks",
        doc_type="task",
        content="",
        title="Renew passport",
        metadata={"status": "needsAction"},
    )
    done_task = Document(
        doc_id="task-2",
        source="google_tasks",
        doc_type="task",
        content="",
        title="Already done",
        metadata={"status": "completed"},
    )
    mock_tasks = MagicMock()
    mock_tasks.sync.return_value = [open_task, done_task]

    def fake_connector(connector_id):
        return mock_tasks if connector_id == "google_tasks" else None

    with patch(
        "openjarvis.server.day_ahead_routes._connected_connector",
        side_effect=fake_connector,
    ):
        resp = client.get("/api/day-ahead")

    data = resp.json()
    assert data["tasks_connected"] is True
    assert len(data["tasks"]) == 1
    assert data["tasks"][0]["title"] == "Renew passport"


def test_day_ahead_events_sorted_chronologically():
    from fastapi.testclient import TestClient

    app = _make_app()
    client = TestClient(app)

    now = datetime.now()
    later = Document(
        doc_id="cal-later",
        source="gcalendar",
        doc_type="event",
        content="",
        title="Later meeting",
        timestamp=now + timedelta(hours=5),
    )
    sooner = Document(
        doc_id="cal-sooner",
        source="gcalendar",
        doc_type="event",
        content="",
        title="Sooner meeting",
        timestamp=now + timedelta(hours=1),
    )
    mock_calendar = MagicMock()
    mock_calendar.sync.return_value = [later, sooner]

    def fake_connector(connector_id):
        return mock_calendar if connector_id == "gcalendar" else None

    with patch(
        "openjarvis.server.day_ahead_routes._connected_connector",
        side_effect=fake_connector,
    ):
        resp = client.get("/api/day-ahead")

    titles = [e["title"] for e in resp.json()["events"]]
    assert titles == ["Sooner meeting", "Later meeting"]


def test_day_ahead_sync_failure_does_not_break_response():
    from fastapi.testclient import TestClient

    app = _make_app()
    client = TestClient(app)

    broken_calendar = MagicMock()
    broken_calendar.sync.side_effect = RuntimeError("boom")

    def fake_connector(connector_id):
        return broken_calendar if connector_id == "gcalendar" else None

    with patch(
        "openjarvis.server.day_ahead_routes._connected_connector",
        side_effect=fake_connector,
    ):
        resp = client.get("/api/day-ahead")

    assert resp.status_code == 200
    assert resp.json()["events"] == []
