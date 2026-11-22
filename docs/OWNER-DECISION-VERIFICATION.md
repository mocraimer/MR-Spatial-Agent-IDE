# Owner-decision journey fixes

This records implementation and private-fixture verification, not a release or live-workflow claim. No live grants, coordinator activation, provider/account changes, publishing, or canonical coordinator build/state changes were performed.

## Journeys exercised

| Journey | Evidence |
| --- | --- |
| Actual refusal → explicit CLI approval → private binding/reloaded bridge → confirmation → fresh deliberate admission | `host/tests/execution.test.ts`; real public coordinator, SQLite/HTTP boundary, and local guarded CLI fixture |
| Actual refusal → explicit CLI standing grant → confirmation without config mutation → fresh admission | Same test file; all per-task and aggregate CLI limits supplied explicitly |
| SQL acknowledgement loss after core receipt | Actual SQLite trigger rolls back the product decision; retry retains the same coordinator receipt, timestamp, authority/version, and original fingerprint |
| Changed request, scope/settings, selected version, activation, or parent; revoked authority | Product integration and `core/interactive-authority.test.ts`; no inference or new authority from confirmation |
| Answer → history rollover → fresh admitted `task_context` | Exact receiver's durable owner decision remains available beyond the recent-message window; no always-running waiting model |
| Superseded review → inspect old pin → explicit dismissal | Old run/evidence pin and all request versions stay retained; coordinator outcomes/reservations unchanged |
| Deferred jump and read-only dismissed history | Companion E2E and native navigation tests; current ID/version still required |
| Full native evidence before decision | Newline-heavy/unbroken text pagination, last-page Decision, old attempt ID, and disabled obsolete Review with available Dismiss tested in native EditMode/PlayMode |

The coordinator's preview is operator-gated and read-only. Confirmation uses ordinary `authorizeDispatch` with `checkCapacity:false` under the existing shared fence. Its synchronous host callback enters the current-version SQLite transaction before persisting the idempotent core receipt and owner choice. Escaped/asynchronous persistence refuses. Approval selection is separate from the original immutable dispatch fingerprint. Coverage does not establish runnable capacity; every new deliberate turn still enters ordinary admission and parent resource checks.

## Historical automated checks

| Check | Result |
| --- | --- |
| Coordinator `npm run typecheck`, `npm run lint`, `npm run build` | PASS |
| Coordinator full `npm run test:unit` after build | PASS: 1112 tests, 0 failed/skipped |
| Coordinator Playwright, unique output directory | PASS: 23 tests |
| Product `npm run typecheck`, `npm run lint`, `npm test` | PASS: 223 tests, 0 failed/skipped |
| Product Playwright, unique output directory | PASS: 6 tests |
| Selected declaration artifact verification | PASS |
| Unity native EditMode / PlayMode | PASS: 26 / 6 tests |
| Unity Android ARM64 IL2CPP build | PASS |
| APK signature | PASS: existing Android Debug RSA2048 signer, v2 signature |
| Owned APK update | BLOCKED before install: authorized Quest absent from ADB device list |

The coordinator was a dirty feature worktree at that time, and the product had no commit yet; an empty tracked diff is not a scope PASS. No commit was made. The declaration-only local artifact and lockfile were refreshed after the isolated feature build; this is not runtime activation.

Logs, native test results and source inventories were kept locally and are not published with this record.

## Historical native delivery limit

The rebuilt APK was signed with the existing Android debug signer; the v2 signature verified. At one attempt the selected Quest was absent from the ADB listing, and the owned-app install script refused before installing. The previously installed APK was the last verified device build; it did not prove installation of the rebuilt package. No device capture/input, microphone request/enable, proximity/sleep/global-setting change, or permission bypass occurred. Initial signature checking lacked process-local Java discovery; rerunning with the installed Unity OpenJDK passed without changing global configuration.

Actual worn VR/MR rendering, hands/controller use, speech, provider authentication, live authority/admission, and full Manifest acceptance remain unverified or blocked. These fixture and batch results do not lower G9/AC5 or establish the full release.

## Selected build and device status

The 2026-10-02 selected coordinator build is distinct from the historical snapshot, which was a dirty revision with 1112 passing tests. The selected build is a clean worktree; declaration verification matches it. The retained local integration log reports 1141 tests passed, with none failed or skipped; this documentation update did not rerun those tests.

At a later device check on 2026-10-02 the rebuilt APK was installed and launched, and the on-device APK hash matched the rebuilt APK.

The capture-guard evidence still records no current window focus (`mCurrentFocus=null`). Capture remains blocked. No image, device input, microphone enable or grant, real provider call, or coordinator cutover followed. Installation and launch do not establish wearer rendering, input, voice, or live-release acceptance.

For native status and the remaining device checks, see [Native verification — 2026-10-02](../native/docs/VERIFICATION.md) and [Native device acceptance](../native/docs/DEVICE-ACCEPTANCE.md). This update does not change native documentation or perform headset actions.
