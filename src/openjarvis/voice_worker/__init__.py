"""Erebus voice worker (hq decision 0009, contract v1.1).

A separate local process, in its own environment, that speaks Hermes's
``speech`` blocks: an expressive lane (Chatterbox conditioned on a Kokoro
``bm_george`` reference, on the GPU, behind a lease shared with Hermes) and a
fast lane (Kokoro ``bm_george`` on the CPU). See README.md.

``core`` and ``paths`` are stdlib-only, so the OpenJarvis backend and its
tests can import them without torch; ``engines`` needs the worker venv.
"""
