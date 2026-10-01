"""Voice input manager (hq decision 0010, phase 1): one conversation at a
time, started and ended by the hotkey or the UI, with mute. Holds the live
state and this conversation's turns in memory only (nothing is written to
disk), and publishes changes to SSE subscribers."""

from __future__ import annotations

import json
import logging
import queue
import threading
from typing import Any, Callable

logger = logging.getLogger("openjarvis.voice_worker")


class VoiceInput:
    def __init__(
        self,
        make_conversation: Callable[[Callable[[], None]], Any],
        duplex: str,
        device: str,
    ) -> None:
        self._make = make_conversation  # (on_change) -> Conversation
        self.duplex = duplex
        self.device = device
        self.muted = False
        self.conversation: Any = None
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()
        self._subscribers: list[queue.Queue[str]] = []
        self.last_turns: list[dict[str, str]] = []

    # ---------- state ----------
    def state(self) -> dict[str, Any]:
        conv = self.conversation
        active = (
            conv is not None and self._thread is not None and self._thread.is_alive()
        )
        return {
            "state": "muted" if self.muted else (conv.state if active else "idle"),
            "conversation_id": conv.id if active else None,
            "duplex": self.duplex,
            "device": self.device,
            "turns": [t.as_dict() for t in conv.turns]
            if conv is not None
            else self.last_turns,
        }

    def _publish(self) -> None:
        event = json.dumps(self.state())
        for q in list(self._subscribers):
            try:
                q.put_nowait(event)
            except queue.Full:
                pass

    def subscribe(self) -> "queue.Queue[str]":
        q: queue.Queue[str] = queue.Queue(maxsize=100)
        self._subscribers.append(q)
        q.put_nowait(json.dumps(self.state()))
        return q

    def unsubscribe(self, q: "queue.Queue[str]") -> None:
        if q in self._subscribers:
            self._subscribers.remove(q)

    # ---------- control ----------
    def active(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def start(self) -> bool:
        with self._lock:
            if self.muted or self.active():
                return False
            self.conversation = self._make(self._publish)
            self._thread = threading.Thread(
                target=self._run, args=(self.conversation,), daemon=True
            )
            self._thread.start()
            return True

    def _run(self, conv: Any) -> None:
        try:
            conv.run()
        except Exception:  # noqa: BLE001
            logger.exception("Voice conversation failed")
        finally:
            self.last_turns = [t.as_dict() for t in conv.turns]
            self._publish()

    def stop(self, reason: str = "stopped") -> None:
        conv = self.conversation
        if conv is not None and self.active():
            conv.stop(reason)

    def toggle(self) -> None:
        """The talk hotkey: start a conversation, or end the current one.
        While the assistant is speaking it interrupts instead (the half-duplex
        interrupt); a second press then ends the conversation."""
        conv = self.conversation
        if not self.active():
            self.start()
        elif conv.state == "speaking":
            conv.interrupt()
        else:
            self.stop("hotkey")
        self._publish()

    def mute(self) -> None:
        """Mic off, and any conversation ends."""
        self.muted = True
        self.stop("muted")
        self._publish()

    def unmute(self) -> None:
        self.muted = False
        self._publish()

    def toggle_mute(self) -> None:
        self.unmute() if self.muted else self.mute()

    def wait(self, timeout: float | None = None) -> None:
        if self._thread is not None:
            self._thread.join(timeout)
