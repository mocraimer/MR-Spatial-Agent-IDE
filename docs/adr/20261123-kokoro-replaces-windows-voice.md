# ADR: Kokoro-82M replaces the Windows voice for spoken answers

## Status
Accepted; supersedes [20261123-spoken-answers-made-on-the-pc-by-the-windows-voice](20261123-spoken-answers-made-on-the-pc-by-the-windows-voice.md): the Windows voice is now the fallback while Kokoro loads or if it fails

## Area
Spatial view

## Context
The Windows voice (System.Speech.Synthesis via PowerShell) works without setup but sounds
robotic and varies by Windows language pack. Kokoro-82M is a neural TTS model that runs fully
on-device at ~RTF 0.36 on a Ryzen 7 5800X3D, needs ~1.4 GB peak RAM, loads in ~6.7 s, and
produces 24kHz audio. The brief requires that spoken answers be natural and that the model run
locally with no network at run time. Kokoro-js 1.2.1 ships kokoro-82M-v1.0-ONNX (fp32) with
the "af_heart" voice that scores well on naturalness benchmarks.

The model runs in a worker thread so it never starves the 33ms Herdr poll. Sentence-by-sentence
streaming sends each sentence to the page as soon as it is synthesised, so the first phrase plays
within about one second of the full text being available.

The Windows voice stays as the fallback: while Kokoro loads at startup (~7 s) and if it ever
fails, the Windows voice speaks. The owner receives a headset notice and one log line on failure.

## Decision
Use Kokoro-82M "af_heart" fp32 as the default voice, running in a worker thread. Keep the
Windows voice as fallback. The model is downloaded once by `npm run view:setup` and loaded from
the view's data directory at run time; `env.allowRemoteModels = false` at run time. Sentences are
split before queuing so each is synthesised and played independently.

## Alternatives Considered
- **Windows voice only**: No change — robotic sound, latency depends on PowerShell start time.
- **Kokoro fp16**: Half the memory but fp32 is the most reliable ONNX variant in kokoro-js 1.2.1.
- **Piper TTS**: Good quality but requires a separate binary; kokoro-js is a pure npm package.
- **ElevenLabs cloud**: Excellent quality but requires network at run time (INV-G4 forbids this).

## Consequences

### Positive
- Natural, consistent voice regardless of Windows language pack.
- First phrase plays within ~1 s; subsequent sentences stream as they synthesise.
- No network at run time; everything runs locally after `view:setup`.
- Worker thread keeps the Herdr poll unaffected during synthesis.

### Negative
- One-time setup step (~311 MB download) is required before the neural voice works.
- ~1.4 GB peak RAM during synthesis; on machines with limited RAM, loading may fail.
- ~6.7 s startup delay before Kokoro is ready; Windows voice plays during that window.
- kokoro-js uses a GPL-3.0 espeak-ng bundled phonemiser; the project remains MIT but the
  dependency chain includes GPL code.
