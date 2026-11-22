# Earlier Quest app: usage guide

This guide is for the earlier native Quest app and its private host. For the spatial view of your Herdr sessions, see the [user guide](USER-GUIDE.md).

## Delivery status

Status for the 2026-10-02 installed build: the controller and hand update is installed, but the complete product is unfinished.

The delivery has these limits:

| Part | Status |
| --- | --- |
| Quest app | Installed and launched. 66 native tests pass. |
| Both controllers and articulated hands | Implemented and tested locally. Wearer visibility and interaction still need confirmation. |
| Computer connection | The test host runs; the verified cable connection reaches its private endpoint. Keep the headset connected for this trial. |
| Projects and spaces | Available to try after pairing. The test host uses temporary state, not the final installation. |
| Real agent tasks | Blocked until account setup and approved coordinator activation. |
| Voice and spoken replies | Off by default. Provider credentials, approved spending limits, and real-device checks remain incomplete. |
| Final readiness | Permanent host setup, remaining reviews, real workflows, and performance acceptance remain incomplete. |

Do not put important work into the temporary test host. The finished installation must use private retained storage and verified backup procedures.

## Check the input update

No pairing or voice enable is needed for this check:

1. Open **Spatial Agent Workspace** from the sideloaded apps in the Quest library.
2. Hold both controllers in view. Check that both controller models and rays appear.
3. Aim a ray at a button and press its trigger. Looking at a button does not select it.
4. Put the controllers down. Hold both hands where the headset can track them; check both articulated hand models.
5. Aim a hand ray at a button, then pinch with your index finger and thumb to select it.
6. Pick the controllers up again. After switching input or losing tracking, release the trigger or pinch before selecting again.

If a hand model fails to load, the app names the affected side. Use controllers, or lower that hand out of tracking and raise it again to retry.

Keep voice off during this check. Missing hands or controllers remain a defect to investigate, not proof that setup succeeded.

## Pair the test host

With the verified cable connection active and the host running, pair through trusted setup:

1. On the computer, open [the local host console](http://127.0.0.1:47844/).
2. Choose **Host setup**. Keep its certificate fingerprint and one-time pairing code private.
3. In the Quest app, enter `https://127.0.0.1:47843` in **HTTPS origin** for this cabled trial.
4. Copy the certificate fingerprint from the computer into **Trusted SHA-256 fingerprint**.
5. Enter the unused code in **One-time code**.
6. Choose **Pair this Quest**.

The keyboard repair uses an app-owned panel, not the headset's overlay keyboard. It still needs an owner device check after installation. Select a field, then select keys with a trigger or pinch. Use **Shift** for capitals, **Symbols** for punctuation, and **Backspace** or **Clear** to edit at the end. Long values have **Previous text** / **Next text** pages; the stored value is not shortened. Codes stay masked. **Done** confirms a field; **Cancel**, navigation, host changes or app focus loss discard its draft. Microphone capture stays suppressed while editing.

That address reaches your computer only through the verified cable connection. After reconnecting the cable, verify the connection again. A separate private-network setup uses the actual host address instead; never disable certificate checks.

If a code expires, choose **Refresh pairing setup** on the computer. Pairing connects the clients; it does not log in to a model provider or grant execution permission.

## Use spaces and conversations

After pairing, use these controls:

| Goal | Control |
| --- | --- |
| Add a project | **Register project** in the **This space** panel; enter a name and purpose. |
| Enter a project or child space | Select its sphere or **Enter →**. |
| Add a nested space | **Create child space** in a project or child space. |
| Address the space | Choose **Clear task selection**, then check the **Receiver** label. |
| Request separate work | **New task**; enter its title and work request. Execution stays blocked until host setup is complete. |
| Address one task | **Activate task conversation →** on its window. Its application views belong to that same task. |
| Send text | **Text** or **Write turn**. Check the receiver before sending. |
| Inspect missing capabilities | **Host readiness** or **Readiness**. |
| Move the workspace around you | **Recenter**. This does not move the headset viewpoint. |
| Change display mode | **Switch to MR** for mixed-reality passthrough; **Switch to VR** for virtual reality. Unavailable passthrough leaves you in VR. |
| Arrange a task window | **Place window**, then aim and select its position. |

Each space has its own conversation. Each task has its own agent conversation. Changing browser, terminal, or desktop views does not switch to another agent.

Use **All projects Inbox** to find questions, approvals, and reviews across projects. The left-controller app Menu button opens it; the right Meta button remains a system control. Keyboard F1 is an alternative. **Jump** selects the request's destination. **Return to origin** restores the context you left; **Parent Back** moves to a parent space instead.

Use the computer console for context-source uploads, history export, and archive. Archive retains history and refuses unresolved work; it does not silently stop an agent.

## Use agents and voice after setup

These instructions require an approved, configured host. They are not a claim that the test deployment runs agents or speech:

- Choose the supported runtime and model in **Model settings**, then send a deliberate turn or create a task. Changing a model setting does not supply a login or authority.
- Select a task to inspect its application views. **Take control** gives you input only after the host acknowledges control. **Resume agent** returns control.
- Read any restart warning before confirming. A workload restart preserves saved files but loses processes and unsaved application state.
- To use push-to-talk, choose **Enable PTT**, allow microphone access deliberately, then hold right-controller A. Release A to send. Losing tracking cancels the recording.
- To use hands-free speech, choose **Enable hands-free** deliberately. **Mic off** stops capture. The recording keeps the receiver selected when speech began.
- Choose **Enable spoken replies** separately. **Stop output** stops playback; it does not cancel a task.

If the host reports uncertain work, inspect its retained evidence before retrying. Do not create a fresh request merely to repeat an effect whose outcome is unknown.

## Finished-product outcome

The intended result is a personal workspace for real work across projects, not a display of sample agents. It has this structure:

```text
Overview
  Project
    Nested space — its own conversation
      Task — one agent and its retained history
        Browser / terminal / desktop views
        Saved files and results

All projects Inbox → Jump to work → Return to origin
```

In the finished workflow, you enter a project, select a space or task, and speak or type to its visible receiver. Agents work in dedicated environments on your existing computers. They ask for decisions in the global Inbox, and you inspect results or take control without exposing unrelated personal applications.

Completion requires more than a built package: both input modes must work while worn; real authorized tasks, speech, pairing, and recovery must pass. The headset must also pass the continuous 30-minute workload and readability checks. All 45 Manifest gates remain binding.

For setup details, see [Private host setup](HOST-SETUP.md). For the device checks, see [Native device acceptance](../native/docs/DEVICE-ACCEPTANCE.md).
