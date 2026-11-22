# Host composition and verification

`host/src/server.ts` exports the composition boundary. Main owns provider construction,
recovery, supervision and closing the underlying stores/brokers. The HTTP layer
creates no production agents, credentials, coordinator grants or live environments.

Existing-authority confirmation returns the already committed current-version Inbox response under the shared coordinator fence. A void result cannot acknowledge `approve`; missing confirmation support fails closed. Answer/review retain their existing service-before-local-record path; defer/dismiss are authenticated product-only actions. See `HOST-SETUP.md` for the manual CLI/binding journey.

## Exact public signatures

```ts
interface HostOwner { clientId: string; surface: 'native' | 'console' }
type RuntimeSettings = Pick<Conversation, 'runtime' | 'model' | 'effort'>;
interface OwnerDecision { action: InboxAction; text: string; idempotencyKey: string; authorityId?: string; authorityVersion?: number }
interface NativeEvidence {
  sessionId: string; unity: string; mode: 'VR' | 'MR';
  frameCount: number; unscaledFrameSeconds: number;
  spaceId: string; taskId: string | null; viewId: string | null;
  microphoneEnabled: boolean; captureAllowed: boolean;
  metrics: {
    timingAvailable: boolean; samples: number;
    cpuP95Ms: number; gpuP95Ms: number; allocatedBytes: number;
  };
}
interface HostServices {
  execution?: {
    readiness(): Promise<ReadinessItem[]>;
    refreshReviews?(): void;
    validateSettings(settings: RuntimeSettings, owner: HostOwner): Promise<void>;
    queue(submission: Submission, owner: HostOwner): Promise<void>;
    interrupt(task: TaskWindow, mode: 'turn' | 'task', owner: HostOwner):
      Promise<{ state: string; detail: string }>;
    decide(request: InboxRequest, decision: OwnerDecision, owner: HostOwner):
      Promise<ReturnType<WorkspaceStore['respondInbox']> | void>;
  };
  environment?: {
    readiness(): Promise<ReadinessItem>;
    views(): ToolView[];
    snapshots(): EnvironmentSnapshot[];
    frame(taskId: string, viewId: string): Promise<TaskFrame>;
    terminal(taskId: string): Promise<string>;
    owner(): OwnerTaskTools;
  };
  speech?: {
    readiness(): Promise<ReadinessItem[]>;
    transcribe(wav: Buffer, context?: { idempotencyKey: string }): Promise<string>;
    synthesize(text: string, context?: { idempotencyKey: string }): Promise<Buffer>;
  };
  lifecycle?: {
    readiness(): ReadinessItem;
    assertDestinationAvailable(receiver: Receiver): void;
    archive(receivers: readonly Receiver[], owner: HostOwner,
      commit: () => ArchiveRecord,
      product: { kind: 'project' | 'space' | 'task'; id: string }): Promise<ArchiveRecord>;
  };
  telemetry?: { record(evidence: NativeEvidence, owner: HostOwner): Promise<void> };
}
interface HostServerOptions {
  store: WorkspaceStore;
  auth: PairingAuthority;
  certificate: HostCertificate;
  services: HostServices;
}
createHostServer(options: HostServerOptions): {
  nativeServer: import('node:https').Server;
  consoleServer: import('node:http').Server;
  listen(config?: {
    nativePort?: number; nativeHost?: string; consolePort?: number;
  }): Promise<{ nativePort: number; consolePort: number }>;
  close(): Promise<void>;
};
class HostApiError extends Error {
  constructor(status: number, code: string, detail: string, recovery: string);
  readonly status: number; readonly code: string; readonly recovery: string;
}
validateVoiceWav(wav: Buffer): void;
isGlobalInboxCommand(transcript: string): boolean;
```

Types `TaskFrame`, `EnvironmentSnapshot` and `OwnerTaskTools` come from
`environment-broker.ts`. `EnvironmentBroker` implements the environment port
structurally. Pass only its owner port to the HTTP layer, never expose owner controls
or HostOwner as a model tool schema. Main must not pass companion credentials into
execution/speech providers. Services get only the derived client ID and surface.

Both default ports are ephemeral and both default binds are loopback. Main must
explicitly choose stable ports and a native LAN bind for Quest use. The console bind
is not configurable and remains loopback. Obtain the actual console port from
`listen()`; its value feeds Host/Origin validation, including in tests.

## Provider responsibilities

- Validate runtime/model/effort against actual adapter capabilities and owner
  authority. Refuse unavailable choices with `HostApiError` and a recovery action.
- Queue one durable submission through the existing coordinator, using its stable
  identity to deduplicate. Update the shared WorkspaceStore with actual admission,
  run/evidence IDs, messages and truthful task status. Do not describe queued work as
  executing. Reconcile unknown effects; never replay them blindly.
- For every decision, fence coordinator scope, current authority and evidence at
  admission; deduplicate the identity and refuse changed payloads. Approvals are
  owner actions, not model arguments. Answer/review must not imply grants. Persist
  reconciliation evidence if coordinator admission succeeds but product recording
  fails or the owner credential is revoked meanwhile.
- The broker must fence actual tools through environment/view generations and input
  epochs, including queued input and raw execution paths. An HTTP identity check does
  not substitute for tool confinement.
- Speech transcription must process the supplied bounded WAV while respecting the
  configured provider/pay limits. Synthesis must return PCM 16-bit WAV, mono/stereo
  at 8–96kHz, at most 120 seconds and 8 MB. Do not retain raw audio by default or feed spoken replies back as turns.
  Adapters must forward the server-supplied `context` unchanged to both methods, including its durable `idempotencyKey`.
  Do not drop the context or replace its key on retry. The parameter is optional in `HostServices` for structural compatibility.
  The shipped `OpenAiSpeechService` requires a valid context and rejects missing context with `speech-key-required` before billing.
  For more information, see [Host speech](SPEECH.md).
- Nonempty archive uses the actual coordinator's durable prepared cutoff around a
  synchronous SQLite callback. Derive the operator from current pairing and the
  configured existing operator, never from browser fields. Hold actual stopped
  environment proofs across awaited verification and recheck every captured identity
  inside the coordinator callback immediately before SQL. Root tombstones and durable
  coordinator bindings commit together. Retry the same stable root identity by fresh
  SQL reconciliation; never create a replacement identity after acknowledgement loss.
  Do not stop work or export/delete volumes to satisfy history archive. See `ARCHIVE.md`.
- Readiness detail must be safe to show to the authenticated owner and explain a
  real setup action. Runtime/cloud login is not evidence of speech credentials.
- Evidence recording accepts only the typed native metrics fields. It is not proof
  that frame timing/input measurements are valid or that performance gates passed.

## Owner companion

The shipped page provides project/child-space creation, naming, moves and links,
conversation history/runtime choice/text turns, task requests and layout,
real-provider frames/terminal, input/control/interrupt, pairing/revocation/readiness,
and global Inbox decisions/jump/return. It renders source/model content with DOM
`textContent`; CSP blocks inline scripts and framing. Listening is always off in this
console. Missing providers explain why an action is unavailable instead of displaying
made-up work. See `host-api.md` for deletion and authority limitations.

Host setup is a private local surface. The displayed HTTPS origin uses the local
hostname and native port; on Quest use the host's configured LAN address instead.
Copy its pin independently. Do not expose the console through a reverse proxy.

## Automated evidence

Run from the source checkout with Node >=22.13, development dependencies, and installed Playwright Chromium. These build/test commands and test sources are not shipped in the private host package:

```sh
npm run typecheck
npm run lint
npm run build
node --test build/host/tests/server.test.js
npm run test:ui
```

`server.test.ts` boots the actual HTTPS/HTTP server with real private pairing state,
certificates and SQLite. It verifies native authentication/revocation, trusted setup,
Host/Origin rebinding refusals, persistence, receiver/key/version checks, bounded WAV,
exact navigation interception, real revisions/independent writers, and broker fencing.
`lifecycle.test.ts` additionally uses the actual public coordinator with disposable
state and product SQLite, explicit fixture-engine stopped proofs, held sibling-task
fences, HTTP ingress before paid voice, callback rollback, and killed independent
processes before/after SQL commit followed by fresh same-key reconciliation. These
are safety/integration fixtures, not production activation or real Docker proof.
`companion.spec.ts` drives Chromium against that real server, covering setup,
revocation, actual project/space records, missing-provider recovery, retained
conversations/task requests through an injected adapter, unsafe text, Inbox
jump/return and stale decision refusal.

All test state lives under new OS-private temporary directories. Tests never access
the factory, `.state`, live credentials/grants or actual model/provider services.
Execution/speech/engine adapters in tests are labelled fixtures. Passing these tests
does **not** establish real agent, speech-provider, Docker-app, native-device, or
performance acceptance. Those require separate authorized product evidence.
Playwright artifacts go to `/tmp/spatial-workspace-playwright-results`, not live
product state. No process-global changes or live activation are part of these tests.
