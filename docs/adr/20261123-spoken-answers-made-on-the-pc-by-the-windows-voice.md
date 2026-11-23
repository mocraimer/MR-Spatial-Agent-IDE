# ADR: Spoken answers are made on the PC by the Windows voice, and replies are read only when asked

## Status
Accepted

## Area
Spatial view

## Context
A spoken command gave no sound back, so the owner had to look at the strip to learn whether it worked, and a finished reply had to be read off a tile. The owner asked for "some TTS feedback on what happens with commands" and to be able to "opt-in to have the last response read to us as well". Speech input already stays on the PC and is free (20261121-local-speech-on-the-pc), and a paid speech service was ruled out. The text to speak is an agent's reply or transcribed speech, which must never be run as a command. The microphone is open in mixed reality, so a voice played in the headset could be heard as the owner. On this PC the Quest browser's own speech synthesis could not be tested, and reports suggest it may be missing or silent in an immersive session.

## Decision
- The bridge makes each phrase into a WAV with Windows' own speech (`System.Speech`, the voices David and Zira) by running `powershell.exe` from WSL. The text goes in on standard input; the command line is fixed; the WAV comes back on standard output, so no file is written. A phrase is stopped after 15 seconds. Measured here: about 0.4 to 1.3 s for 6 to 9 s of audio.
- The bridge tells the page that a phrase is ready; the page fetches it from `/api/say/<id>`, which needs the pairing like every other route, and plays it through an audio context. Waiting phrases, kept audio and the length of a phrase are bounded, and a stop drops all of them.
- The microphone hears nothing while a phrase plays. The owner stops a phrase by hand (**Quiet**); the spoken "quiet" works between phrases.
- Spoken by default: the first sentence of the outcome of each command and helper order, a failed prompt, each question that waits for a yes, and a close's end. Not spoken: noise, ignored speech and a draft that was typed. A voice setting turns all of it off and on and is kept across restarts.
- Reply reading is off until turned on. With it on, the reply of a turn that ends in the session in front is read once; "read that" reads the last reply once. Both take the reply from the transcript Claude Code keeps for the session (the session id comes from Herdr), read from the end of the file, and speak the first sentences up to about 600 characters with code left out. What is read is never logged.

## Alternatives Considered
- **The Kokoro neural voice on the CPU (`kokoro-js`)**: sounds better — but it ran slower than real time here (9.8 s to make 5.9 s of audio), adds about 90 MB and needs a second copy of the speech library.
- **The browser's own speech synthesis**: no PC work — but it could not be verified on a Quest and may be silent in an immersive session.
- **A paid or cloud voice**: best quality — ruled out by the owner for cost, and the text of replies would leave the PC.
- **Reading replies always**: no setting — but the owner asked to opt in, and a long reply spoken unasked is a long wait.
- **The microphone open while the voice plays**: the owner could cut in by voice — but the voice would be heard as speech and typed into a session.

## Consequences

### Positive
- Answers are heard without looking, with no new dependency, no download and no cost; text never leaves the PC.
- A voice that fails does not stop anything: the written answers go on and the next phrase tries again.

### Negative
- The voice is Windows-only and plain; it needs Windows PowerShell to be reachable from WSL.
- Playback inside a real Quest in immersive mode has not been tested; the desktop emulator only shows that the page plays the audio.
- A phrase cannot be stopped by voice while it plays; the owner uses the Quiet button.

## Source
- Session: /manifest-dev:auto run (2026-11-23)
- Related: 20261121-local-speech-on-the-pc, 20261122-spoken-prompts-wait-for-go
