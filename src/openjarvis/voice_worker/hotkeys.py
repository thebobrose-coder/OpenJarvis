"""System-wide hotkeys via Win32 RegisterHotKey (ctypes; no admin needed).

They are registered per user on a dedicated thread that runs a message
loop, so they work from any app, whether or not OpenJarvis is open.
"""

from __future__ import annotations

import ctypes
import logging
import sys
import threading
from ctypes import wintypes
from typing import Callable

logger = logging.getLogger("openjarvis.voice_worker")

MOD = {"alt": 0x0001, "ctrl": 0x0002, "control": 0x0002, "shift": 0x0004, "win": 0x0008}
MOD_NOREPEAT = 0x4000
WM_HOTKEY = 0x0312
NAMED_KEYS = {"space": 0x20, "enter": 0x0D, "esc": 0x1B, "tab": 0x09}


def parse(combo: str) -> tuple[int, int]:
    """ "ctrl+alt+space" -> (modifiers, virtual-key code)."""
    parts = [p.strip().lower() for p in combo.split("+") if p.strip()]
    if not parts:
        raise ValueError("empty hotkey")
    mods = 0
    for p in parts[:-1]:
        if p not in MOD:
            raise ValueError(f"unknown modifier {p!r}")
        mods |= MOD[p]
    key = parts[-1]
    if key in NAMED_KEYS:
        vk = NAMED_KEYS[key]
    elif len(key) == 1 and key.isalnum():
        vk = ord(key.upper())
    elif key.startswith("f") and key[1:].isdigit():
        vk = 0x70 + int(key[1:]) - 1
    else:
        raise ValueError(f"unknown key {key!r}")
    return mods | MOD_NOREPEAT, vk


class Hotkeys:
    def __init__(self, bindings: dict[str, Callable[[], None]]) -> None:
        self.bindings = bindings  # combo -> callback
        self.registered: list[str] = []
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if sys.platform != "win32":
            logger.warning("Global hotkeys are only implemented on Windows")
            return
        self._thread = threading.Thread(target=self._loop, name="hotkeys", daemon=True)
        self._thread.start()

    def _loop(self) -> None:
        user32 = ctypes.windll.user32
        callbacks: dict[int, Callable[[], None]] = {}
        for i, (combo, cb) in enumerate(self.bindings.items(), start=1):
            try:
                mods, vk = parse(combo)
            except ValueError as exc:
                logger.error("Bad hotkey %r: %s", combo, exc)
                continue
            if user32.RegisterHotKey(None, i, mods, vk):
                callbacks[i] = cb
                self.registered.append(combo)
            else:
                logger.error(
                    "Could not register hotkey %r (in use by another app?)", combo
                )
        logger.info("Hotkeys registered: %s", ", ".join(self.registered) or "none")
        msg = wintypes.MSG()
        while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
            if msg.message == WM_HOTKEY and msg.wParam in callbacks:
                try:
                    callbacks[msg.wParam]()
                except Exception:  # noqa: BLE001 -- a callback must not kill the loop
                    logger.exception("Hotkey callback failed")
