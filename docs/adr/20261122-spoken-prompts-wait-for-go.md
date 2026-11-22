# ADR: Spoken prompts wait for "go", and the microphone stands by while listening is off

## Status
Accepted

## Area
Spatial view

## Context
The first view sent each spoken prompt to the session in front as soon as the owner stopped talking, with no confirming step, and "stop listening" closed the microphone. After using it in the headset, the owner found two problems. A misheard prompt reached an agent that acts on it at once ("having the prompts submitted from voice directly without confirmation can be an issue"), and once listening was off, voice could not turn it back on ("we cant turn voice back on with a command"). The helper acts with the owner's full access, so a misheard order to it is the riskier case. Speech is transcribed by a small local model, and in the listening mode a pause ends an utterance, so one long prompt can arrive in pieces.

## Decision
- By default, spoken words that are not a command are typed into the receiver's input as a draft and are not sent. "go" (also "submit", "send it") sends the draft. "scratch that" clears it. Further speech is added to it, so a prompt said in pieces stays whole. The same holds for orders to the helper.
- Sending at once stays available as an opt-in setting, switched by a button or by saying "send at once" and "wait for go", and kept on the PC.
- In mixed reality the microphone stays open while listening is off: standby. In standby only commands are heard. Each is shown as "Do X? Say yes" and done only after the owner's yes. Nothing is ever sent to a session from standby. "stop listening" returns to standby, and leaving mixed reality closes the microphone.

The owner chose drafts by default, helper orders waiting too, adding over replacing, and confirmed commands in standby. The words "go", "scratch that" and "send at once", and standby starting on entering mixed reality, are this session's working choices.

## Alternatives Considered
- **Send at once, as before**: one step less — but a misheard prompt reaches an agent that acts on it.
- **Each new utterance replaces the draft**: a fix is just saying it again — but in the listening mode a pause would drop the first half of a long prompt.
- **Helper orders sent at once**: quicker short orders — but the helper acts with the owner's full access.
- **In standby, only "start listening"**: less to mishear — but the owner asked for commands by voice while listening is off.
- **Commands in standby without a confirmation**: no extra word — but room talk could move the owner or press a key.
- **Microphone closed when listening is off**: nothing captured — but then only a hand can turn voice back on.

## Consequences

### Positive
- No spoken word reaches an agent until the owner has seen it and said "go".
- Voice works from any state while in mixed reality.

### Negative
- Every prompt takes one more word.
- The microphone is open for the whole time in mixed reality; audio stays on the PC, but the headset shows the microphone in use and spends battery on it.
- "scratch that" clears the whole input line, including text typed at the desk.

## Source
- Session: figure-out on 2026-11-22 (`~/.manifest-dev/logs/figure-out-log-20261122-184510-a73d.md`)
- Related: 20261121-local-speech-on-the-pc, 20261121-helper-closes-only-on-the-owners-yes
