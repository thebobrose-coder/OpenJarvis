"""install_task.ps1's config step: it sets its own keys and keeps the rest.

Runs the real script with ``-ConfigOnly`` against a temp data folder, under
every PowerShell on the machine (Windows PowerShell 5.1 and PowerShell 7
differ in JSON and encoding behaviour). Never touches the live config or task.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from openjarvis.voice_worker import paths

SCRIPT = Path(paths.__file__).with_name("install_task.ps1")
SHELLS = [exe for exe in ("powershell", "pwsh") if shutil.which(exe)]

pytestmark = pytest.mark.skipif(
    sys.platform != "win32" or not SHELLS, reason="needs Windows PowerShell"
)


def _install(shell: str, data_dir: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [
            shell,
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(SCRIPT),
            "-DataDir",
            str(data_dir),
            "-ConfigOnly",
            *args,
        ],
        capture_output=True,
        text=True,
        timeout=120,
    )


def _read(data_dir: Path) -> dict:
    raw = (data_dir / "config.json").read_bytes()
    assert not raw.startswith(b"\xef\xbb\xbf"), "the worker cannot read a BOM"
    return json.loads(raw.decode("utf-8"))


@pytest.mark.parametrize("shell", SHELLS)
def test_rerun_keeps_keys_the_installer_does_not_own(shell, tmp_path):
    existing = {
        "lease_path": r"X:\old\lease.json",
        "voice_name": "Narrator",
        "input_device": "Desk Mic",
        "duplex": "auto",
        "voice_input": True,
        "studio_dir": r"X:\studio\episodes",
    }
    (tmp_path / "config.json").write_text(json.dumps(existing), encoding="utf-8")

    done = _install(shell, tmp_path, "-LeasePath", r"X:\new\lease.json")

    assert done.returncode == 0, done.stderr
    assert _read(tmp_path) == {**existing, "lease_path": r"X:\new\lease.json"}


@pytest.mark.parametrize("shell", SHELLS)
def test_passed_values_replace_only_their_own_keys(shell, tmp_path):
    existing = {
        "lease_path": r"X:\old\lease.json",
        "voice_name": "Narrator",
        "hotkey_mute": "ctrl+alt+shift+m",
        "studio_dir": r"X:\studio\episodes",
    }
    (tmp_path / "config.json").write_text(json.dumps(existing), encoding="utf-8")

    done = _install(
        shell,
        tmp_path,
        "-LeasePath",
        r"X:\new\lease.json",
        "-VoiceName",
        "Reader",
        "-StudioDir",
        r"X:\studio\other",
    )

    assert done.returncode == 0, done.stderr
    assert _read(tmp_path) == {
        "lease_path": r"X:\new\lease.json",
        "voice_name": "Reader",
        "hotkey_mute": "ctrl+alt+shift+m",
        "studio_dir": r"X:\studio\other",
    }


@pytest.mark.parametrize("shell", SHELLS)
def test_fresh_install_writes_defaults_and_studio_dir(shell, tmp_path):
    data_dir = tmp_path / "voice"

    done = _install(
        shell,
        data_dir,
        "-LeasePath",
        r"X:\gpu\lease.json",
        "-StudioDir",
        r"X:\studio\episodes",
    )

    assert done.returncode == 0, done.stderr
    assert _read(data_dir) == {
        "lease_path": r"X:\gpu\lease.json",
        "voice_name": "Expressive",
        "studio_dir": r"X:\studio\episodes",
    }


@pytest.mark.parametrize("shell", SHELLS)
def test_fresh_install_without_studio_dir_leaves_the_lane_off(shell, tmp_path):
    done = _install(shell, tmp_path, "-LeasePath", r"X:\gpu\lease.json")

    assert done.returncode == 0, done.stderr
    assert "studio_dir" not in _read(tmp_path)


@pytest.mark.parametrize("shell", SHELLS)
def test_unreadable_config_stops_the_install_untouched(shell, tmp_path):
    broken = '{"studio_dir": "X:\\\\studio", '
    (tmp_path / "config.json").write_text(broken, encoding="utf-8")

    done = _install(shell, tmp_path, "-LeasePath", r"X:\gpu\lease.json")

    assert done.returncode != 0
    assert (tmp_path / "config.json").read_text(encoding="utf-8") == broken
