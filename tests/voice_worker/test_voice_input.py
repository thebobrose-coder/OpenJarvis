"""Voice input manager: hotkey toggle, interrupt, mute, state and events
(conversation mocked), plus hotkey parsing."""

from __future__ import annotations

import json
import threading
import time

import pytest

from openjarvis.voice_worker.hotkeys import MOD_NOREPEAT, parse
from openjarvis.voice_worker.voice_input import VoiceInput


class FakeConversation:
    count = 0

    def __init__(self, on_change):
        FakeConversation.count += 1
        self.id = f"conv-{FakeConversation.count}"
        self.state = "listening"
        self.turns = []
        self.stopped_with = None
        self.interrupted = 0
        self._stop = threading.Event()
        self._on_change = on_change

    def run(self):
        self._on_change()
        self._stop.wait(5)
        self.state = "idle"

    def stop(self, reason="stopped"):
        self.stopped_with = reason
        self._stop.set()

    def interrupt(self):
        self.interrupted += 1


@pytest.fixture
def vi():
    made: list[FakeConversation] = []

    def make(on_change):
        c = FakeConversation(on_change)
        made.append(c)
        return c

    v = VoiceInput(make, duplex="full", device="Sample Headset")
    v.made = made
    yield v
    v.stop()
    v.wait(2)


def _wait_active(v, active=True):
    for _ in range(100):
        if v.active() == active:
            return
        time.sleep(0.01)


def test_hotkey_toggles_a_conversation_on_and_off(vi):
    vi.toggle()
    _wait_active(vi)
    assert vi.active() and vi.state()["state"] == "listening"
    conv_id = vi.state()["conversation_id"]
    assert conv_id
    vi.toggle()
    vi.wait(2)
    assert not vi.active()
    assert vi.made[0].stopped_with == "hotkey"
    assert vi.state()["state"] == "idle" and vi.state()["conversation_id"] is None
    vi.toggle()
    _wait_active(vi)
    assert vi.state()["conversation_id"] != conv_id  # a new conversation each time


def test_hotkey_while_speaking_interrupts_instead_of_ending(vi):
    vi.toggle()
    _wait_active(vi)
    vi.made[0].state = "speaking"
    vi.toggle()
    assert vi.made[0].interrupted == 1 and vi.active()


def test_mute_ends_the_conversation_and_blocks_starts_until_unmuted(vi):
    vi.start()
    _wait_active(vi)
    vi.mute()
    vi.wait(2)
    assert vi.made[0].stopped_with == "muted"
    assert vi.state()["state"] == "muted"
    assert vi.start() is False and len(vi.made) == 1
    vi.toggle_mute()
    assert vi.state()["state"] == "idle"
    assert vi.start() is True


def test_events_publish_state_changes(vi):
    q = vi.subscribe()
    first = json.loads(q.get(timeout=1))
    assert (
        first["state"] == "idle"
        and first["duplex"] == "full"
        and first["device"] == "Sample Headset"
    )
    vi.start()
    seen = json.loads(q.get(timeout=2))
    assert seen["state"] in ("listening", "idle")
    vi.unsubscribe(q)


@pytest.mark.parametrize(
    ("combo", "vk", "mods"),
    [
        ("ctrl+alt+space", 0x20, 0x0001 | 0x0002),
        ("Ctrl+Alt+M", ord("M"), 0x0001 | 0x0002),
        ("shift+f9", 0x78, 0x0004),
    ],
)
def test_hotkey_parsing(combo, vk, mods):
    assert parse(combo) == (mods | MOD_NOREPEAT, vk)


def test_bad_hotkeys_are_rejected():
    for bad in ("", "ctrl+", "hyper+x", "ctrl+alt+volumeup"):
        with pytest.raises(ValueError):
            parse(bad)
