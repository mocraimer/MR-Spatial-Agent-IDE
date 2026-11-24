# ADR: Typing from the headset

## Status
Accepted; narrows 20261121-thin-webxr-view-over-herdr and 20261122-levels-ride-on-herdr-workspaces, which said the desk keyboard was the only way to type. Narrowed 2026-11-24: the Quest system keyboard is NOT available inside a WebXR mixed reality session (confirmed by owner on-device). Deleting in the headset uses the **⌫** and **Del wd** key-row buttons (or the floating keyboard's delete key when the hidden field is empty, via beforeinput); typed text in the session cannot be edited with the headset keyboard.

## Area
Spatial view

## Context
The owner's desk keyboard types into Herdr's focused session (the session in front) because Herdr
owns focus. Inside the headset, two additional typing paths were wanted:

1. **System keyboard** (Quest virtual keyboard): tap a button to bring up the Quest on-screen
   keyboard, type, and the characters go to the session in front.
2. **Physical keys forwarded**: a Bluetooth keyboard paired directly to the headset sends key events
   to the browser page; those keys should reach the session in front when in mixed reality.

Both paths must send text to Herdr without going through the speech path and without requiring Herdr
to focus the session on the PC side (the owner may be standing away from the desk).

## Decision
The page gains a hidden `<input>` element that is focused on demand (`openKeyboard()`). Focusing it
triggers the Quest system keyboard. The input's `input` event forwards `ev.data` to the bridge as a
`{ kind: 'type-text', text }` action. The bridge calls `pane.send_text` on the focused pane.

Physical key events are caught in the page's `keydown` handler. Inside a WebXR session (`scene.immersive`), named keys (Enter, Escape, Backspace, Tab, arrows) become `{ key }` POST parameters
to `/api/action` (translated to `{ kind: 'key', key }` bridge actions), and printable characters
become `{ type_text }` POSTs. The handler is a no-op outside XR so the desk keyboard is not
hijacked.

A **Keyboard** button in the first controls row opens or closes the keyboard; it is lit while the
keyboard is open. The button's spoken forms are "keyboard", "show keyboard", "open keyboard", "type".

Diagnostics (AC-5.3) are logged to the browser console: `[keyboard] show`, `[keyboard] close`, and
`[keyboard] typed "<chars>" (<n> keys/min)` with a 60-second rolling key-per-minute count.

## Alternatives Considered
- **Mirror-session approach (stdin)**: mirror sessions relay typed characters via a Windows stdin
  bridge. This path is window-specific and requires the session to be a window mirror; it cannot
  reach a plain terminal session.
- **WebXR keyboard API**: not yet available on Quest; `XRSession.isSystemKeyboardSupported` is
  defined but the Quest browser does not expose the XR keyboard API as of late 2026.
- **`virtualKeyboard` API**: available in some browsers; called when present, as a belt-and-suspenders
  measure alongside focus. Focus alone is sufficient on Quest.
- **Intercept all keydown events on the PC too**: simplest — but the owner types at the desk too, and
  intercepting their keydown events at the page (a background browser tab) would swallow PC keyboard
  input. The `scene.immersive` guard prevents this.

## Consequences

### Positive
- The owner can type without leaving the headset.
- The Quest system keyboard types into any session, not just window mirrors.
- Physical keys work too (Bluetooth keyboard paired to the headset).

### Negative
- `pane.send_text` is now called from two places in `bridge.ts`: `typeInto` (spoken drafts) and
  `typeText` (headset keyboard). The locks test is updated to allow both.
- The input focus model (hidden input focused → keyboard shown; blurred → closed) relies on the
  Quest browser firing focus/blur on the hidden element, which is not guaranteed on all browsers.
- The Quest system keyboard is not available inside a WebXR mixed reality session (confirmed
  on-device, 2026-11-24). The keyboard button opens the floating keyboard, but it cannot be used
  to delete words already typed by the view. The **⌫** and **Del wd** buttons and voice commands
  "backspace" / "delete word" reach the session directly and can shorten spoken drafts. The
  `beforeinput` path (empty-field delete) also sends a backspace when the floating keyboard's
  delete key is pressed and the hidden field is already empty.
