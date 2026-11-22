# Spatial view: user guide

Your Herdr sessions around you in the Quest 3, in mixed reality at your desk. Each agent and shell gets a window, grouped by project. The session you are working with is large in front of you, and every other session is a small live tile with a state light. You act by voice, hand, controller or keyboard. A small helper agent starts, renames and closes sessions when you tell it to.

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

## The shelf

```text
 project A      +-------------------+      project C
 [1] [2]        |  session in front |      [5]
                |  full size        |
 project B      |                   |      project D
 [3]            +-------------------+      [6] [7]
```

- **In front:** the session that has Herdr's focus. This is the **receiver**: prompts and keys go here. Its name is always shown in the strip above it, under "Receiver", and its panel has a blue edge (amber while it waits on you).
- **Tiles:** every other session, numbered, with its last lines and a light. The front session's own place on the shelf stays as a dashed outline marked "in front". The numbers follow Herdr's project and pane order, and do not move when you change sessions.
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
- **Two rows of buttons below it:** on the first row moving between sessions, scrolling, text size and re-centering, the helper, and the listening mode; on the second the keys sent to the receiver.

## Acting

Point a hand or controller at something. A ray shows where you point. Pinch (hand) or pull the trigger (controller) to select.

| Goal | By hand or controller | Say |
| --- | --- | --- |
| Bring a session forward | Select its tile | "show 3", "show docs" (a number, name or project) |
| Next session that needs you | **Next waiting** | "next waiting" |
| Return to where you were before "next waiting" | **Back** | "back" |
| Press a key in the receiver | **Enter, Esc, Ctrl-C, ↑, ↓, Tab, y, n, 1, 2, 3** | "press enter", "press escape", "interrupt", "press up", "press down", "press tab", "press yes", "press no", "press one", "press two", "press three" |
| Scroll the front session back, forward, to the latest | Grab the text (pinch or trigger on it) and drag up or down; or push the thumbstick; or **Scroll up, Scroll down, Latest** | "scroll up", "scroll down", "scroll bottom" |
| Larger or smaller text | **A+, A−** | "bigger text", "smaller text" |
| Put the shelf in front of you again | **Recenter** | "recenter" |
| Leave mixed reality, back to the flat page | **Exit MR** (or the Quest's Meta button) | "leave mixed reality" |
| Show the helper | **Helper** | "show helper" |
| Answer a close the helper asks about | **Yes, close** / **No, keep it** in the strip, or the y / n key | "yes" / "no" |
| Change the listening mode | the last button of the first row, which shows the mode in use | "hold to talk", "keep listening" |
| Stop listening | Select the microphone | "stop listening" |

A command must be the whole utterance. "back up the database before you migrate" is a prompt, not "back". When "next waiting" finds nothing waiting, it says so.

To type, use the keyboard at the desk: it types into Herdr's focused session, which is the one in front.

## Speaking

Listening is off whenever the page opens, and turns off when you leave mixed reality. There are two ways to listen; switch at any time with the last button of the first row, which shows the mode in use.

- **Hold to talk:** the microphone is open only while you hold a pinch or trigger on the microphone in the strip, or hold a controller grip, or hold the ` key on a keyboard paired to the headset. The microphone opens when you press, so start speaking when the microphone turns red and the strip says "Listening" ("Opening mic…" means not yet). Release to send. An utterance longer than 30 seconds is sent at 30 seconds and the microphone closes.
- **Keep listening:** select the microphone once to start. Each pause ends an utterance. Say "stop listening", or select the microphone again, to stop.

Anything that is not a command is a **prompt**. It goes to the session that was in front when you started speaking, even if you bring another session forward before you finish. It is sent when you stop talking, with no confirming step. The strip always shows what was heard, whether it was taken as a command, a prompt or a helper order, and where it went. If a word was misheard, fix it by hand: press Esc or Ctrl-C in that session, or type at the desk.

## The helper

The helper is a small, fast agent (Claude Code with Haiku) in its own Herdr session named "helper". It is a tile on the shelf, so you can read what it did. It starts the first time you need it. Speak to it by starting with "helper":

- "helper, start a shell in project docs"
- "helper, start a claude agent in project infra"
- "helper, rename the shell in project docs to logs"
- "helper, how much disk is free?"

It runs these without asking you, using your account and access, with one exception. **Closing asks first:** the helper names the session in the strip, and nothing closes until you say "yes" or select **Yes, close**. With no answer within two minutes, or a "no", it stays open. This holds even if the order says not to ask: a hook outside the helper refuses any other way of closing. You can also type orders to the helper: select **Helper** and type at the desk.

## When something goes wrong

A window that is not current says so on an amber band, and says what to do. It recovers by itself, without reloading, once the cause clears.

| The band says | Do this |
| --- | --- |
| Herdr is not running on the PC | Start Herdr. |
| No link to the view bridge on the PC | Check `npm run view` is still running; restart it if not. |
| This headset is offline | Check the headset's Wi-Fi. |
| This headset is not paired | Leave mixed reality (Meta button), choose **Show a new code on the PC**, and pair again. |
| Closed in Herdr — nothing to do | The session ended; its tile leaves after a few seconds. |
| No sessions open in Herdr | Start a session in Herdr, or ask the helper to; it appears by itself. |
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

Then delete the view's data directory, `~/.local/share/spatial-agent-workspace/view`. It holds the pairing, the certificate, the speech model and the helper's settings. To forget the headset without undoing anything else, delete only its `pairing` folder.

## What this rests on

- **Herdr 0.9.3, socket protocol 22.** If Herdr's protocol changes, the view says so and shows no sessions until they match.
- **Quest browser:** a WebXR `immersive-ar` session, hand tracking, controllers, and the microphone, on a page with a self-signed certificate. The text is drawn by the view itself onto WebGL quads; compositor layers are not used.
- **Speech:** Moonshine tiny, English, 8-bit weights, about 31 MB, on the PC's CPU through `@huggingface/transformers` and ONNX Runtime. About 0.1 s per utterance on this PC.
- **Helper:** Claude Code with `--model haiku`, using your existing Claude login.
