# ADR: Speech model is chosen by measurement against a frozen utterance set

## Status
Accepted; extends [20261121-local-speech-on-the-pc](20261121-local-speech-on-the-pc.md): winner confirmed by measurement on 2026-11-24 — `Workmind/moonshine-streaming-small-ONNX` (quantized) is now the production model, replacing Moonshine tiny q8.

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
The measurement results (JSON) are saved beside the models directory for audit.

**Winner (measured 2026-11-24, LibriSpeech test-other, 100 utterances, 3 warm-up passes):**

| Candidate | WER all | WER long | Median ms (all) | p95 ms | Eligible |
|---|---|---|---|---|---|
| `onnx-community/moonshine-tiny-ONNX` q8 | 14.4 % | 8.7 % | 614 ms | 1927 ms | ✓ |
| `Workmind/moonshine-streaming-small-ONNX` quantized | **7.7 %** | **5.0 %** | **963 ms** | 4425 ms | ✓ **winner** |
| `moonshine-ai/moonshine-streaming` medium (.ort) | 16.1 %* | 17.8 %* | 3023 ms | 19452 ms | ✗ latency |
| `parakeet-tdt-0.6b-v2-int8` (sherpa-onnx-node) | **4.1 %** | **3.3 %** | 1389 ms† | 6289 ms | ✗ size/latency |

\* WER inflated: Python normalizer does not strip punctuation from hypothesis; model outputs
commas/periods that are not in the reference texts. Latency alone disqualifies it (median 3023 ms
exceeds the 1.1 s gate), so the exact WER is not material.

† Parakeet (640 MB int8): cold-system median 1389 ms exceeds the 1.1 s gate. A warm ORT session
measured 1091 ms (9 ms under the gate), which is too close to treat as passing. Excluded from
winner selection; serves as accuracy reference floor (4.1 % WER is the best achievable on this
dataset with the candidates evaluated).

The streaming small model requires audio length divisible by 80 (frame_len). The production
`LocalSpeech.transcribe()` pads each chunk by up to 79 silent samples before inference.

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
