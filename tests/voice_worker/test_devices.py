"""Device lookup: WASAPI first, else MME; never WDM-KS or DirectSound."""

from __future__ import annotations

import sys
import types

import pytest


@pytest.fixture
def fake_sd(monkeypatch):
    apis = [
        {"name": "MME"},
        {"name": "Windows DirectSound"},
        {"name": "Windows WASAPI"},
        {"name": "Windows WDM-KS"},
    ]
    devices = [
        {
            "name": "Sample Mic (Sample Gear)",
            "hostapi": 3,
            "max_input_channels": 1,
            "max_output_channels": 0,
        },
        {
            "name": "Sample Mic (Sample Gear)",
            "hostapi": 1,
            "max_input_channels": 1,
            "max_output_channels": 0,
        },
        {
            "name": "Sample Mic (Sample Gear)",
            "hostapi": 0,
            "max_input_channels": 1,
            "max_output_channels": 0,
        },
        {
            "name": "Sample Mic (Sample Gear)",
            "hostapi": 2,
            "max_input_channels": 2,
            "max_output_channels": 0,
        },
        {
            "name": "Sample Headset (Sample Gear)",
            "hostapi": 3,
            "max_input_channels": 0,
            "max_output_channels": 2,
        },
        {
            "name": "Sample Headset (Sample Gear)",
            "hostapi": 0,
            "max_input_channels": 0,
            "max_output_channels": 8,
        },
    ]
    mod = types.SimpleNamespace(
        query_hostapis=lambda *a: apis, query_devices=lambda *a: devices
    )
    monkeypatch.setitem(sys.modules, "sounddevice", mod)
    return devices


def test_wasapi_first(fake_sd):
    from openjarvis.voice_worker.voice_io import find_device

    assert find_device("sample mic", "input") == 3


def test_mme_when_there_is_no_wasapi_and_never_wdm_ks(fake_sd):
    from openjarvis.voice_worker.voice_io import find_device

    # The headset only has WDM-KS and MME entries: MME, not the first (WDM-KS) match.
    assert find_device("Sample Headset", "output") == 5
    assert find_device("sample mic", "input", host_api="MME") == 2


def test_no_name_or_no_match_means_default(fake_sd):
    from openjarvis.voice_worker.voice_io import find_device

    assert find_device(None, "input") is None
    assert find_device("nothing like this", "input") is None


def test_listening_returns_promptly_when_stopped():
    import queue as q
    import threading
    import time

    import numpy as np

    from openjarvis.voice_worker.voice_io import MicListener

    mic = MicListener.__new__(MicListener)  # no real stream
    mic.vad = type("V", (), {"prob": lambda self, f: 0.0})()
    mic.barge = threading.Event()
    mic.frames = q.Queue()
    mic._carry = []
    mic.frames.put(np.zeros(512, dtype=np.float32))
    threading.Timer(0.2, mic.barge.set).start()
    t0 = time.monotonic()
    assert mic.next_utterance(timeout=60) is None
    assert time.monotonic() - t0 < 2
