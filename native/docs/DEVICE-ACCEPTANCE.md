# Native device acceptance

Status: own-app installation and launch are authorized and exercised on the USB Quest 3. Windows loopback/pinned native HTTPS and own-port USB reverse are verified. Pairing, actual app rendering and input remain BLOCKED: the device currently reports `mCurrentFocus=null`. No screenshot or setup input was sent to an unproven foreground surface. APK/build/activity/process evidence alone does not pass the full product Manifest.

## Preconditions

- Parent has inspected APK identity, Android ARM64, signature, permissions, backup/cleartext flags, package versions and build/test evidence.
- Owner authorizes headset install/launch. The build script never does this automatically. The separate device script requires an explicit mode and authorized exact device serial.
- Host has a trusted certificate, current pairing code and permitted network reachability; owner supplies real project data.
- Host readiness names real supported runtimes, bounded task environments, speech providers and paid-call controls. Missing readiness remains blocked, not a fixture adapter.
- Shared coordinator activation follows its writer/version inventory and existing change controls; installing the app does not grant authority.

## Required device checks

| Check | Evidence |
|---|---|
| Boot unpaired | Actual headset render; no provider/model/mic execution |
| Pair correct pin / reject wrong pin, redirect and revoked token | Host auth record and device recovery surface, with no token in logs |
| Private storage across restart/uninstall | Keystore/app-private ciphertext behavior; backup disabled; no plaintext credentials or exported audio |
| Enter project and nested child, Back/recenter in VR/MR | Actual captures: stable headset viewpoint, open surrounding nodes, readable panels |
| Select task then its browser/terminal/application views | Same conversation/task/environment identity; no gaze/background focus steal |
| Controller trigger / deliberate right-hand pinch / keyboard | Real press evidence and legibility; verify left app Menu (keyboard F1 alternative) Inbox and right A PTT bindings; the right Meta button is not intercepted |
| Global Inbox jump/jump/Return | First origin task/view/receiver restored; Back remains separate; missing destination retains recovery point |
| Owner decision | Exact request/version/evidence; stale/forged/revoked decision refused by host |
| Take/resume control | Acknowledged exclusive lease; stale/racing/cross-task input rejected, pending/uncertain shown honestly |
| Disabled/denied mic | No capture/upload; visible refusal recovery and Text fallback |
| Enabled hands-free/PTT | Real transcript receiver captured at onset; navigate/jump mid-turn without retargeting |
| Spoken replies/stop/interruption | No playback before enable; no off-context output; no output-echo turns; stop audio distinct from turn/task cancellation |
| Focus/session/connection loss | Capture/playback stop, input disabled, reconnect observes snapshot without repeating effects |
| Leave headset with task running | Real coordinator continues within scope; retained result/history returns after reconnect |
| Baseline 30 minutes at 72Hz in VR/MR | 50 nodes, six tasks, two running, one active view/bounded previews; actual p95 CPU/GPU ≤13.9ms, memory trend and wearer readability |

## Authorized device commands

```powershell
.\scripts\native-device.ps1 -Mode Inspect -Serial <authorized-Quest-serial>
.\scripts\native-device.ps1 -Mode Reverse -Serial <authorized-Quest-serial>
.\scripts\native-device.ps1 -Mode Install -Serial <authorized-Quest-serial>
.\scripts\native-device.ps1 -Mode Launch -Serial <authorized-Quest-serial>
.\scripts\native-device.ps1 -Mode Diagnose -Serial <authorized-Quest-serial>
.\scripts\native-device.ps1 -Mode Capture -Serial <authorized-Quest-serial>
```

`Reverse` proves Windows localhost access to the real console and exact certificate-pinned native HTTPS health endpoint before mapping only TCP47843. It does not change firewall or portproxy rules. `Install` uses `-r`, never uninstall/data-clear. `Capture`, `Tap`, `Key` and `Text` require the own app resumed **and** the current focused window to belong to it. Null/foreign focus blocks capture/input. `Text` reads ASCII setup text from a private file, not logged command arguments; use only for deliberate authorized app setup. Evidence stays under ignored `native/artifacts/device-*`. No command requests microphone permission, grants a permission or changes headset/proximity settings. If the headset is asleep/unworn, the owner must make the app active normally; do not force a fake wearable pass.

Keep provider credentials, pairing codes/tokens and raw audio out of test exports. Use only owner-approved scopes and real project content. Store installed-device captures, host/coordinator request/run/environment/lease/frame IDs and timing evidence under the product's operational evidence policy. Never label an uncertain cancellation/takeover or missing provider as passed.
