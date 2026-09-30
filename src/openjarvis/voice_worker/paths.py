"""Where the voice worker keeps its files (stdlib only; shared with the backend)."""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

WORKER_URL = os.environ.get("OPENJARVIS_VOICE_URL", "http://127.0.0.1:8650")
BLOCK_ID = re.compile(r"^[0-9a-f]{16}$")


def data_dir() -> Path:
    override = os.environ.get("OPENJARVIS_VOICE_DIR")
    if override:
        return Path(override)
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / ".local" / "share")
    return Path(base) / "openjarvis" / "voice"


def cache_dir() -> Path:
    return data_dir() / "cache"


def index_path() -> Path:
    return cache_dir() / "index.json"


def logs_dir() -> Path:
    return data_dir().parent / "logs"


def reference_path() -> Path:
    return data_dir() / "erebus_ref.wav"


def config() -> dict[str, Any]:
    """Machine-local settings (``config.json`` in the data folder, written by
    install_task.ps1). Kept out of the repo: the lease path is private."""
    try:
        data = json.loads((data_dir() / "config.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def lease_path() -> Path:
    """The GPU lease shared with Hermes: OPENJARVIS_GPU_LEASE, else
    config.json's ``lease_path``. The fallback only suits a machine without
    Hermes."""
    override = os.environ.get("OPENJARVIS_GPU_LEASE") or config().get("lease_path")
    return Path(override) if override else data_dir() / "gpu" / "lease.json"


def read_index(path: Path | None = None) -> dict[str, dict[str, Any]]:
    """The cache index: id -> {lane, engine, duration, rendered_at, upgraded, ...}."""
    p = path or index_path()
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def cached_audio(block_id: str) -> tuple[Path, dict[str, Any]] | None:
    """The cached WAV and its index entry for a block id, if rendered."""
    if not BLOCK_ID.match(block_id or ""):
        return None
    entry = read_index().get(block_id)
    wav = cache_dir() / f"{block_id}.wav"
    if entry and wav.exists():
        return wav, entry
    return None
