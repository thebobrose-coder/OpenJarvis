"""Voice conversation state machine (hq 0010 phase 1), everything mocked.
The persona name is configuration; tests use a neutral one ("Atlas")."""

from __future__ import annotations

import threading
from dataclasses import dataclass

import pytest

from openjarvis.voice_worker.conversation import (
    Conversation,
    Deps,
    SentenceSplitter,
    clean_for_speech,
    match_command,
    resolve_duplex,
)

NAME = "Atlas"


@dataclass
class Utt:
    audio: str
    ended_at: float = 0.0


class FakeListener:
    def __init__(self, script):
        self.script = list(script)
        self.closed = False
        self.playing_calls: list[bool] = []

    def next_utterance(self, timeout):
        return (
            Utt(self.script.pop(0))
            if self.script and self.script[0] is not None
            else (self.script.pop(0) if self.script else None)
        )

    def set_playing(self, playing):
        self.playing_calls.append(playing)

    def close(self):
        self.closed = True


class FakeStream:
    def __init__(self, chunks):
        self.chunks = chunks
        self.closed = False

    def __iter__(self):
        for c in self.chunks:
            if self.closed:
                return
            yield c

    def close(self):
        self.closed = True


class FakePlayer:
    def __init__(self, interrupt_on=()):
        self.played: list[str] = []
        self.interrupt_on = set(interrupt_on)

    def play(self, audio, interrupt: threading.Event) -> bool:
        self.played.append(audio)
        if audio in self.interrupt_on:
            self.interrupt_on.discard(audio)
            return False
        return True


def make(script, replies, interrupt_on=(), queue=()):
    listener = FakeListener(script)
    player = FakePlayer(interrupt_on)
    calls: dict = {"hermes": [], "streams": [], "chimes": [], "opened": []}
    replies = list(replies)

    def hermes(text, session_id):
        calls["hermes"].append((text, session_id))
        stream = FakeStream(replies.pop(0))
        calls["streams"].append(stream)
        return stream

    def open_listener(barge, duplex):
        calls["opened"].append(duplex)
        return listener

    deps = Deps(
        open_listener=open_listener,
        transcribe=lambda audio: audio,
        hermes=hermes,
        tts=lambda s: f"AUDIO:{s}",
        player=player,
        chime=lambda kind: calls["chimes"].append(kind),
        queue_audio=lambda: list(queue),
        voice_name=lambda: NAME,
        clock=lambda: 1.0,
    )
    return Conversation(deps, duplex="full"), listener, player, calls


# ---------- the loop ----------


def test_listen_transcribe_hermes_speak_listen_then_silence_ends():
    conv, listener, player, calls = make(
        ["How many are drafted?", None],
        [["Six are drafted. ", "The top one is ranked first."]],
    )
    conv.run()
    assert calls["hermes"][0][0] == "How many are drafted?"
    assert player.played == [
        "AUDIO:Six are drafted.",
        "AUDIO:The top one is ranked first.",
    ]
    assert conv.ended_reason == "silence"
    assert calls["chimes"] == ["start", "end"]
    assert listener.closed is True  # the mic closes with the conversation
    assert [t.role for t in conv.turns] == ["user", "assistant"]
    assert conv.state == "idle"
    assert (
        conv.metrics[0]["command"] == ""
        and conv.metrics[0]["first_audio_s"] is not None
    )


def test_same_session_id_across_turns_and_a_new_one_next_time():
    conv, _, _, calls = make(
        ["First question?", "Follow-up?", None], [["One."], ["Two."]]
    )
    conv.run()
    ids = {sid for _, sid in calls["hermes"]}
    assert len(ids) == 1 and conv.id in ids
    conv2, _, _, calls2 = make(["Another?", None], [["Three."]])
    conv2.run()
    assert calls2["hermes"][0][1] != conv.id


def test_barge_in_stops_playback_and_cancels_the_stream_then_go_on_resumes():
    conv, _, player, calls = make(
        ["Tell me everything.", "go on", None],
        [["First point. ", "Second point. ", "Third point."]],
        interrupt_on={"AUDIO:First point."},
    )
    conv.run()
    assert calls["streams"][0].closed is True
    assert conv.barge_ins == 1
    # "go on" resumes from the next sentence that had already arrived.
    assert player.played[0] == "AUDIO:First point."
    assert "AUDIO:First point." not in player.played[1:]
    assert player.played[1:] and set(player.played[1:]) <= {
        "AUDIO:Second point.",
        "AUDIO:Third point.",
    }
    assert len(calls["hermes"]) == 1  # "go on" is local, not sent to Hermes


def test_dismissal_ends_the_conversation_with_the_end_chime():
    conv, listener, _, calls = make(["thanks, Atlas!"], [])
    conv.run()
    assert conv.ended_reason == "dismissed"
    assert calls["hermes"] == []
    assert calls["chimes"] == ["start", "end"] and listener.closed


def test_repeat_replays_the_last_reply_locally():
    conv, _, player, calls = make(
        ["Question?", "repeat", None], [["Answer one. ", "Answer two."]]
    )
    conv.run()
    assert player.played == ["AUDIO:Answer one.", "AUDIO:Answer two."] * 2
    assert len(calls["hermes"]) == 1


def test_morning_briefing_plays_the_queue_and_next_skips():
    queue = [("Item A", "QA"), ("Item B", "QB"), ("Item C", "QC")]
    conv, _, player, calls = make(
        ["read me the morning", "next", None], [], interrupt_on={"QA"}, queue=queue
    )
    conv.run()
    assert player.played == ["QA", "QB", "QC"]
    assert calls["hermes"] == []


def test_stop_from_outside_ends_the_conversation():
    conv, listener, _, calls = make(["Question?", None], [["Answer."]])
    conv.stop("hotkey")
    conv.run()
    assert conv.ended_reason == "hotkey" and listener.closed
    assert calls["hermes"] == []


# ---------- the grammar ----------


@pytest.mark.parametrize(
    ("said", "intent"),
    [
        ("stop", "stop"),
        ("Pause.", "stop"),
        ("quiet", "stop"),
        ("go on", "resume"),
        ("Continue", "resume"),
        ("resume", "resume"),
        ("repeat", "repeat"),
        ("say that again", "repeat"),
        ("that's all", "end"),
        ("thanks Atlas", "end"),
        ("Thank you, Atlas.", "end"),
        ("stop listening", "end"),
        ("goodbye", "end"),
        ("thanks", "end"),
        ("read me the morning", "briefing"),
        ("Morning briefing", "briefing"),
        ("play the briefing", "briefing"),
        ("next", "next"),
        ("skip", "next"),
    ],
)
def test_each_command_row(said, intent):
    assert match_command(said, NAME) == intent


def test_only_short_utterances_are_commands():
    assert match_command("stop the sample campaign for the store now", NAME) is None
    assert match_command("what does stop mean here", NAME) is None
    assert (
        match_command("thanks Atlas", "") is None
    )  # no configured name, no name phrase
    assert match_command("", NAME) is None


# ---------- text and duplex ----------


def test_urls_and_markdown_are_stripped_before_tts():
    raw = (
        "**Top** prospect: see [the board](https://example.com/b) "
        "or https://example.com/x for `details`."
    )
    out = clean_for_speech(raw)
    assert "http" not in out and "*" not in out and "`" not in out
    assert "the board" in out and "link on screen" in out
    assert clean_for_speech("# Heading\n- item one") == "Heading\nitem one"


def test_sentence_splitter_on_streamed_chunks():
    sp = SentenceSplitter()
    out = []
    for chunk in ["Hel", "lo there. How", " are you? I'm", " fine"]:
        out += sp.feed(chunk)
    out += sp.flush()
    assert out == ["Hello there.", "How are you?", "I'm fine"]


@pytest.mark.parametrize(
    ("setting", "device", "expected"),
    [
        ("auto", "Headset Earphone (Sample Wireless)", "full"),
        ("auto", "Headphones (Sample Audio)", "full"),
        ("auto", "Sample Buds Pro", "full"),
        ("auto", "AirPods Pro", "full"),
        ("auto", "Hands-Free AG Audio (Sample)", "full"),
        ("auto", "Speakers (Realtek(R) Audio)", "half"),
        ("auto", "", "half"),
        ("half", "Headset Earphone", "half"),
        ("full", "Speakers", "full"),
    ],
)
def test_duplex_from_device_and_override(setting, device, expected):
    assert resolve_duplex(setting, device) == expected


def test_a_mic_that_wont_open_ends_with_the_error_tone_not_silence():
    conv, _, _, calls = make([], [])

    def broken(barge, duplex):
        raise OSError("device busy")

    conv.deps.open_listener = broken
    conv.run()
    assert calls["chimes"] == ["error"]
    assert conv.ended_reason == "error" and conv.state == "idle"


def test_first_sentence_is_split_at_a_clause_for_a_faster_first_clip():
    from openjarvis.voice_worker.conversation import split_first_clause

    long = (
        "There are six prospects in the drafted stage, "
        "and the top one ranks first this week."
    )
    assert split_first_clause(long) == [
        "There are six prospects in the drafted stage,",
        "and the top one ranks first this week.",
    ]
    assert split_first_clause("Six are drafted.") == ["Six are drafted."]
    assert split_first_clause(
        "A, b and then a long tail with no other clause break at all here."
    ) == ["A, b and then a long tail with no other clause break at all here."]


def test_only_the_first_sentence_of_a_reply_is_split():
    conv, _, player, _ = make(
        ["Question?", None],
        [
            [
                "There are six prospects in the drafted stage, ",
                "and the top one ranks first. ",
                "Second sentence, with a comma in it.",
            ]
        ],
    )
    conv.run()
    assert player.played == [
        "AUDIO:There are six prospects in the drafted stage,",
        "AUDIO:and the top one ranks first.",
        "AUDIO:Second sentence, with a comma in it.",
    ]
