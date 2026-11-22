# Spatial view: user guide

Your Herdr sessions around you in the Quest 3, in mixed reality at your desk. You work inside one project at a time: its sessions are around you, the session you are working with large in front, and every other project is a small chip with its state lights. Each project has an agent of its own that you can ask about the project and tell to start or prompt its sessions. Above all projects is the overview, where the helper is in front. You act by voice, hand, controller or keyboard.

The view shows your real sessions. Herdr owns them: the view asks Herdr to bring a session forward and shows what Herdr reports. Your desk keyboard therefore types into the same session the view shows in front. Sandboxed agents are a separate, opt-in path ([earlier Quest app guide](QUEST-APP-GUIDE.md)); nothing here uses it.

## One-time setup on the PC

1. In this repository (WSL), build and fetch the speech model once:

   ```sh
   npm ci
   npm run build
   npm run view:setup
   ```

   `view:setup` downloads Moonshine tiny (about 31 MB, free) into `~/.local/share/spatial-agent-workspace/view/models`. After that, speech never leaves the PC.

2. Let the headset reach the PC over Wi-Fi. This needs two changes to Windows, made once from an **administrator PowerShell**:

   ```powershell
   netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=47851 connectaddress=127.0.0.1 connectport=47850
   New-NetFirewallRule -DisplayName "Herdr spatial view 47851" -Direction Inbound -Protocol TCP -LocalPort 47851 -Action Allow -Profile Private
   ```

   The first command forwards port 47851 on your home network to the view inside WSL. It goes through WSL's own localhost forwarding, so WSL's changing address never breaks it. The second command lets that one port in on private networks only. When the view starts, it checks both and prints whatever is still missing.

## Every day

1. Start Herdr as usual, then in a terminal (a Herdr pane is fine):

   ```sh
   npm run view
   ```

   It prints the address to open on the headset, for example `https://192.168.1.20:47851/`. If no headset is paired yet, it also prints a pairing code.

2. In the Quest browser, open that address. The first time, the browser warns that the certificate is not trusted (it is the view's own). Choose **Advanced → Proceed** once; the certificate stays the same across restarts.

3. The first time only, enter the pairing code and choose **Pair this headset**. The pairing survives closing the browser. If the code has expired, choose **Show a new code on the PC** and read the new one in the terminal. If that terminal is a Herdr pane, the code is also in that pane's text until it is used or expires, so it shows on the shelf for those ten minutes.

4. Choose **Enter mixed reality**. The shelf appears around where you sit and face.

To stop, press Ctrl-C in the terminal running `npm run view`. The view changes nothing in Herdr's own configuration.

## Where you are: the overview and the projects

A **project** is a Herdr workspace. The view shows one place at a time, and the place follows Herdr's focus: when you or the desk keyboard bring a session forward, you are in that session's project.

```text
 INSIDE A PROJECT                                   THE OVERVIEW

 [Overview] [api o] [web ~] [docs !1] ...          [api o] [shop o] [web ~]
                                                    [infra o~] [docs !1] ...
 +------+  +------------------+  +------+
 | task |  | session in front |  | task |                +------------------+
 |      |  | (receiver)       |  |      |       [blog]   | the helper       |
 +------+  +------------------+  +------+                | in front         |
                                                         +------------------+
```

- **Inside a project:** only that project's sessions are on the shelf, beside the one in front. Every other project is a **chip** above: its name, one light per session, and an amber edge with "!" and a count when one of its sessions waits on you. The first chip is **Overview**.
- **The overview:** every project is a larger chip, a **node**. The helper is in front, and the sessions that belong to no project (those in the helper's workspace) are beside it.
- **Going somewhere:** select a chip or node, or say "go to" and the project's name ("go to docs"). Say "overview" for the overview. A name that matches nothing goes nowhere, and the strip says so; your words are never sent to a session instead.
- **Going into a project always puts its agent in front**, also when you last worked with a task there. Select a task's tile, or say "show" and its number or name, to work with it.

## The shelf

- **In front:** the session that has Herdr's focus. This is the **receiver**: prompts and keys go here. Its name is shown in the strip above it, the place you are in is on the right of its title, and its panel has a blue edge (amber while it waits on you).
- **Tiles:** the other sessions of the place you are in, numbered, with their last lines and a light. A project's agent and the helper have a blue bar on the left of their tile. The front session's own place stays as a dashed outline marked "in front". Numbers count across all projects in Herdr's order, so "show 3" works from anywhere, and they do not move when you change sessions.
- **Lights:**

| Light | Means |
| --- | --- |
| amber ▲ with "!" (and an amber edge) | waiting: the agent asks a question or waits for approval |
| cyan half-filled circle | working |
| green filled circle with a check | done, not yet looked at |
| grey ring | idle |
| grey dotted ring with "?" | Herdr cannot tell |
| grey box with ">_" | a shell, not an agent |

- **Strip above the front session:** the receiver, the microphone button (red = listening), the last thing heard with what it was taken as and where it went, and the link state.
- **Below it:** the **Talk** button, then three rows of buttons: on the first, moving between sessions, scrolling, text size and re-centering, **Overview**, and **Exit MR**; on the second, the keys sent to the receiver; on the third, **Go**, **Scratch that**, and the send setting.
- **Above it:** when a draft waits, a bar says in which session and the words that send or clear it.

## Talking to the agents at each level

| Level | Who hears a plain sentence | What it does |
| --- | --- | --- |
| A task session | that session, when it is in front | its own work |
| A project | the project's agent, in front when you go in | answers about the project's sessions; on your order, starts sessions in the project and gives them prompts |
| The overview | the helper | answers across all projects; starts, renames and closes sessions; other quick tasks |

**The project's agent** is a real Claude Code session in the project's workspace, in a tab labelled "project agent". It starts the first time you go into the project; going in sends it nothing. Ask it "what is waiting here?" or "what is everyone doing?", and it reads the project's sessions and answers in its window. Tell it "start an agent on the flaky test" or "tell the test session to rebase", and it does that in this project only. It never acts unasked, and it does not do the project's work itself. Anything else, such as changing a file, running a command that changes something, or acting on another project, waits for your approval: its window shows the question and its light turns amber, and you answer with the keys below the front session. It runs on Claude Code's default model and works in its own folder (see *What this rests on*).

**The helper** is in front at the overview. From inside any project, start a sentence with "helper" to reach it without leaving: "helper, start a shell in project docs". Orders with no project named start the session in the helper's workspace, so it shows at the overview.

While an agent is starting, an amber band across its window says so; speak to it once the band is gone. Words spoken to it before then are not sent, and the strip says so. An order to the helper while it starts is the one exception: it waits and is delivered when the helper is ready, and a note says so. The first time each kind of agent starts, Claude Code asks whether to trust its folder, and its first choice is "No, exit": press **↓** then **Enter** to choose "Yes, I trust this folder". It asks once for the helper's folder and once for the folder all project agents share. Any other question an agent asks as it starts shows in its window the same way, with an amber light: answer it with the keys. If it does not start, the band says why; go to the project again to retry.

## Acting

Point a hand or controller at something. A ray shows where you point. Pinch (hand) or pull the trigger (controller) to select.

| Goal | By hand or controller | Say |
| --- | --- | --- |
| Go into a project | Select its chip or node | "go to docs" |
| Go to the overview | **Overview**, or the Overview chip | "overview" |
| Bring a session forward | Select its tile | "show 3", "show logs" (a number or name) |
| Next session that needs you | **Next waiting** | "next waiting" |
| Return to where you were before "next waiting" | **Back** | "back" |
| Press a key in the receiver | **Enter, Esc, Ctrl-C, ↑, ↓, Tab, y, n, 1, 2, 3** | "press enter", "press escape", "interrupt", "press up", "press down", "press tab", "press yes", "press no", "press one", "press two", "press three" |
| Send the draft in front | **Go** (the third row of buttons) | "go", "submit", "send it" |
| Clear the draft in front | **Scratch that** | "scratch that", "clear that" |
| Send each prompt as soon as it is heard, or wait for "go" again | **Send at once**, **Wait for go** (the one in force is lit) | "send at once", "wait for go" |
| Scroll the front session back, forward, to the latest | Grab the text (pinch or trigger on it) and drag up or down; or push the thumbstick; or **Scroll up, Scroll down, Latest** | "scroll up", "scroll down", "scroll bottom" |
| Larger or smaller text | **A+, A−** | "bigger text", "smaller text" |
| Put the shelf in front of you again | **Recenter** | "recenter" |
| Leave mixed reality, back to the flat page | **Exit MR** (or the Quest's Meta button) | "leave mixed reality" |
| Answer a close the helper asks about | **Yes, close** / **No, keep it** in the strip, or the y / n key | "yes" / "no" |
| Change the listening mode | the Talk button: hold it to talk, tap it to keep listening | "hold to talk", "keep listening" (also "start listening") |
| Stop listening | Select the microphone | "stop listening" |

A command must be the whole utterance. "back up the database before you migrate" is a prompt, not "back". "Go" alone sends a draft; "go to docs" goes to a project. When "next waiting" finds nothing waiting, it says so. "Next waiting" goes to the waiting session itself, in whatever project it is, and "back" returns you to the session and project you came from.

To type, use the keyboard at the desk: it types into Herdr's focused session, which is the one in front.

## Speaking

Listening is off whenever the page opens. There are two ways to listen; switch at any time by saying "hold to talk" or "keep listening" ("start listening" does the same), or with the Talk button.

- **Hold to talk:** the microphone is open for prompts only while you hold a pinch or trigger on the microphone in the strip, or hold a controller grip, or hold the ` key on a keyboard paired to the headset. Start speaking when the microphone turns red and the strip says "Listening" ("Opening mic…" means not yet). Release to send. An utterance longer than 30 seconds is sent at 30 seconds.
- **Keep listening:** select the microphone once to start, or say "keep listening". Each pause ends an utterance. Say "stop listening", or select the microphone again, to stop.

### Standby: listening off, voice still works

In mixed reality the microphone stays open even when listening is off. This is **standby**: the strip says "Standby", and the Talk button says that listening is off. Standby starts when you enter mixed reality and ends, with the microphone closing, when you leave it; on the flat page the microphone is closed ("Mic off"). Audio is turned into text on the PC and goes nowhere else.

On standby the view acts on commands only, and nothing is ever sent to a session:

- A command that only changes how the view is shown (scroll up, scroll down, scroll bottom, recenter, bigger text, smaller text) runs at once.
- Any other command is **asked first**: the strip turns amber and says what it will do, for example "Do “Keep listening”?" or "Do “Send the draft in logs”?". Say **"yes"** (or select **Yes, do it**, or press y) to do it. Say "no" (or select **No**, or press Esc or n) to drop it. Anything else you say, or 15 seconds of silence, drops it too.
- Words that are not a command, such as a prompt or an order to the helper, are shown as **Ignored** and sent nowhere: not typed, not drafted.

So after "stop listening" you can turn voice back on by voice: say "keep listening" (or "start listening"), then "yes". The same "yes" answers a close the helper asks about (it says "Close … ?"); only one question waits at a time, and the strip says which one you answered. While a close waits, a command heard on standby is refused until you have answered it.

Anything that is not a command is a **prompt**. It goes to the session that was in front when you started speaking, even if you bring another session forward before you finish.

### Drafts: a prompt waits for "go"

A spoken prompt is **typed into that session's input and not sent**, so you read it in the window before any agent acts on it. A bar above the strip says "Draft waiting in" the session, and the strip says what was heard and where it went. Then:

- Say **"go"** (or "submit", or "send it"), or select **Go**, to send the draft of the session in front, once. With no draft in front, "go" sends nothing and says so.
- Say **"scratch that"** (or "clear that"), or select **Scratch that**, to clear the draft without sending it. It clears the whole input line of that session, including anything you typed at the desk into it; Claude Code can bring it back with Ctrl-Y.
- Say more, and it is **added** to the draft, in hold to talk and in keep listening alike. A long prompt said in pieces is one draft. After a clear, the next words start a new draft.
- Or fix it at the desk: the draft is in the session's input, so the keyboard edits it, and Enter sends it. The view only knows the drafts it typed: after you send or empty one at the desk, the bar can still say it waits until you say "go" or "scratch that" (which then do nothing harmful), and text you type yourself into an empty input is not a draft to the view: press Enter yourself.

"Go" and "scratch that" act on the session in front. A draft in another session waits there, and the bar names it; bring it forward, then say "go". A draft is never typed into an agent that is waiting on a question, because the words would be taken as keys: answer the question with a key first.

An order to the helper waits the same way, in the helper's input. The helper is in front at the overview, so say "overview", then "go". (An order said while the helper is starting waits there until it is ready; a note says so.)

**Send at once.** If drafts slow you down, say **"send at once"** (or select **Send at once**): a prompt is then sent as soon as it is heard, with no "go", and the strip shows "Sending at once" while it is on. Say **"wait for go"** (or select **Wait for go**) to go back. The setting is kept on the PC across restarts and is off the first time.

The strip always shows what was heard, whether it was taken as a command, a prompt or a helper order, and where it went. If a word was misheard, say "scratch that", or fix it at the desk.

### Every spoken form

A command must be the whole utterance. These are all the forms, each in quotation marks; the speech model sometimes writes a word differently, so a few extra spellings are accepted.

| Command | You say |
| --- | --- |
| Next waiting session | "next waiting", "next", "whats waiting" |
| Back | "back", "go back" |
| Enter, Escape, Ctrl-C | "press enter", "enter"; "press escape", "escape"; "interrupt", "press control c", "control c" |
| Arrows, Tab | "press up", "arrow up"; "press down", "arrow down"; "press tab" |
| y, n | "press yes", "press y"; "press no", "press n" |
| 1 | "press one", "press 1", "option one", "option 1" |
| 2 | "press two", "press 2", "option two", "option 2" |
| 3 | "press three", "press 3", "option three", "option 3" |
| Send the draft | "go", "submit", "send it" |
| Clear the draft | "scratch that", "clear that" |
| Send at once, wait for go | "send at once"; "wait for go" ("way for go") |
| Scroll | "scroll up", "page up"; "scroll down", "page down"; "scroll bottom", "bottom", "go bottom", "scroll to bottom", "latest" |
| Recenter | "recenter", "re center", "center" |
| Text size | "bigger text", "larger text"; "smaller text" |
| Listening | "stop listening", "mic off", "microphone off"; "hold to talk"; "keep listening", "start listening", "listening switch" |
| Leave mixed reality | "leave mixed reality", "exit mixed reality", "exit" |
| Overview | "overview", "show overview", "go to overview", "go to the overview", "all projects", "show helper", "helper" |
| Go into a project, show a session | "go to" or "show" and a name or number: "go to docs", "show 3", "show logs" |
| Answer a question that waits | "yes", "confirm", "yes close it", "close it"; "no", "cancel", "dont close", "keep it" |

## Closing, and what the agents may do

The helper is a small, fast agent (Claude Code with Haiku) in a tab labelled "helper" in the Herdr workspace labelled "helper", which is the overview. You can read what it did in its window. It starts the first time you need it. Speak to it by starting with "helper":

- "helper, start a shell in project docs"
- "helper, start a claude agent in project infra"
- "helper, rename the shell in project docs to logs"
- "helper, how much disk is free?"

It runs these without asking you, using your account and access, with one exception. **Closing asks first,** for the helper and for every project's agent: the agent names the session in the strip, and nothing closes until you say "yes" or select **Yes, close**. With no answer within two minutes, or a "no", it stays open. This holds even if the order says not to ask: a hook outside the agents refuses any other way of closing, and it keeps working after Herdr restarts them. You can also type orders to the helper: say "overview" or select **Overview**, and type at the desk.

A project's agent has less reach than the helper: on its own it only reads the project's sessions, starts sessions in the project and gives them prompts. Everything else waits for your approval in its window.

**To remove a project's agent,** close its "project agent" tab like any session (ask the helper, or close it in Herdr). Going into the project again starts a new one.

## When something goes wrong

**The log.** Everything that fails is also written down, in the terminal where `npm run view` runs and in a file that outlasts it: `~/.local/share/spatial-agent-workspace/view/view.log` (the file is kept under 1 MB, and the one before it is `view.log.1`). Each line is dated and says what happened to which session or project and why: an agent that did not start (with the reason and what to do), an agent that asked something as it started, a session the project agent could not start, a Herdr error on an action, a close asked of you and your answer, a standby command asked, confirmed or dropped, and the send setting changing. The log never holds your prompts, what you said, what a session shows, or a pairing code.

A window that is not current says so on an amber band, and says what to do. It recovers by itself, without reloading, once the cause clears.

| The band says | Do this |
| --- | --- |
| Herdr is not running on the PC | Start Herdr. |
| No link to the view bridge on the PC | Check `npm run view` is still running; restart it if not. |
| This headset is offline | Check the headset's Wi-Fi. |
| This headset is not paired | Leave mixed reality (Meta button), choose **Show a new code on the PC**, and pair again. |
| Closed in Herdr — nothing to do | The session ended; its tile leaves after a few seconds. |
| No sessions open in Herdr | Start a session in Herdr, or ask the helper to; it appears by itself. |
| The helper / This project's agent is starting | Wait a few seconds; the band goes when it is ready. |
| (an amber light on an agent that just started) | It asks something, such as whether to trust its folder: answer in its window with the keys below it (↓ then Enter for "Yes, I trust this folder"). |
| It did not start (…) | Go to the project again, or say "overview" for the helper, to retry. If it keeps failing, check that `claude` runs in a terminal. |
| Mic unavailable: Mic refused | Allow the microphone for this page in the Quest browser's site settings, then select the microphone again. |
| Speech unavailable: Not set up on the PC | Run `npm run view:setup` once and restart the view. |

After a PC or WSL restart, start Herdr and `npm run view` again. The Windows forward and firewall allowance stay in place, and the headset stays paired. If the PC's home-network address changes, the view prints the new address; the browser asks you to accept the certificate once more for that address.

The view's certificate lasts a year. When it expires, `npm run view` stops and says so: delete `~/.local/share/spatial-agent-workspace/view/tls`, start the view again, and accept the new certificate once on the headset. The pairing stays.

On Wi-Fi, the headset runs on its battery, about two hours, unless it is plugged in.

## Undo the PC changes

From an administrator PowerShell:

```powershell
netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=47851
Remove-NetFirewallRule -DisplayName "Herdr spatial view 47851"
```

Then delete the view's data directory, `~/.local/share/spatial-agent-workspace/view`. It holds the pairing, the certificate, the speech model, the agents' settings, your send setting (`settings.json`) and the log. To forget the headset without undoing anything else, delete only its `pairing` folder.

## What this rests on

- **Herdr 0.9.3, socket protocol 22.** If Herdr's protocol changes, the view says so and shows no sessions until they match.
- **Quest browser:** a WebXR `immersive-ar` session, hand tracking, controllers, and the microphone, on a page with a self-signed certificate. The text is drawn by the view itself onto WebGL quads; compositor layers are not used.
- **Speech:** Moonshine tiny, English, 8-bit weights, about 31 MB, on the PC's CPU through `@huggingface/transformers` and ONNX Runtime. About 0.1 s per utterance on this PC.
- **Level agents:** Claude Code, using your existing Claude login: the helper with `--model haiku`, each project's agent on Claude Code's default model. Their settings, the closing hook and their instructions live in `~/.local/share/spatial-agent-workspace/view/agents` (one folder for the helper, one shared by all project agents), which is also where they work, so an agent Herdr restarts by itself keeps them. A project agent is found again by its tab label "project agent", the helper by its label "helper"; renaming those tabs makes the view start new ones.
