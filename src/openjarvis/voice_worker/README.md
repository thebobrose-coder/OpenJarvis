# Voice worker

Speaks Hermes's `speech` blocks (contract v1.1, hq decision 0009). It's a separate local process in its own
environment, so torch and the TTS engines stay out of the fork's core dependencies.

| Lane | Engine | Voice | Runs on |
|---|---|---|---|
| Expressive ("Erebus") | Chatterbox 0.1.7, `cfg_weight` 0.5, `exaggeration` from the block's mood (neutral 0.5, upbeat 0.6, grave 0.45, dry 0.4) | conditioned on a Kokoro `bm_george` reference clip | GPU, behind the lease |
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
  fixed seed (1234) per chunk. The Erebus conditionals are prepared once per load and restored before every
  chunk, because Chatterbox's `generate()` mutates `model.conds`.
- Chatterbox is loaded for a render batch and released (with the CUDA cache emptied) when the batch ends, so it
  never holds GPU memory while idle.
- Audio: `%LOCALAPPDATA%\openjarvis\voice\cache\<id>.wav` plus `index.json`, pruned after 14 days.
- **Watermark:** Chatterbox embeds Resemble AI's inaudible Perth watermark in everything it renders.

## The Erebus reference clip

It's generated, never committed: on first start (and whenever it's missing) the worker renders a fixed, neutral,
non-live passage with Kokoro `bm_george` at speed 1.0 into `%LOCALAPPDATA%\openjarvis\voice\erebus_ref.wav`
(about 13 s). The passage is in `engines.py`.

## HTTP (127.0.0.1:8650 only)

- `GET /health`, `GET /status`
- `POST /speak {text}`: fast-lane WAV, up to 2,000 characters, not cached
- `POST /blocks/fast {id, text, ...}`: render one block on the fast lane into the cache (used for on-demand
  playback); expressive blocks are still upgraded by the loop

The OpenJarvis backend proxies these under `/api/voice/*`.

## Setup

1. Create the venv and install `requirements.txt` (commands at its top).
2. Register the task: `.\install_task.ps1 -LeasePath <path to the shared gpu\lease.json>`. This writes
   `config.json` next to the cache and starts the worker. Logs go to `%LOCALAPPDATA%\openjarvis\logs\voice-worker.log`.

Test flags: create an empty `fake_busy` file in the data folder (or set `OPENJARVIS_VOICE_FAKE_BUSY=1`) to make the
GPU look busy, and pass `--fallback-minutes` to shorten the fast-lane deadline.
