"""Tests for create_digest_router after the local digest pipeline's retirement.

General and culture proxy Hermes (see test_digest_hermes_routes.py). Wave 4
removed weather, the last locally generated category, so any other category
is refused.
"""

from __future__ import annotations

import pytest

pytest.importorskip("fastapi", reason="openjarvis[server] not installed")


@pytest.mark.parametrize("category", ["weather", "soccer", "unknown"])
def test_local_categories_are_refused(tmp_path, category):
    from openjarvis.server.digest_routes import create_digest_router

    with pytest.raises(ValueError):
        create_digest_router(db_path=str(tmp_path / "digest.db"), category=category)


def test_schedule_endpoints_only_on_general(tmp_path):
    from openjarvis.server.digest_routes import create_digest_router

    general = create_digest_router(db_path=str(tmp_path / "digest.db"))
    culture = create_digest_router(
        db_path=str(tmp_path / "digest.db"),
        category="culture",
        prefix="/api/digest/culture",
    )
    assert "/api/digest/schedule" in {r.path for r in general.routes}
    assert "/api/digest/culture/schedule" not in {r.path for r in culture.routes}
