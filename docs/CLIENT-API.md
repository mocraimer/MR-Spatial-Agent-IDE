# Native/owner client contract

Protocol version 1; records are in `host/src/protocol.ts`. JSON field names match those records. Bearer authentication is required except for pairing and health. Native connections require HTTPS and a certificate fingerprint explicitly obtained from the trusted host setup screen; never trust a fingerprint returned by the untrusted endpoint being paired. Missing backend capability is a visible blocked/unavailable state, not simulated success.

| Route | Body / result |
|---|---|
| POST /v1/pair | `{code,label}` → `{clientId,token,protocolVersion}`; one-time expiring code |
| GET /v1/snapshot | `Snapshot` |
| GET /v1/events?after=revision | Long-poll snapshot when changed; reconnect uses snapshot, not repeated effects |
| POST /v1/projects | `{name,purpose}` → created Project and root Space |
| POST /v1/spaces | `{projectId,parentId,name,purpose,position}` → Space |
| PATCH /v1/spaces/:id | `{name,purpose,position,parentId}` → updated Space; moves reject cycles/cross-project reassignment |
| PATCH /v1/projects/:id | `{name,purpose}` → updated Project |
| GET /v1/conversations/:id/messages?before=ID | Paginated retained full history; snapshots carry recent messages |
| PATCH /v1/conversations/:id/settings | `{runtime,model,effort}`; owner choice checked against capabilities/authority |
| POST /v1/links | `{fromId,toId,label}` → SpaceLink |
| GET /v1/spaces/:id/sources | Metadata for explicit owner sources and same-project ancestors only |
| POST /v1/spaces/:id/sources | `{name,text,provenance}` → durable source metadata; text up to 1 MiB UTF-8, no host path fetched |
| GET /v1/sources/:id?space=ID | Source text/hash/provenance inside that space's access boundary |
| POST /v1/archive/project\|space\|task\|link/:id | `{}` → retained tombstone; active/uncertain work refuses; work-backed archive needs shared admission fence |
| GET /v1/history/export | Private full product history, including sources and voice-intent hashes; not a coordinator/volume backup |
| POST /v1/turns | `{idempotencyKey,receiver,text}` → persisted submission identity/status; recipient fixed from speech onset |
| POST /v1/tasks | `{idempotencyKey,spaceId,title,prompt,runtime,model,effort}` → TaskWindow; no implied authority |
| PATCH /v1/tasks/:id/layout | WindowLayout; retained spatial placement |
| GET /v1/tasks/:id/frame?view=ID | Actual PNG; X-Frame-Identity header contains JSON FrameIdentity |
| GET /v1/tasks/:id/terminal | Actual bounded terminal output, not agent narration |
| GET /v1/tasks/:id/control | Current ControlLease even while frames are unavailable; not a takeover acknowledgement |
| POST /v1/tasks/:id/control | `{action:'take'|'resume'|'stop',expectedEpoch,confirmReset}` → ControlLease; explicit reset confirmation is required and unsaved app state is lost |
| POST /v1/tasks/:id/input | TaskInput; server derives caller role; rejects stale frame/generation/lease |
| POST /v1/tasks/:id/interrupt | `{mode:'turn'|'task'}`; request is not proof of cancellation |
| POST /v1/inbox/:id/respond | `{version,action:'answer'|'approve'|'review'|'defer'|'dismiss',text,authorityId?,authorityVersion?}`; approve confirms an existing receipt only, using required typed ID/version; dismiss requires owner reason |
| POST /v1/voice | `{idempotencyKey,receiver,wavBase64}`; configured real transcription; exact owner global-Inbox command returns `state:'local-command',detail:'open-global-inbox'` before agent dispatch |
| GET /v1/speech/:messageId | Configured generated reply audio; client plays only for active matching context and explicit spoken-reply enable |
| POST /v1/telemetry | Bounded actual native session/frame/input evidence; no credentials or raw audio |

Requests that fail return a non-success HTTP status and ApiError with a useful recovery action. Pairing tokens/pins remain private device data. Native navigation keeps parent Back separate from Inbox Return; opening Inbox does not alter space/receiver, a jump selects its destination, and Return restores the original selection. UI only changes focus on deliberate activation. Task creation/background events do not select new windows.

Both clients retain open/deferred requests and deliberate jumps against current IDs/versions. Answered/dismissed requests remain read-only history, including the latest owner `disposition`. Native complete evidence pages must reach their last page before Decision; the decision panel can reopen complete evidence. A superseded review shows why it is obsolete and preserves its original attempt pin. Dismiss closes only the request, never a task or uncertain reservation.

Approval is a manual owner CLI handoff followed by **Confirm existing authority**, not a text-to-grant route. Read [HOST-SETUP.md](HOST-SETUP.md#inbox-authority-handoff-manual-explicit-owner-action) for exact selected build/state/operator, explicit budgets, and approval-ID binding/reload. Confirmation records scope coverage, not runnable capacity; it never resumes old blocked/uncertain identities. Answer feedback is: "Answer retained; no new execution started. Jump to the task and send a follow-up." A new explicit turn enters ordinary fresh admission.
