# Voice worker

Speaks Hermes's `speech` blocks (contract v1.1, hq decision 0009). It's a separate local process in its own
environment, so torch and the TTS engines stay out of the fork's core dependencies.

| Lane | Engine | Voice | Runs on |
|---|---|---|---|
| Expressive | Chatterbox 0.1.7, `cfg_weight` 0.5, `exaggeration` from the block's mood (neutral 0.5, upbeat 0.6, grave 0.45, dry 0.4) | conditioned on a Kokoro `bm_george` reference clip | GPU, behind the lease |
| Fast | Kokoro 0.9.4 | `bm_george` | CPU |

## What it does

- Every minute it reads `voice_queue` from the Hermes bridge and renders each block whose `id` has no audio yet.
  - `lane: fast` renders with Kokoro right away.
  - `lane: expressive` needs the **GPU lease**. The worker takes it only when `ollama ps` shows no model loaded,
    `nvidia-smi` shows at least 6 GB free, and no one else holds a fresh lease. It writes the lease atomically,
    renews `expires_at` (at most 10 minutes out) before every chunk, and deletes it when done or on any error.
    Hermes waits for the lease before any local-model call. **The worker never stops Ollama or unloads models.**
  - If the lease can't be taken for 20 minutes after a block appeared, the block is rendered on the fast lane,
    then upgraded when an expressive render lands.
- Text is split into chunks of at most 280 characters on sentence boundaries, joined with 0.25 s gaps, with a
  fixed seed (1234) per chunk. The reference conditionals are prepared once per load and restored before every
  chunk, because Chatterbox's `generate()` mutates `model.conds`.
- Chatterbox is loaded for a render batch and released (with the CUDA cache emptied) when the batch ends, so it
  never holds GPU memory while idle.
- Audio: `%LOCALAPPDATA%\openjarvis\voice\cache\<id>.wav` plus `index.json`, pruned after 14 days.
- **Watermark:** Chatterbox embeds Resemble AI's inaudible Perth watermark in everything it renders.

## The reference clip

It's generated, never committed: on first start (and whenever it's missing) the worker renders a fixed, neutral,
non-live passage with Kokoro `bm_george` at speed 1.0 into `%LOCALAPPDATA%\openjarvis\voice\voice_ref.wav`
(about 13 s). The passage is in `engines.py`.

## HTTP (127.0.0.1:8650 only)

- `GET /health`, `GET /status`
- `POST /speak {text}`: fast-lane WAV, up to 2,000 characters, not cached
- `POST /blocks/fast {id, text, ...}`: render one block on the fast lane into the cache (used for on-demand
  playback); expressive blocks are still upgraded by the loop

The OpenJarvis backend proxies these under `/api/voice/*`.

## Setup

1. Create the venv and install `requirements.txt` (commands at its top).
2. Register the task: `.\install_task.ps1 -LeasePath <path to the shared gpu\lease.json> [-VoiceName <label>]`.
   This writes `config.json` next to the cache (`lease_path`, and `voice_name`, the expressive voice's label in
   the UI) and starts the worker. Logs go to `%LOCALAPPDATA%\openjarvis\logs\voice-worker.log`.

Test flags: create an empty `fake_busy` file in the data folder (or set `OPENJARVIS_VOICE_FAKE_BUSY=1`) to make the
GPU look busy, and pass `--fallback-minutes` to shorten the fast-lane deadline.

## Voice input (phase 1: hotkey, conversation mode, barge-in)

A global hotkey starts a conversation that keeps listening turn after turn, with the app open or closed:

```
hotkey -> chime -> mic (16 kHz) -> Silero VAD -> faster-whisper small.en (int8, CPU) -> transcript
  -> local command (conversation.COMMANDS)          -> handled here, never sent to Hermes
  -> else Hermes's voice endpoint (stream, one X-Hermes-Session-Id per conversation)
  -> sentences as they complete -> Kokoro bm_george (fast lane) -> playback, sentence by sentence
```

- **Hotkeys:** Win32 `RegisterHotKey` via ctypes on a per-user thread (no admin, no extra package). Defaults:
  `ctrl+alt+space` toggles a conversation (and interrupts while the assistant speaks) and `ctrl+alt+m` toggles
  mute. If another app already owns a combo, the log says so; set a different one in `config.json`.
- **The mic is open only during a conversation.** It closes when the conversation ends: on "that's all",
  "thanks, <voice_name>", "stop listening", or "goodbye", on the hotkey or mute, or after 60 s of silence.
  Soft synthesized chimes mark the start and the end.
- **Endpointing:** 300 ms pre-roll; speech ends after 0.7 s of silence, or 1.2 s while the utterance is still
  short, so mid-sentence pauses don't cut it.
- **Barge-in (full duplex):** speech of at least 400 ms while a reply plays (after a 300 ms guard per sentence)
  stops playback, cancels the Hermes stream, and becomes the next turn. "go on" resumes from the next sentence
  already received. On a non-headset output device it falls back to half duplex (the mic is ignored while
  speaking; the hotkey interrupts).
- **Nothing is written to disk:** turns live in memory for the current conversation only. The per-turn
  latency log (end of speech -> transcript, -> first Hermes token, -> first audio; whether it was a local command,
  and barge-ins) has no transcript text.
- **API (127.0.0.1:8650):** `GET /voice/state`, `GET /voice/events` (SSE), `POST /voice/start`, `/voice/stop`,
  `/voice/mute`, `/voice/unmute`; the backend proxies them under `/api/voice/*`.
- **Machine-local `config.json` keys:** `voice_input` (default true), `hotkey_talk`, `hotkey_mute`,
  `duplex` (`auto` | `full` | `half`), `input_device` and `output_device` (name substrings; default = the
  system devices), and `voice_name` (used by the "thanks, <name>" command). The Hermes key is read at runtime
  from OpenJarvis's `credentials.toml` (`[hermes] HERMES_API_KEY`) and never logged.
