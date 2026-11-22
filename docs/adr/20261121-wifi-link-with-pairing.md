# ADR: Wi-Fi link through a Windows forward, behind a pairing code

## Status
Accepted

## Area
Spatial view

## Context
The bridge runs inside WSL 2, behind Windows, and can type into sessions that act with the owner's access. The owner picked Wi-Fi with a certificate over a USB cable, knowing it needs a Windows port forward and a firewall rule, and exposes the bridge to the home network "behind a pairing secret". WSL's address changes whenever WSL restarts. WebXR and the microphone need a secure context.

## Decision
Windows forwards port 47851 on all addresses to `127.0.0.1:47850`, reaching the bridge through WSL's own localhost forwarding. The forward therefore never goes stale when WSL's address changes. A firewall allowance for that port, limited to private networks, lets the headset in. These two changes are the owner's one-time administrator step; the bridge only reads them at start and prints what is missing. The bridge serves HTTPS with a self-signed certificate that persists in its data directory, so the owner accepts it once. It reuses the earlier host's `PairingAuthority` and certificate code: a one-time code shown only on the bridge's terminal, rate-limited, exchanged for a token held in an `HttpOnly; Secure; SameSite=Strict` cookie. Every endpoint except the page's own files and pairing needs that cookie. An event stream whose pairing is revoked is ended at the next heartbeat.

## Alternatives Considered
- **USB cable (adb reverse)**: no network exposure — but the owner chose to move freely, without a cable.
- **Forward to WSL's current address**: the common recipe — but it breaks on every WSL restart and needs administrator rights again each time.
- **WSL mirrored networking**: no forward needed — but it changes `.wslconfig` and WSL's networking mode, which the owner did not authorize.
- **Trust requests from loopback**: simpler setup — but through the forward, the headset's requests also arrive from 127.0.0.1, so loopback says nothing about who is asking.

## Consequences

### Positive
- After the one administrator step, nothing needs refreshing: not after a PC or WSL restart, nor after a change of WSL's address.
- Only a paired headset reads or drives sessions; another page in a browser on the PC sends no cookie.

### Negative
- The browser warns about the self-signed certificate once per address of the PC.
- The pairing code is printed to the bridge's terminal; when that terminal is a Herdr pane, the code is visible in that pane's text until it expires or is used.

## Source
- Session: /do run (2026-11-21)
- Related: 20261121-thin-webxr-view-over-herdr.md
