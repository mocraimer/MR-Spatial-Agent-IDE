# Quest native client

Unity 6000.6.0f1, Android ARM64/IL2CPP, Quest 3, OpenXR 1.18.0. This is the native production API path, not a simulated-agent demo. It starts unpaired, with microphone and spoken replies off. Missing host/coordinator/environment/provider capabilities remain blocked and include recovery advice.

## Build and test

Run from Windows PowerShell, or invoke Windows PowerShell from WSL:

```powershell
.\scripts\native-build.ps1 -Mode EditMode
.\scripts\native-build.ps1 -Mode PlayMode
.\scripts\native-build.ps1 -Mode Build
```

Only `native/` is opened/built. The script checks process exit codes and test results; a missing/empty/failed test report fails. `Compile` and `Configure` modes are available for diagnosis. Keep source files unchanged while Unity builds: changing serialized class fields mid-build can invalidate editor/player layout matching.

Outputs are under `native/artifacts/`: test XML, per-mode Unity logs, build-summary JSON, and `spatial-workspace.apk`. The script prints the APK's SHA-256 hash. Unity uses its local Android debug signing key for this personal build; this is **not** a store release or an owner release-signing setup. Preserve the signing key for updates. The build script does not install or launch. `scripts/native-device.ps1` separately supports an explicitly authorized own-app install/update, launch, diagnostics, guarded capture/setup input and USB reverse. It requires an exact ADB-authorized Quest 3 serial, uses the installed Unity ADB executable and checks APK identity before `install -r`. It never wipes app data, grants permissions or changes headset/global settings.

## Pairing

1. Start the owner's host through its separately authorized setup process.
2. Obtain its HTTPS origin, SHA-256 **certificate** fingerprint and expiring one-time code from the trusted host setup screen.
3. Enter those three values using the app's native keyboard, then choose Pair this Quest.

The client rejects HTTP, URL credentials, non-origin URLs, wrong certificates and redirects. It never discovers trust from the pairing endpoint. Tokens and pins use app-private ciphertext under Android `noBackupFilesDir`; a non-exportable AES-256-GCM key lives in Android Keystore. Android backup and cleartext traffic are disabled. This does not protect against a trusted host administrator, a compromised OS or rooted device. Editor pairing is memory-only and is not persisted. Removing local pairing does not revoke its host token: revoke that client in host setup too.

## Space and receiver controls

- Enter a sphere or its Enter space control using either tracked controller's trigger or either tracked hand's deliberate index pinch. Looking does not select anything. The ray belongs to that tracked device, not head gaze.
- Spaces surround the stable workspace origin. Enter changes the space's children and conversation; it does not teleport or fly the headset. Recenter moves the workspace origin to current head yaw, never the camera.
- Select a retained task window to address its one conversation. Up to six task-owned preview/conversation windows remain spatially visible; task pages cover larger collections. Browser/terminal/desktop/artifact views retain that task's receiver and move with its persisted layout. Clear task selection restores the current space receiver.
- Up to 50 actual child/link/project nodes can surround an entered space; larger collections have pages. No fabricated projects or tasks are added to fill that load.
- Parent Back enters the parent. **All projects Inbox** has no agent and does not change receiver just by opening. A Jump selects its exact destination. Return to origin restores the first interrupted space/task/view across multiple jumps.
- **Left-controller app Menu** opens All projects Inbox; keyboard **F1** provides the same local shortcut. This binds the left OpenXR `menuButton`, not the right Meta/system button. An Input System layout test verifies that distinction; physical-device operation remains unverified. **Right-controller A** is push-to-talk after explicit PTT enable. Mouse/touch selection uses the application's own camera ray as an accessibility path, not system-button interception.
- Place window arms a single deliberate placement selection. Placement is persisted through the host task-layout route. Nullable/missing layouts use readable defaults. Local navigation stores only location identities, not messages or credentials.
- This space controls create projects/child spaces, edit names/purpose, move children among observed same-project parents and connect/disconnect registered spaces. Project-root edits update both project and root identities. Place on a node persists its spatial position; task Place window persists its layout. Registered context sources reads actual host-uploaded metadata/content with provenance; uploading and archive/export remain on host companion.
- Setup and text use an app-owned keyboard selected with the same tracked rays and trigger/pinch as other buttons, including before pairing. Shift changes letter case; Symbols includes URI/fingerprint punctuation. Space, Backspace and Clear edit at the end. Previous/Next text shows long values without shortening the saved text. Done confirms the field; Cancel, navigation, host changes and app focus/pause loss discard the draft. Pairing codes stay masked. The editor blocks background selection and suppresses microphone capture without changing voice preferences. Platform overlay keyboard availability is not required; wearer interaction remains a separate device check.

## Tracked input and model matrix

| Input | Left and right visuals | Selection and pose source | Loss / switching |
|---|---|---|---|
| Touch controllers | SDK `OVRControllerPrefab`, including actual Quest 3 Touch Plus meshes and button animation; SDK chooses the hardware model | SDK controller anchor under the same `OVRCameraRig.trackingSpace` as the head; that exact model anchor supplies the trigger ray | Connection, tracked position/rotation, valid pose, held state and app input focus gate visibility. No stale model or ray on loss. |
| Articulated hands | SDK `OVRHandPrefab`: runtime `OVRMesh`, `OVRSkeleton`, `OVRMeshRenderer`, `SkinnedMeshRenderer`; SDK `Meta/Lit` material supports the built-in pipeline | Root pose, scale and every articulated bone come from `OVRHand` in the rig's tracking space. Its SDK pointer pose supplies the pinch ray in that same space. | Valid/high-confidence camera-tracked hand and initialized skin required; inferred/controller-driven hands are not substituted. Invalid pointer, low-confidence pinch fingers and system gestures cannot select. |

Both sides have independent rays and release-armed selection. Beam endpoints refresh after the SDK's before-render controller pose update; that render-only refresh never selects or places anything. Holding trigger or pinch during first acquisition, controller → hand → controller switching, pointer invalidity, tracking loss or focus loss cannot select: release, then press/pinch again. Mode changes never choose a task or recipient. Each side keeps an inactive, explicitly configured SDK hand template. Runtime hand tracking starts a fresh instance; its skin binds once the real mesh and skeleton are ready, not to an invented mesh. Failed SDK initialization retries with fresh instances at one-second intervals, at most three per tracked acquisition. Failed instances and their allocated mesh/skeleton children are disposed. Exhaustion keeps the unavailable hand hidden, leaves controllers as the tracked fallback, and resets the retry budget when hand tracking is lost and reacquired. A working instance retains its real pose data; replacement disarms selection.

The app supports controllers **or** hands when the runtime tracks them. A held controller takes priority on its side; otherwise a genuinely tracked hand can take over. Both sides can render independently when the runtime provides those actual inputs. This does not enable global headset settings or advertise simultaneous hands-and-controllers support; it does not fabricate hands while holding controllers. Menu/F1 and explicitly enabled right-A PTT retain their separate roles. Losing the right controller, switching it to hands or losing app focus cancels/discards any held PTT turn without sending, changing enable/permission/session preferences or keeping capture held. A real A release from the same still-tracked device finishes exactly once; holding A on reacquisition requires release before a new turn. Input System reset/disconnect events cancel independently of the button-up edge. After reset, that device stays blocked until a fresh input event actually contains its A control; a stale reset zero cannot count as release.

EditMode checks the saved app scene's two-sided SDK instances, shared tracking space, sided types, real controller meshes and package material/shader references. It also reads raw scene prefab overrides to verify both OpenXR skeleton/mesh types without Editor `OnValidate` repair, and tests bounded failed-load recovery policy. PlayMode tests renderer gating, release-armed acquisition/loss/switching on both sides, late-updated model/ray alignment without action dispatch, and actual runtime-instance replacement/cleanup through a deterministic readiness seam. These tests do **not** prove the runtime-delivered hand mesh, wearer-visible pose alignment or physical controller/hand interaction. Installation and checks while wearing the headset remain separate owner-authorized gates, performed only by the parent device lane after the final APK passes local checks: use both controllers, then both hands, then controllers again, including held pinch and tracking loss. No capture/debug interface was added.

## Voice privacy

Accepted voice navigation uses the host's explicit `local-command` / `open-global-inbox` acknowledgment identity only after its conversation/task match the captured receiver; it retains the original transcript rather than parsing it again. Typed owner commands normalize repeated whitespace, retaining the existing exact-command aliases. Ordinary questions and agent/content text never invoke this navigation path.

Enable hands-free or Enable PTT is required before permission is requested or capture can begin. The receiver is copied at turn onset and stays fixed through navigation, Inbox jumps and transcription. While recording, the receiver strip identifies that locked conversation separately from the current selection. A reply arriving during a recorded owner turn stays in text instead of cutting off input. Hands-free uses a local amplitude gate and 800 ms silence ending, capped at 25 seconds; PTT uses controller A release. Quiet speech/noise calibration still needs actual-device testing.

Capture stops/suppresses when disabled, unpermitted, disconnected, out of focus, paused, while the native keyboard owns input, and while reply audio plays (including a short output tail). Raw audio is not saved locally. On speech failure it is discarded; the owner can use Text to recover deliberately rather than blindly repeat uncertain work. Text retry preserves its submission key and original receiver within the running client.

Spoken replies need a separate owner enable. Only new completed replies to the current matching receiver are eligible. Off-space replies stay in retained text. Stop output only stops speech; Interrupt turn and Cancel task are different host commands, and neither request is presented as proof of cancellation. The current decoder accepts real PCM16 mono/stereo RIFF WAV (8–96 kHz); unsupported/provider-failed audio gives a visible text fallback.

## Task applications and takeover

Tool views come only from the host snapshot. Unavailable views explain their missing environment. Active actual PNG frames carry `X-Frame-Identity`; identity must match task/environment/view/generation and decoded dimensions. Input requires a host-acknowledged owner lease at that frame's epoch. Pending, handoff and uncertain leases do not enable input. The host still rechecks every operation; native checks are not the confinement boundary. Stale frames show their capture timestamp, not a fake live indicator.

Take control and Resume agent use expected lease epochs. If the host needs a workload reset, the app warns that unsaved application/process state may be lost. Only a separate Confirm restart action sends `confirmReset=true`; cancel does not claim takeover/resumption. Both transitions require this warning when the host asks for confirmation.

Pointer selection maps normalized in-world hits to top-left **pixel coordinates** in the displayed frame. Text input captures the original task/view/generation/epoch before opening the keyboard; it never redirects to a newly selected task. Enter, Backspace and Escape key controls use the same fencing. Browser, terminal and desktop frames use one active bounded PNG poll; background task windows show retained conversation previews, not extra streams. Terminal text inspects the actual bounded output route separately, not agent narration. Missing frame identity keeps input blocked.

Recovery reads the actual `GET /v1/tasks/:id/control` lease before an ordinary transition, even if frames/views are unavailable. Missing/wrong-task/zero-epoch leases block the request rather than inventing an epoch. Confirm restart preserves the warning's exact epoch; a later host change must be refused, not silently reconfirmed. A recovery lease alone never enables input.

After acknowledged control changes, the app refreshes its observed snapshot without repeating effects or dropping the connection, so environment/view generations can advance together. Owner dialogs survive background snapshot redraws; navigation/explicit close removes them. Identical status and content do not rebuild all spatial surfaces just because a poll timestamp changed.

## Evidence and remaining gates

EditMode tests cover recipient lock, navigation ownership, cross-project Inbox return, deleted/stale destinations, generation/lease and pixel fencing, reset-confirmation policy, pin/origin rules, wire null records, PCM conversion, bounded measured-timing summaries and SDK developer-credential scrubbing. PlayMode tests exercise in-world press coordinates, literal untrusted text, 50 observed open nodes/six retained task windows with stable head position, and voice-off/session-loss/overlapping-reply behavior without activating a microphone or provider.

The runtime requests the advertised 72 Hz app display mode and sends bounded real CPU/GPU frame-timing summaries and allocation counts to host telemetry. Missing native timing data is explicitly unavailable, not a passing zero. Rolling summaries are not proof of the full 30-minute/device/readability gate.

Meta SDK 205 auto-generates developer bridge credentials even with its developer assistant disabled. `PackagePrivacy` clears those token/address fields after the SDK's build callback and again after restoration; the generated DevAgentSettings asset is ignored by source control. The developer assistant and immersive debugger stay off. Runtime node/ray material assets are retained explicitly to avoid player shader stripping.

An owned APK has now been installed and launched on the authorized USB Quest 3; see `docs/VERIFICATION.md` for its exact hash and evidence. Windows loopback console and pinned HTTPS host reachability, then own-port USB reverse, were proved without global network changes. The headset reports no current focused window, so guarded captures/setup input are BLOCKED; installation/activity/process evidence is not rendering evidence.

These tests/builds do not establish installed-device rendering, controller/hand/keyboard/microphone behavior, Android Keystore execution, real host streaming/agent work, actual VR/MR passthrough, or the 30-minute CPU/GPU/readability target. Those remain explicit device/owner/provider gates in the full Manifest. See `docs/DEVICE-ACCEPTANCE.md` before authorized device validation. No live factory, account, authority or provider operation was performed by native build/test commands.
