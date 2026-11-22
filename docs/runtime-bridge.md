# Guarded interactive execution bridge

This page covers how the earlier host runs guarded interactive agent work through the coordinator: composing the bridge, its tools and its tests. It does not cover setting up or activating a coordinator; see [private host setup](HOST-SETUP.md) and [Coordinator build and type seam](COORDINATOR-BUILD.md).

## Composition

`ExecutionBridge` implements `HostServices.execution`. Construct it with:

```ts
new ExecutionBridge({
  store,                         // the existing WorkspaceStore, not another outbox
  activated,                     // explicit compatible-coordinator activation check
  coordinatorFactory,            // feature createCoordinatorCommands
  legacyAdapterFactory,          // feature adapterFor; preserves coding/evaluator flows
  profiles,                      // explicit CLI, private config/data roots, models/efforts/account
  authenticateOwner,             // authenticated HostOwner -> existing configured operator Actor
  runtimeAuthentication,         // CLI login + same approved usage/inference account; missing => BLOCKED
  scope,                         // registered receiver -> approved ExecutionScope or null
  contextSources,                // optional; defaults to store.listSources(fixed spaceId)
  readSource,                     // optional; defaults to store.readSourceForSpace(fixed spaceId,id)
  environment,                   // admitted Submission + runId -> fixed agent environment or null
});
```

Pass the approved feature build's `createCoordinatorCommands` and `adapterFor`. Do not load/build/activate canonical live `main/dist/.state`. `host/src/runtime-coordinator.ts` uses the packaged `agent-system/spatial-api` declarations. `COORDINATOR-BUILD.md` describes verifying the committed declarations against the selected build. The installed host package contains neither that development artifact nor coordinator runtime. Runtime startup loads the separately selected reviewed build's command factory through explicit owner configuration and activation checks. Activation and CLI login provisioning belong to owner setup, not this constructor.

`RuntimeProfile` requires `runtime`, `bin`, `configDirectory`, `dataDirectory`, `scriptDirectory`, explicit `models: [{id, efforts}]`, and the existing coordinator `subscriptionId`. Interactive and legacy paths must use the same account/admission identity. Pi IDs are exact `provider/modelId`; Claude IDs are full resolved model IDs, not fuzzy aliases. No runtime/model/effort default or fallback is selected. Login uses the existing CLI in an app-owned protected profile (existing config directory mode 700, no symlink traversal). Runtime execution verifies those permissions; it never changes personal/harness configuration permissions. No token/key enters tool context or exported diagnostics. `runtimeAuthentication(profile): Promise<boolean>` must verify that the selected CLI login and the account used by the usage reader are the same approved account; a directory alone is not authentication proof. The optional hook defaults false/BLOCKED, runs during readiness and again immediately before prompt input. `probe()` bypasses it only to stop at verified preprompt discovery, never to send a model prompt.

### Fixed environment port

`environment(submission, runId)` returns `FixedTaskEnvironment` from `runtime-tools.ts`:

- `tools: Readonly<TaskTools>` from immutable `broker.agent(preflight)`;
- fixed product `taskId` and the admitted snapshot's `epoch`;
- `frame(view)` and `identity(view)` closures bound to this task;
- **no** owner port, role selector, coordinator instance, credential or Docker mount.

Bind the preflight to `bridge.assertTaskToolAllowed(submission.id, runId)`. Invoke it **inside** the broker's mutation queue and before/after read/frame awaits, not just before enqueueing. The parent binding must also verify the fixed task, admitted epoch and agent lease. Frame identity must match the same environment/view generation. `task_input` requires a previously inspected frame; replacing/reconnecting a view invalidates old input. A space conversation returns null for the environment and cannot acquire `task-tools` authority just by navigation.

### Service methods

| Method | Behavior |
|---|---|
| `readiness()` | Shows missing activation/operator/profile and honest unproven runtime state |
| `validateSettings(settings, owner)` | Authenticates owner; checks explicit configured runtime/model/effort |
| `queue(submission, owner)` | Uses the already persisted outbox record; returns after scheduling |
| `reconcile()` | Public coordinator recovery then lookup and review-request refresh; no worker restart, inference or effect replay; cached running records stay uncertain unless this adapter owns a confirmed live worker |
| `refreshReviews()` | Producer-only refresh of open run-backed review evidence; retains a new Inbox version when evidence, run status or current authority changes; performs no inference/recovery |
| `waitForIdle()` | Waits for currently bounded local submissions; useful for orderly host shutdown/tests |
| `interrupt(task, 'turn', owner)` | Clears Pi queues then aborts, or sends Claude interrupt; task/history survive |
| `interrupt(task, 'task', owner)` | Retains a task cancellation fence, uses owner-gated coordinator stop; uncertain effects remain |
| `decide(request, decision, owner)` | Retains questions/reviews in the exact destination; typed approval ID/version confirms only matching existing authority for a pinned actual refusal. Confirmation commits exact coordinator/product receipts, never a grant or resumed turn |
| `approveScope(owner, ApprovalInput)` | Explicit owner-authenticated coordinator approval; never called by tools/defaults |
| `createGrant(owner, GrantInput)` | Explicit owner-authenticated coordinator grant; never called automatically |

The model's `task_request` creates only question/review requests. Scope widening needs an exact authenticated owner setup operation. The bridge does not activate coordinator code, create policy, register an auth account, or approve its own work.

## One execution control plane

The feature coordinator adds these typed public methods:

- `interactiveSubmit(input: DispatchTaskInput): Promise<InteractiveSubmissionWithRun | undefined>`;
- `interactiveLookup(requestId: string): InteractiveSubmissionWithRun | undefined`;
- `interactiveSessionRecord(runId: string, requestId: string, session: {id: string; file?: string}): RunRecord`;
- `currentAuthoritySettings(runId: string, action?: ActionId, requireRunning?: boolean): CurrentAuthoritySettings`;
- `interactiveEvidencePin(runId: string): InteractiveEvidencePin`;
- `interactiveReviewRecord(actor: Actor, input: InteractiveReviewInput): InteractiveReviewRecord`;
- `interactiveRuntimeResultRecord(runId: string, requestId: string, result: DispatchResult): void`.

The selected coordinator also exposes operator-gated `authorityPreviewForOperator(actor, input)` (read-only scope coverage, no capacity/provider calls) and `authorityConfirmationRecord(actor, input, recordWith)` (existing shared fence with synchronous current-version product transaction and exact idempotent owner receipt). Original received envelopes/fingerprints stay immutable; explicit approval selection is a separate binding. Prepared/archive and changed parent authority remain read-only. See `HOST-SETUP.md` for exact CLI limits and safe approval registration/reload; these methods never issue authority or replay inference.

Review pins contain run identity/digest, authority reference/version, current evidence byte digest and candidate head. Owner review receipt publication shares coordinator dispatch/run locks with revocation, result evidence and final run recording. Changing grant/evidence/head or the task's current attempt invalidates the old request, even if its product Inbox version did not change. The producer refreshes open review pins after run settlement and on reconciliation/read refresh, retaining each prior Inbox version. The owner must inspect the new version; `decide()` never repins. Revoked authority is shown as blocked and still refuses review. A new attempt does not silently replace the pinned attempt. Ordinary questions remain data; reviews issue no grant, delivery or merge authority.

`InteractiveSubmissionWithRun` is the durable receipt/fingerprint/state/result plus optional `run`; `CurrentAuthoritySettings` is a refused authority outcome or an allowed authority/limits/run/request record. Only trusted host composition may publish a runtime handshake; no client/model tool route exposes it. Interactive requests use `entry: 'interactive'`, not the side-effect-free evaluator `prompt` entry. At the shared command boundary, `conversation`/`task-tools`/`delegate-task` actions require the exact received interactive submission. Omitting entry through CLI/MCP/UI or naming a legacy entry cannot turn these grants into host tools. Existing coding-action flows stay unchanged. Legacy adapters reject the new entry; only `guardedInteractive` adapters may receive it.

The public product `Submission.id` is the coordinator request key. The logical conversation determines a stable coordinator task ID. The coordinator stores receipt/fingerprint before core dispatch and records the request identity on the admitted run. Duplicate calls return the existing request/run; changed payloads under the same key fail. Product updates cannot clear/change those linked identities. The existing coordinator atomic claim, grant/task attempt caps, subscription reservations and evidence remain authoritative. The product adds no grant store, scheduler or reservation system.

Submitted/uncertain outbox records go through public coordinator recovery and lookup on host recovery. A cached running record is not a live-worker proof: without a locally owned live guarded worker, the product shows recovering/uncertain. A receipt with no run is still uncertain: a lost submitter is **not** an automatic retry license. A run with unknown effects retains its limits/reservations. A guarded setup failure that proves no prompt was sent and finishes process/tool teardown releases its reservation and does not spend an attempt; failed acceptance after writing input remains uncertain. Completed runs reconcile product messages without another model call. Headset disconnect does not abort the host worker. A host loss cannot be described as continued execution.

Custom tool requests are retained before the broker call, with submission/run/task provenance. Results retain text and source identity; frame records carry image digests and actual frame identities rather than duplicating image bytes into conversation snapshots. Mutating acknowledgements that fail after sending remain sticky `remote-uncertain` in the durable runtime result, coordinator run and product submission/task, even if later tools succeed, the model finishes normally or the CLI exits cleanly. The coordinator keeps the reservation outstanding until actual effect reconciliation; recovery never replays tools. Only an actual host `EnvironmentError` with `effectState: 'not-sent'` proves a broker preflight denial. Post-send operation or authority/lease failures carry `effectState: 'uncertain'`, including when a replacement environment looks healthy. Arbitrary tool errors cannot claim clean effects through lookalike properties. Read failures and `ToolResult.isError` alone do not imply uncertain mutations. Runtime identity is published through the coordinator's trusted handshake method before prompt input and retained separately from bounded attempts. Idle conversations hold no model process or admission reservation. CLI processes close after settlement; teardown probes the whole process group independently of leader/stdio close, keeps TERM/KILL escalation after leader exit and refuses to claim group absence when unproven. Private sockets drain pending host effects before publishing a settled runtime result. Failed group/tool teardown retains the turn lock and uncertain outcome. A stale private turn lock is a recovery stop condition, not permission to spawn a duplicate.

## Tool boundary

Nine tools exist: `task_exec`, `task_read`, `task_write`, `task_frame`, `task_input`, `task_context`, `task_source`, `task_request`, `task_delegate`. Schemas contain no task/role/operator/epoch/model/runtime/project selectors. A trusted fixed binding supplies those identities. No host Bash/Read, network connector, agent/subagent operator, server creation or container-control tool is available. Actual shell/code/browser/desktop work goes through the offline EnvironmentBroker environment.

`task_source {sourceId}` reads only owner-registered text/file notes accessible to the fixed receiver's space. The default ProductStore path preserves source/project/space provenance and same-project ancestor access; Overview and other projects are not inherited. Content remains untrusted data, not commands or operator decisions. `task_context` exposes accessible source metadata. Optional `contextSources(submission)` / `readSource(submission, sourceId)` hooks must preserve this same read-only boundary and contain no host-file/credential connector. Source reads check conversation authority before and after awaits.

### Delegated instruction provenance

The guarded bridge supplies host-internal `CreateTaskInput.origin` from its fixed parent submission and admitted run, never from tool arguments. The initial child message retains the exact prompt text with `role: 'agent'` and optional `origin: { kind: 'agent-delegation', parentConversationId, parentTaskId, coordinatorParentRunId }`. This identifies a request authored by the parent agent, not the child's prior answer or an authenticated owner instruction. Project-space agents have `parentTaskId: null`; their conversation and coordinator run IDs remain retained. Authenticated owner tasks and follow-ups keep `role: 'owner'` and their exact text, including owner tasks with an explicit parent task. HTTP task creation accepts no origin fields; the tool schema accepts no parent/run selectors.

`task_context` returns message origin metadata unchanged and exposes the task's initial origin in `source.origin`, even after the instruction leaves the bounded history page. Parent context also includes children delegated by its space conversation. The first delegated SDK input uses a JSON `{ kind: 'delegated-task-request', role: 'agent', origin, text }` envelope; the SDK's user transport role does not claim human authorship. Owner input remains unchanged. Origin is stored in existing SQLite JSON records and retained by restart/history export without a database-version change or relabelling legacy history. Its recorded parent run preserves coordinator ancestry on later child turns; it does not create authority, grants, or a separate budget.

Every operation rechecks the recorded action and current authority reference/version, including parent delegation authority, plus the environment epoch. Children remain in the current project/space, inherit runtime/model/effort, use the same exact authority and share the root parent's attempt/concurrency envelope. They do not gain authority from model prose. A concurrency envelope already full can block child admission; delegation does not reserve an idle worker while waiting.

Pi runs RPC with `--no-builtin-tools --no-extensions -e <trusted runtime-pi-extension.mjs> --no-context-files --no-skills --no-prompt-templates --offline`, an explicit custom tool list and protected CWD/session/config. The private RPC command allowlist excludes raw `bash`, model/session changes and arbitrary user commands. The trusted extension also denies `user_bash`; automatic retry, compaction and cache warming are disabled for the bounded run. Exact model, effort and session state plus active tool/command inventory are checked before prompt.

Claude runs `--restricted --tools '' --strict-mcp-config --setting-sources ''`, explicit app-owned MCP, disabled hooks/slash commands/chrome and a custom-tool-only permission list. `--safe-mode` is deliberately absent: it can suppress MCP. A preprompt initialize/MCP-status handshake verifies the connected explicit server and exact tools before user input. It does not forward account fields or diagnostics to clients/tools. Built-ins are disabled by the explicit empty tool set. The protected profile must contain no installed plugins; no project-supplied plugin is loaded.

## Private byte streams

Runtime records use newline framing; a socket/pipe chunk is not a complete UTF-8 string. The private tool socket request in `runtime-adapters.ts` and result sockets in both `runtime-mcp.mjs` and `runtime-pi-extension.mjs` use a per-connection `StringDecoder`. MCP stdin and `RuntimeProcess` stdout frame raw bytes before decoding complete records. Bounds count raw bytes, including a partial UTF-8 suffix: 2,000,000 for tool requests/MCP input and 20,000,000 for tool results/runtime stdout. EOF does not flush an incomplete record into a request or acknowledgement. Runtime stderr is drained without decoding, retaining or forwarding provider diagnostics. Complete file reads and base64 image encoding are not streaming text conversions.

This transport handling does not classify tool errors or release reservations. Lost/truncated acknowledgements remain failures; existing sticky uncertain-effect tracking and whole-process-group teardown still apply. `runtime-wire.test.ts` exercises the actual MCP/extension selectors with split euro/emoji bytes, multibyte byte-bound failures and truncated EOF; adapter tests send split `task_write` arguments through the real private bridge.

## Verification and limits

Build, type, lint, and test commands in this section require the source checkout and development dependencies. Runtime discovery is also shipped in the installed package; it does not compile the host.

Verify the committed coordinator API declarations against the selected build and set `SPATIAL_COORDINATOR_DIST`, then run product `npm run typecheck`, `npm run lint`, `npm test`. Targeted bridge tests are `build/host/tests/execution.test.js`, `runtime-adapters.test.js` and `runtime-tools.test.js`; core public API tests are `dist/core/interactive.test.js`.

Tests exercise fixture streaming/follow-up, exact settings, current grant revocation, forged tool/identity denial, stale frames, durable submission/run linkage, bounded delegation, missing activation/scope, unknown effects, and lost product acknowledgement. Public-core/memory-broker fixtures cover mutation followed by lost acknowledgement, post-send revocation with a healthy current broker snapshot, definite preflight denial, retained outstanding reservations/no replay, and producer-owned review pin/version refresh after settlement. Provenance fixtures exercise public owner project-space submission through the real coordinator and temporary CLI bridge into child creation and `task_context`, nullable product parent IDs, exact initial prompt envelopes, HTTP origin-forgery rejection, owner-created children, follow-up ancestry beyond the history page, SQLite reopen, and history export. Execution fixtures also repeat in fresh test processes to check retained-session/source follow-ups. For an explicitly supplied trusted `RuntimeProfile.json`, `node scripts/runtime-discovery.mjs --profile <file> --model <exact ID> --effort <native effort>` performs only the same preprompt discovery and returns sanitized inventory, never a model prompt.

Tests also launch the installed Pi 0.99.2 and Claude 2.1.287 **only for tool discovery/preprompt handshake**, with no user prompt or provider inference. CLI paths can be supplied by `SPATIAL_PI_BIN` / `SPATIAL_CLAUDE_BIN`.

This evidence does **not** pass real-provider, paid-call, installed headset, comfort, production activation or complete workflow gates. Those remain BLOCKED until explicitly authorized owner accounts/test scopes and device evidence exist. Missing prerequisites are not fixture successes. Only the offline Linux environment is supported; no broad external-account GUI or personal desktop automation is claimed.
