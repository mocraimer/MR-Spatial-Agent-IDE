# Host HTTP contract

Protocol version 1 lives in `host/src/protocol.ts`. This document describes the
implemented HTTP boundary, not proof that a real runtime, speech provider or task
application is configured. Missing providers return 503 and appear as `missing` in
readiness. Failed readiness probes appear as `blocked`, never `ready`.

## Transport and owner identity

`createHostServer` creates two listeners:

- **Native HTTPS:** TLS 1.2 or later, paired bearer credential required. The device
  must pin the certificate SHA-256 fingerprint obtained independently from trusted
  setup. No pin or pairing code appears in health, errors or request logs. Browser
  Origin requests are refused; this API does not enable CORS.
- **Owner HTTP companion:** bound to `127.0.0.1` only. Every request, including HTML,
  assets and setup, passes `trustedConsoleRequest(remoteAddress, Host, Origin,
  actualPort)`. Unknown Host names and cross-origin requests return 403. No owner
  bootstrap bearer token is delivered to browser JavaScript or service providers.
  Loopback access is owner access under the trusted-host-OS boundary; do not proxy
  this listener onto the LAN or expose it to task environments.

All non-health native routes except pairing require a current, nonrevoked client.
The server derives `HostOwner` from that authentication. Request fields cannot
supply an owner, role or token. `/v1` selects the protocol version; optional
`X-Protocol-Version` must be `1` or the server returns 426.

Every failure uses a non-2xx status and `{error,detail,recovery}`. Expected typed
store/environment/service errors retain useful recovery. Unknown provider errors
are not echoed because they may contain credentials. The boundary does not log
bodies, audio, credentials or setup codes.

## Routes

Both listeners expose authenticated product routes below. Setup is HTTP-console
only; native pairing is HTTPS only. IDs in path segments must be URL encoded.

| Method / route | Body or result |
|---|---|
| GET `/v1/health` | Public `{protocolVersion:1,state:'listening'}`; not runtime readiness |
| POST `/v1/pair` | HTTPS only `{code,label}` → one-time `{clientId,token,protocolVersion}` |
| GET `/setup` | Trusted console only `{protocolVersion,pairing:{code,expiresAt},fingerprint,nativePort,clients}` |
| POST `/setup/revoke` | Trusted console only `{clientId}` → `{state:'revoked'}` |
| GET `/v1/snapshot` | Real SQLite `Snapshot`, plus injected readiness and current task-bound views |
| GET `/v1/events?after=N` | Long-poll full snapshot; waits up to 20s, then returns current observation even if unchanged |
| GET `/v1/environments` | Injected broker `EnvironmentSnapshot[]`; 503 if unavailable |
| GET `/v1/inbox` | Retained `InboxRequest[]`, including answered history |
| POST `/v1/projects` | `{name,purpose}` → Project (201); root Space/conversation available in snapshot |
| PATCH `/v1/projects/:id` | `{name?,purpose?}` → Project, also updates root space labels |
| POST `/v1/spaces` | `{projectId,parentId,name,purpose,position?}` → Space (201) |
| PATCH `/v1/spaces/:id` | `{name?,purpose?,position?,parentId?}` → Space; rejects cycles and cross-project moves |
| POST `/v1/links` | `{fromId,toId,label}` → SpaceLink (201) |
| GET `/v1/conversations/:id/messages?before=ID&limit=N` | `{messages,nextBefore}`; 1–500 messages, cursor belongs to that conversation |
| PATCH `/v1/conversations/:id/settings` | `{runtime,model,effort}` → Conversation; provider validates capability/authority first |
| POST `/v1/turns` | `{idempotencyKey,receiver,text}` → `SubmissionAcknowledgement` (202) |
| POST `/v1/tasks` | `{idempotencyKey,spaceId,title,prompt,runtime,model,effort,parentTaskId?}` → TaskWindow (202) |
| PATCH `/v1/tasks/:id/layout` | WindowLayout `{position,rotation,scale}` → TaskWindow |
| GET `/v1/tasks/:id/frame?view=ID` | Actual injected PNG bytes, `Content-Type: image/png`; `X-Frame-Identity` is JSON FrameIdentity |
| GET `/v1/tasks/:id/terminal` | Actual injected PTY text, `text/plain; charset=utf-8`, maximum 1 MiB |
| GET `/v1/tasks/:id/control` | Current actual lease even when a frame is unavailable; not a takeover acknowledgement |
| POST `/v1/tasks/:id/control` | `{action:'take'|'resume'|'stop',expectedEpoch,confirmReset?}` → ControlLease |
| POST `/v1/tasks/:id/input` | TaskInput; URL/task/environment/view/generation must match, broker checks lease and owner-only port |
| POST `/v1/tasks/:id/interrupt` | `{mode:'turn'|'task'}` → `{state,detail}` from execution service; request is not cancellation proof |
| POST `/v1/inbox/:id/respond` | `{version,action:'answer'|'approve'|'review'|'defer'|'dismiss',text,idempotencyKey?,authorityId?,authorityVersion?}` → `{request,decision}` |
| POST `/v1/voice` | `{idempotencyKey,receiver,wavBase64}` → acknowledgement with transcript, or navigation result below |
| GET `/v1/speech/:messageId` | Generated PCM 16-bit WAV, mono/stereo at 8–96kHz, maximum 120s / 8 MB, for a completed agent message only; no audio retention by HTTP layer |
| POST `/v1/telemetry` | Strict `NativeEvidence` → `{state:'recorded',detail}` (202); 503 without evidence recorder |

Hard deletion returns **501**. Use `POST /v1/archive/project|space|task|link/:id`
with an empty JSON body for history-preserving archive or unlink. Empty destinations
archive through the SQLite transaction; destinations with work require the injected
lifecycle service to hold the shared coordinator admission fence through the commit.
Missing that fence returns BLOCKED, not an inspection-only safety claim. Work and
open decisions must be reconciled first. Archive never cancels work or destroys
volumes. `GET /v1/history/archives` lists tombstones; authenticated
`GET /v1/history/export` retains full product records, source text and evidence IDs.
This sensitive export does not include coordinator evidence files or task volumes.
Do not edit SQLite directly to bypass these checks.

`GET /v1/spaces/:id/sources` lists accessible source metadata.
`POST /v1/spaces/:id/sources` registers owner-uploaded `{name,text,provenance}`
(up to 1 MiB UTF-8 text), without fetching any host path. Retrieve one with
`GET /v1/sources/:id?space=ID`. Sources inherit only same-project ancestors; Overview
and unrelated projects do not leak into children. Source text remains untrusted
content, never owner commands. Archived receivers refuse new context reads/uploads.

### Submissions and navigation

A Receiver is `{spaceId,conversationId,taskId:null|string}`. Validate it before
transcription and again before submission. Runtime/model/effort are frozen into the
submission by the store. Opening a context or polling does not dispatch a model.
Task creation does not select a receiver.

Store idempotency refuses changed content/receiver for an existing key. Execution
receives the durable Submission, not a fresh model-defined dispatch object. Queue
calls must be coordinator-idempotent by submission ID; host restarts may reconcile
queued submissions. The companion keeps the same submission key on an unchanged
failed request. Acknowledgement loss must not cause an automatic new task.

Voice accepts only canonical base64 containing mono 16-bit PCM WAV at 16kHz,
maximum 30 seconds. The speech port performs actual transcription; the HTTP layer
never implements a pretend transcriber or retains audio. Before transcription the
store durably records the original request key, receiver, and SHA-256 audio digest.
Changed recipient/audio or reuse as a text/task request refuses before a paid call.
The speech journal receives the same hashed request identity across retries. Decoded
samples are zeroed after validation/transcription, including failures. Listening enable, permission, foreground ownership, and echo fencing
are native-client responsibilities. The companion never requests microphone access
and sends a microphone-denying Permissions-Policy.

Only an authenticated owner's transcribed utterance whose trimmed, lowercased,
whitespace-collapsed text is exactly `open my global inbox` is intercepted before
model dispatch. It returns:

```json
{"requestId":"durable-submission-id","conversationId":"captured-conversation","taskId":null,"state":"local-command","detail":"open-global-inbox","transcript":"original transcription"}
```

`taskId` remains the captured task ID when present. Other utterances retain their
captured receiver. Agent replies, documents and typed turns do not invoke this
navigation interception. Navigation and execution keys cannot be interchanged.

### Decisions, control and reconnect

Inbox actions reject stale versions, closed requests, and wrong kind/action before
calling a service. Questions/blockers accept `answer` or `defer`; approvals accept
`approve` or `defer`; reviews accept `review` or `defer`. Every kind also accepts
`dismiss` with a nonempty owner reason. Defer/dismiss only record product state;
dismiss is terminal `dismissed` and does not cancel work or release reservations.
Old evidence and all versions/owner choices remain retained. Snapshot Inbox records
include the latest `disposition` (action, text, time, and optional receipt/authority).
Both clients display open/deferred requests and read-only answered/dismissed history.

`approve` means **confirm an existing matching authority**, not issue authority. It
requires typed `authorityId` and positive `authorityVersion`, a host-produced exact
coordinator awaiting-approval refusal, and unchanged scope/settings/current request.
These fields are rejected for other actions. The coordinator fence surrounds the
product current-version transaction and idempotent exact coordinator receipt.
The response includes `decision.ownerReceipt`; its coverage is `scope-only`.
The original received fingerprint is never rewritten. An approval ID must first
be explicitly registered/reloaded in the private receiver scope; standing grants
use the existing trigger source. See [the exact CLI handoff](HOST-SETUP.md#inbox-authority-handoff-manual-explicit-owner-action).

Answer/review call `execution.decide` before the version-fenced local decision.
Answers do not grant authority or start inference: jump and send a new explicit
follow-up for fresh admission. Durable receiver-scoped owner decisions are supplied
to `task_context`, not lost when recent message history rolls over. Superseded
reviews retain their old pin and obsolete reason; reviewing refuses rather than
repinning. Dismiss closes such a request without reviewing the newer attempt.
Without a supplied key, service decision identity is `inbox:ID:VERSION:ACTION`.

The injected coordinator must atomically fence current authority/evidence and
idempotent effects: the HTTP/product-store check cannot make a cross-store grant
atomic. Confirmation uses the shared fence plus synchronous SQLite transaction;
missing methods or acknowledgement failures fail closed. A version change after answer/review service admission refuses the local decision record;
reconciliation remains required. No generic model-accessible authority/grant route
exists and the host never issues grants automatically.

Control `confirmReset:true` translates to the broker's internal confirmed restart
argument. Without it, a destructive handoff may return `owner:'handoff'` and
`confirmation-required` detail; existing workload ownership has not changed. Even
resume may restart all app processes. Acknowledged owner control alone enables
input. Lost acknowledgements/uncertain leases must remain uncertain, not successful.

Long-polls observe real persistent revisions, including independent SQLite writers.
Reconnect requests a current snapshot; it never replays effects. Revocation is
rechecked after waiting and provider reads. Readiness/environment-only changes need
not advance the product revision: they appear at the next bounded poll observation.

JSON bodies are limited to 128 KiB; voice to 1.3 MB; telemetry to 16 KiB. Body receipt
is bounded to 10s; provider acknowledgement to 30s; readiness to 5s. Timeout is 504
and explicitly warns that work may still be uncertain. The timeout does not claim
to cancel a provider operation; its service owns durable reconciliation.
