# Session Hosting — remote observe & limited control of a running Claude session

**Showcase / feature proposal for `greyoak111/cccodroid`.**
A fork-side module (`gw/hosting/`, `web/hosting/`) that lets a second device (phone) watch and
limitedly control a Claude session running on a host device (tablet), over an end-to-end-encrypted
relay. This document accompanies a **runnable real-code demo** and an illustrated manual.

---

## 1. What it is (and is not)

- The host keeps running the session (terminal, tools, workspace files stay on the host).
- The controller sees text + session control only: read history/live, send plain text, interject,
  stop the current turn, answer permission cards / AskUserQuestion / ExitPlanMode.
- **Not** remote desktop: no file sync, no terminal proxy, no remote Android system dialogs,
  no "keep running after power-off".
- Only sessions the host explicitly shares are visible; everything else is invisible to the controller.

## 2. Security model

- **E2E AES-256-GCM.** Host generates a 32-byte `secret`; each packet = `base64url(IV‖tag‖ciphertext)`
  with random 12-byte IV, 16-byte tag; `AAD = cc-host-v1:{room}:{id}:{direction}` binds room/id/direction.
  The `secret` lives only in the pairing code and **never reaches the relay**.
- **Zero-knowledge relay.** The relay forwards opaque ciphertext; it persists only SHA-256 of the
  host/client tokens; no plaintext, no keys, no body logging. TLS protects the outer hop.
- **Pairing code = control.** `CCH1.` + base64url(`{v,url,room,clientToken,secret}`); hidden by default,
  reveal-on-click; HTTPS-only origins in production.
- **Credential separation & revocation.** Separate `hostToken` / `clientToken`; revoke-all deletes the
  room; unshare revokes that session's grant immediately; pause stops remote access only (local tasks keep running).
- **Idempotent writes.** Each write (send/stop/answer/message) carries a unique 32-hex id; the host
  persistently pre-reserves the id *before* invoking upstream, so a lost receipt / retry never executes twice.
  The ledger is bound to `boot` + per-session `grant`; restart / re-share invalidates old ids.
- **Whitelisted ops only.** No arbitrary paths, no arbitrary HTTP forwarding, no global abort, no
  "always allow", no global permission-mode switch, no slash commands remotely; truncated (`cut`)
  permission cards cannot be approved remotely.

## 3. Sync: event-driven incremental long-poll (not SSE, not high-frequency polling)

`watch` hangs on the host event bus; wakes on change, coalesces ~80 ms, returns one **delta** frame
(text append-only via `tailPatch`); idle hangs up to 8 s then an `unchanged` heartbeat. `reset` only when
history/range invalidates. Bounded caches (revisions, bytes, per-session waits), 12 s offline watchdog
disables controls, AbortController cancels on hide/close. History uses a bounded bidirectional
byte-range window (MAX_PAGES=8) with from/to/size/exclude.

## 4. UI: reuses the original chat page

Remote sessions plug into the existing chat view as a *data source* — same message/tool/thinking
components, Markdown, scrolling, history window, composer. Drafts isolated per `remote:<id>:<sid>`.
Sidebar gains a "Remote" group listing shared sessions per paired device. Host metadata (context /
model / permission / stats / cost) is shown with host provenance; unknown values render as "not synced".

## 5. Runnable demo (real code, simulated model + loopback relay)

`hosting-demo/` runs the **real** frontend, hosting engine/adapter/crypto, queue/permission/event-bus
routes, and the **real** Python relay; only model execution (scripted) and the public network (loopback)
are simulated. Isolated HOME + throwaway gw copy; never touches a real install, real pairing, or a live relay.

```sh
# any Linux with node + python(aiohttp), pointing at an app root that has gw/ and web/
HOSTING_DEMO_APP=/path/to/app HOSTING_DEMO_PYTHON=python3 node server.mjs
# open http://127.0.0.1:17800/  → illustrated manual + two live device frames + relay ciphertext view
```

- `test-chain.mjs`: 10 assertions over the real HTTP API (isolation, history, permission card, delta sync,
  transcript persistence, stop+resume, unshare revoke, ciphertext-only relay).
- `capture.mjs`: headless Chromium drives the full flow and produces the manual figures.

## 6. Evidence & honest limits

- Source-level suites (adapter / sync / history / message-actions / request-id / phase / metadata) pass;
  real-relay-to-native-UI chain verified; relay persistence contains no plaintext/keys/raw tokens.
- **Not** yet validated on two real Android devices (WebView / IME / cross-network / background keep-alive);
  headless + loopback latency ≠ worst-case real network. First snapshot has transfer/build cost; summary
  budgets cap text; host queue/background tasks are read-only remotely.

## 7. Ask

Feedback on the design (E2E + zero-knowledge relay + idempotent writes + event-driven delta sync), and
whether upstream wants this as a module. The demo + manual + figures are provided for review; no APK is
auto-installed and no upstream PR is merged by this showcase.