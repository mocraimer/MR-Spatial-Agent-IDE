# Native verification — 2026-10-02

The `artifacts/` evidence and hashes named in this record were kept locally and are not published.

## Native boundary and voice-testability repair — latest rebuild

Fresh Unity6000.6.0f1 checks: **31 EditMode / 11 PlayMode tests pass**, zero failed/skipped. Android ARM64 IL2CPP build passes with zero errors and four existing SDK warnings. Evidence is copied under `artifacts/boundary-repair/`; source hashes and scope notes are there too.

| Artifact | SHA256 / result |
|---|---|
| Rebuilt `artifacts/spatial-workspace.apk` | (hash recorded locally) |
| Original debug signer retained | (hash recorded locally); v2 verified, one signer |
| APK identity | `local.spatial.workspace`, version0.1.0/code1, ARM64 |
| Actual installed build, parent-owned evidence | **the previously built APK**, its hash matching the one recorded on the device |

This rebuilt APK is **not installed by this lane**. Parent owns the next update. Quest is connected but current window focus remains null per parent; capture/input remain blocked. No device/ADB action, microphone acquisition/permission request, provider call, global setting, other app operation or keystore copy occurred here.

Tests exercise typed optional delegation origin through snapshot/history round-trip, absent origin, preserved parent provenance, real owner previews, delegated-instruction preview/speech exclusion, Pair/Forget cache reset, lower new-host revision acceptance, stale epoch callbacks and same-identity monotonic revision. Voice tests drive the actual sample/Finish/Submit path without microphone IO: A captured then B selected still sends once to A; 3,200 samples send and 3,199 do not; repeated Finish and session loss add no request; onset, 0.8-second silence and 25-second cap are deterministic. The privacy test seeds all three protected strings with distinct dummy values and developer/debugger flags true, invokes actual Scrub, asserts every string empty/flag false and restores fixture values. Existing build scrubbing remains unchanged.

Authored scope: `Protocol.cs`, `HostClient.cs`, `WorkspaceState.cs`, `SpatialWorkspace.cs`, approved `VoiceSession.cs`, new plain `VoiceTurnDetector.cs` and its Unity metadata; matching EditMode/PlayMode tests; these native docs. Unity test/build serialization also rewrote generated `Workspace.unity` and `ImmersiveDebuggerSettings.asset` (protected debugger flags remain false). Other writers' host/environment/docs deltas are listed separately in the source snapshot, not claimed as this lane's edits. The product is unborn, so `git diff --name-only` is empty and is not sufficient scope evidence; the untracked-file inventory and SHA256 snapshots supplement it.

Independent delta review remains pending. Automated sample/UI tests and a signed APK do not establish real headset rendering/input, actual TLS/Keystore pairing, speech provider quality, wearer comfort or performance acceptance.

## Previous owner-decision continuation

Fresh checks for the owner-decision fixes: **26 EditMode / 6 PlayMode tests pass**, and the Android ARM64 IL2CPP build passes. Evidence is the current `artifacts/editmode-results.xml`, `playmode-results.xml`, test/build logs and `build-summary.json`. Complete Inbox evidence now has newline-safe pages and last-page Decision, deferred requests stay visible/jumpable, obsolete reviews retain old pins and disable the unavailable Review action while Dismiss stays available, and explicit dismissal/owner dispositions stay inspectable read-only. Batch tests do not verify wearer input or readability.

The rebuilt APK's signature check verifies the unchanged signer below and the v2 signature. That continuation's owned-app update was **BLOCKED before install** by an empty ADB list. Parent later installed and verified the previously built APK, as recorded above; the earlier installed hashes below remain historical. Actual VR/MR remains unverified.

See `../../docs/OWNER-DECISION-VERIFICATION.md` for host/coordinator fixture journeys, commands, source scope and limits.

## Previous installed-build results

| Command / inspection | Result | Evidence under `native/artifacts/` |
|---|---|---|
| `scripts/native-build.ps1 -Mode EditMode` | PASS: 23 tests, 0 failed/skipped | `editmode.log`, `editmode-results.xml`, `editmode-launch.log` |
| `scripts/native-build.ps1 -Mode PlayMode` | PASS: 5 tests, 0 failed/skipped | `playmode.log`, `playmode-results.xml`, `playmode-launch.log` |
| `scripts/native-build.ps1 -Mode Build` | PASS: Unity6000.6.0f1, Android ARM64 IL2CPP, 0 errors, 4 warnings | `build.log`, `build-summary.json`, `build-launch.log` |
| Installed SDK `apksigner verify --verbose --print-certs` | PASS: same Android Debug RSA2048 signer as the first build; v2 signature | `apk-signature-current.log` |
| Authorized ADB target inspection | Quest3, Android14, authorized `device` | local device evidence |
| Windows localhost transport | Real loopback console health and exact setup-certificate-pinned HTTPS health pass; only TCP47843 reversed over USB | local device evidence |
| Own-app first install | `adb install -r` reports Success; no other app/data operation | local device evidence |
| Updated final APK install | `adb install -r` reports Success; retained first-install time and app data inode | local device evidence |
| Final own-app launch | Explicit UnityPlayerGameActivity intent accepted | local device evidence |
| Installed package/hash/process | ARM64, version0.1.0/code1, own process11819; on-device base.apk SHA256 equals delivered APK | local device evidence |
| Guarded own-app capture | BLOCKED: `mCurrentFocus=null`, despite own focused-app/activity records; no screenshot taken | local device evidence |
| Microphone | Remains off in native defaults/tests; device RECORD_AUDIO remains ungranted. No capture or permission request was performed | local device evidence |
| Source scope | No tracked diff in unborn product repo; native source additions inventoried; this continuation edits only `native/**` and `scripts/native-device.ps1` | `changed-files.txt` |

Previous delivered and installed APK: `native/artifacts/spatial-workspace.apk`, 47,394,563 bytes.

The APK and signer hashes are recorded locally.

The initial APK hash was (hash recorded locally); it had not been installed. An intermediate APK (hash recorded locally) was installed before the dialog/keyboard repair, then updated in place with that previous verified build. Both retain the initial debug signer. Preserve the Windows debug keystore in the user's `.android` directory for future personal updates. Read-only custody evidence (`artifacts/signing-custody.json`) shows it last changed2026-09-05, before this work; no key material was copied or exported. No release key, publishing or account operation was performed.

The product repository had no commit at that time, and none was made. Windows evidence filenames use local time; Unity XML records UTC. The final test run records EditMode11:18:41Z and PlayMode11:19:05Z.

One install tool wrapper timed out after its script had recorded Success and package evidence because a newly started Windows ADB daemon held inherited WSL handles. Subsequent commands use a hidden isolated ADB process, explicit process-handle retention and exit checking. The separate final launch/diagnostics finished successfully; installed-byte hash and retained package state establish the update independently of that wrapper timeout.

## Changes exercised

- Current task lease recovery uses the actual host GET route without a frame or invented epoch. Confirmation retains the exact warning epoch; a read lease is never an input acknowledgment.
- Project-root edits use the project route; child moves choose observed same-project parents outside descendants. Connect/disconnect and node/task placement use existing durable routes.
- Registered source metadata/content comes from actual host source routes and displays provenance/space/hash. No fabricated capture/import action or arbitrary host-file reader was added.
- The Inbox shortcut resolves only to the left OpenXR app-menu control in an Input System layout test, not the right Meta button. F1 and application-camera mouse/touch selection provide accessibility alternatives; hardware operation is unverified.
- Owner details/confirmation dialogs survive snapshot redraw. Explicit close removes their targets before deferred destruction. Repeated identical status/content no longer rebuilds all panels. Chained keyboard fields close the previous keyboard before opening the next; real platform typing remains unverified.
- Existing recipient locks, scoped navigation, generation/lease/pixel fencing, reset confirmation, TLS origin/pin, nullable wire, WAV, bounded timing and credential-scrubbing tests still pass. The 50-node/six-window fixture test remains a technical UI test, not real AI fulfillment or workload performance evidence.

## Build warnings

Four existing SDK warnings remain visible: two features request an older OpenXR patch version; a Meta prebuild GameActivity check reads an earlier/default manifest; the static passthrough checker sees the default opaque VR camera. The final merged manifest has the single UnityPlayerGameActivity, backup/cleartext disabled and automatic permission prompts skipped. Runtime MR requires initialized passthrough and changes camera alpha; actual device behavior is not established by these warnings or source checks.

## Blocked and unverified

- **Device rendering/pairing/input:** the app is installed and its activity/process launch, but current window focus is null. Capture and automated setup input refuse that state. No PNG was captured, so there is no actual image to inspect and no device rendering PASS. The owner must make the app active normally; no proximity, sleep, system-button or global-setting workaround was used. VR/MR, readability, controllers/hands, keyboard, Android Keystore execution and actual native HTTPS pairing remain unverified.
- **AC1/live agents/authority:** the parent-owned actual host is empty with coordinator/profiles/providers blocked by default. No fixture provider, authority grant, coordinator activation or simulated successful task was introduced. Actual task streaming/takeover/input and full AI workflow remain BLOCKED.
- **AC4/voice:** no permitted real speech provider key or paid-call budget is configured. Device mic was neither enabled nor granted. Real transcription/replies/echo and wearable focus traces remain BLOCKED; WAV/state tests are not substitutes.
- **AC6.3/performance:** no worn continuous30-minute VR/MR workload or wearer comfort/readability evidence exists. App/process/package evidence and batch tests cannot establish p95 CPU/GPU13.9ms or comfort.
- **Full release/reviews:** native tests/build/install do not pass all Manifest gates. Cross-repository checks, independent reviews and configured live/device/provider workflows remain the supervising executor's work.

No host service was started or stopped by this continuation; transport probes used the parent-owned real main instance. No global firewall/portproxy change, app-data wipe, other-app installation/input/capture, microphone grant/enable, raw audio, privileged grant or publishing occurred.
