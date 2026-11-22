# ADR: Local speech on the PC with Moonshine tiny

## Status
Accepted

## Area
Spatial view

## Context
The owner wants to control everything by voice, with no paid service and a small English model that is not Whisper ("whisper seems too big; there are much smaller ones that do as well in English"). The Quest browser's own speech recognition is reported not to work. Utterances are short commands ("next waiting", "press two") and free prompts to agents. A prompt is sent with no confirming step, so what was heard must always be shown.

## Decision
The page captures the microphone, cuts utterances (by hold to talk, or by pauses with the listening switch) and posts 16 kHz audio to the bridge. The bridge transcribes it with Moonshine tiny (8-bit ONNX, about 31 MB) through `@huggingface/transformers` and ONNX Runtime on the CPU, with remote model loading turned off at run time. `npm run view:setup` fetches the model once. The choice was measured on the view's own phrases, synthesized clean, noisy and fast: Moonshine tiny matched Moonshine base overall (14% word error on clean phrases), was better on short commands (4% against 9%), was half the size and ran at about 0.1 s per utterance. Parakeet CTC 110M invented doubled letters under noise, zipformer models were poor on short commands, Whisper tiny/base.en took 0.6–0.8 s, and Vosk did not build on Node 22. A command must be the whole utterance, and numbers after "press", "option" and "show" are compared as digits, so "press to" is "press 2".

## Alternatives Considered
- **Moonshine base**: the first pick — but no more accurate overall, worse on commands, twice the size.
- **Parakeet CTC 110M (sherpa-onnx)**: fastest — but 4× larger and it hallucinates under room noise.
- **Whisper tiny.en / base.en**: reference only — slower, and the owner ruled Whisper out.
- **A paid speech API**: the owner ruled out paid services, and audio would leave the PC.

## Consequences

### Positive
- Audio never leaves the PC; nothing is paid for; one model download at setup.
- Swapping the model is one constant in `view/bridge/speech.ts`.

### Negative
- The measurements used synthesized speech; the owner's own voice is judged in the headset.
- `onnxruntime-node` is large on disk (about 300 MB in `node_modules`) and needs `onnxruntime-node-install-cuda=skip` (`.npmrc`).

## Source
- Session: /do run (2026-11-21); the model comparison was run by a delegated agent in a temporary directory and is not kept; its figures are the ones above
- Related: 20261121-thin-webxr-view-over-herdr.md
