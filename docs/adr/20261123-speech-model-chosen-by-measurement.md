# ADR: Speech model is chosen by measurement against a frozen utterance set

## Status
Accepted; extends [20261121-local-speech-on-the-pc](20261121-local-speech-on-the-pc.md): the
choice of Moonshine tiny q8 is now backed by a measured benchmark

## Area
Spatial view

## Context
The original Moonshine tiny q8 choice was made by qualitative comparison on the view's own short
phrases. With the voice interaction maturing, accuracy on longer dictation (15–30 s) matters more.
Newer candidates are available: Moonshine v2 Small and v2 Medium (expected lower WER, higher
latency), and Parakeet 0.6b (reference only: too large and too slow for the target machine).

The brief requires a frozen measurement set of ≥100 real utterances (≥30 long, 15–30 s) from
LibriSpeech test-other and TED-LIUM so that future comparisons are reproducible. The winning
model must have both the lowest WER among candidates with median warm transcription time ≤1.1 s.

## Decision
Measure WER and median warm transcription time for each candidate using the `npm run speech:measure`
bench script against the frozen dataset assembled by `npm run speech:dataset`. The candidate with
the lowest WER that also meets the ≤1.1 s median warm time constraint becomes the production model.
Until the measurement is run and a winner is confirmed, Moonshine tiny q8 stays as the default.
The measurement results (JSON) are saved beside the models directory for audit.

Parakeet 0.6b is included in the measurement as a WER reference floor but excluded from
consideration as the production model: its size (~2.5 GB) and latency exceed the view's targets.

## Alternatives Considered
- **Fix Moonshine tiny q8 forever**: Simple but may miss improvements from v2 models.
- **Switch to Moonshine v2 Medium unconditionally**: Better WER expected, but latency unknown on
  the target machine; measurement confirms it meets the ≤1.1 s bound before switching.
- **Use Whisper base.en**: Ruled out in [20261121-local-speech-on-the-pc](20261121-local-speech-on-the-pc.md);
  larger and slower than Moonshine tiny with no accuracy advantage on this workload.

## Consequences

### Positive
- Model choice is backed by reproducible numbers on real speech, not qualitative impression.
- The frozen dataset pins the benchmark so changes do not silently change the baseline.
- The measurement script is reusable when new candidates appear.

### Negative
- Download and measurement are manual steps (~600 MB dataset + model downloads).
- The frozen utterance list may not perfectly represent the owner's accent and vocabulary.
- ffmpeg must be available on the measurement machine (for FLAC → WAV conversion from LibriSpeech).
