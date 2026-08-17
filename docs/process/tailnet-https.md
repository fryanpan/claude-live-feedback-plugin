# Serving prod over HTTPS on its Tailscale hostname

Prod is reached at `http://<tailnet-name>:8787`. That origin is **not a secure
context**, and the browser therefore refuses the microphone outright — so the
board's voice dock and review-doc dictation are dead on every device except a
browser running on the host machine itself at `http://localhost:8787`.

This is a configuration change with one supporting code change. The server does
not, and after this still does not, terminate TLS.

## What is actually wrong

Measured in Chrome against the two origins, same machine, same browser:

| | `http://<tailnet-name>:8787` | `https://<tailnet-name>` (via `tailscale serve`) |
|---|---|---|
| `window.isSecureContext` | `false` | `true` |
| `navigator.mediaDevices` | `undefined` | present |
| `navigator.mediaDevices.getUserMedia` | `undefined` | present |
| `SpeechRecognition` constructor | present | present |

The last row is the one that misleads. The constructor exists on the insecure
origin, so the failure does not look like an unsupported browser — `start()`
answers `not-allowed` immediately, with no permission prompt, because on an
insecure origin Chrome offers no such permission to grant. Telling someone to
allow the mic for the site sends them looking for a control that is not there.

`packages/markdown-app/src/voice-capture.ts` gates on exactly one thing,
`window.isSecureContext`, so this is the whole story — not a permissions bug
and not a code bug.

**Why loopback works and the tailnet name does not:** loopback is on the
browser's trustworthy-origin list whatever its scheme. A `*.ts.net` name over
plain http is not, and no amount of it being a private network changes that.

## The change

`tailscale serve` terminates TLS on the tailnet name and reverse-proxies to
this process on loopback. Nothing is installed, nothing is exposed beyond the
tailnet, and the existing `http://…:8787` keeps working untouched.

HTTPS is already enabled for this tailnet — `tailscale status --json` reports
the node's own name under `CertDomains`, which is what that means. **No admin
console change is required.** If `CertDomains` were empty, it would be, and
that would be a decision for the tailnet owner rather than a step here.

### 1. Publish the mapping

```bash
tailscale serve --bg 443 http://127.0.0.1:8787
```

What it does: registers a persistent, node-local serve mapping. Tailscale
obtains and renews a publicly-trusted certificate for the node's own name and
listens for TLS on port 443 of the tailnet interface only, proxying to the
existing server on loopback. It writes to the node's tailscaled state; it does
not touch the repo, launchd, or the running server, and the server neither
restarts nor notices.

**Reach is unchanged.** `serve` is tailnet-only. The command that would make it
public is `tailscale funnel`, which is a different verb — do not use it.

Confirm what it published, and confirm it says tailnet-only:

```bash
tailscale serve status
```

### 2. Point the server's links at the new origin

Reinstall the launchd agent with the origin in its environment:

```bash
LF_PUBLIC_BASE_URL=https://<tailnet-name> scripts/launchd/install.sh
```

This rewrites `~/Library/LaunchAgents/com.fryanpan.live-feedback.plist` with
`LF_PUBLIC_BASE_URL` set and restarts the service. The value is validated at
boot: a malformed one is a startup failure with a named error, not a silent
fallback.

Step 2 is not optional polish. `publicBaseUrl` is the single source of every
`reviewUrl`, `entryUrl` and task-import `hubUrl` the server emits — the links
agents paste into chat. Without it those keep reading
`http://<tailnet-name>:8787`, so every link lands back on the insecure origin
and voice stays dead for anyone who follows one. The TLS deploy would look
complete and change nothing that matters.

## How to verify

Non-vacuously — each check needs the "before" value too, or it proves nothing.

**The certificate and the proxy:**

```bash
curl -sv -o /dev/null https://<tailnet-name>/ 2>&1 | grep -i "subject:"
```

Expect `subject: CN=<tailnet-name>` and no certificate warning.

**The secure context**, in a browser at `https://<tailnet-name>/`, via devtools
console:

```js
({ isSecureContext: window.isSecureContext,
   mic: typeof navigator.mediaDevices?.getUserMedia })
```

Expect `{ isSecureContext: true, mic: 'function' }`. Then load
`http://<tailnet-name>:8787/` and run the same snippet — it must still report
`false` / `'undefined'`. That second reading is the control: it is what makes
the first one evidence that the origin changed rather than that the snippet is
wrong.

**The links:**

```bash
curl -s http://127.0.0.1:8787/api/docs/<some-doc-id> | grep -o '"reviewUrl":"[^"]*"'
```

Expect an `https://` URL with no `:8787`. Before step 2 this returns
`http://<tailnet-name>:8787/...`, which is how you know the check can tell the
two apart.

**Live collaboration still works.** Open a review doc on the https origin, type
in it, and confirm the change appears in another tab. Websocket and SSE were
both measured through `tailscale serve` before this was written — a WSS
handshake completed and echoed bidirectionally, and an SSE stream arrived in
four separate chunks one second apart rather than buffered to the end — but
those were measured against a probe server, not against this app.

## How to roll back

Either half independently, both fast, neither destructive.

Remove the TLS frontend (the `http://…:8787` origin is unaffected and has been
serving the whole time):

```bash
tailscale serve --https=443 off
tailscale serve status        # expect: No serve config
```

Revert the links (re-running the installer without the variable clears it,
because the plist is regenerated from the template each time):

```bash
scripts/launchd/install.sh
```

Rolling back only the frontend while leaving `LF_PUBLIC_BASE_URL` set is the
one bad combination: the server would hand out `https://` links to an origin
that no longer answers. Undo them together, frontend last.

## What this does not change

- **Agents.** The MCP resolves `http://localhost:<port>` from a file holding a
  port and a pid. No hostname is involved and no session needs restarting.
- **The client's own URLs.** The markdown-app, the redline view, the hub and
  the widget all build their websocket URL as
  `location.protocol === 'https:' ? 'wss' : 'ws'`, so they follow the page.
  There was nothing to fix there.
- **Share links.** Built from a separate config on a separate path, already
  `https://`, and reached through the Cloudflare tunnel rather than this.
- **Host classification.** `tailscale serve` forwards `Host` verbatim
  (`<tailnet-name>:443`), which `normalizeHost` strips to the tailnet name and
  `isTrustedLocalHost` matches exactly — so the https origin is the same
  trusted-local surface as today, with full operator rights. It sets
  `x-forwarded-proto: https`, which `policyFor` already allowlists, so the
  browser-origin policy compares against the right scheme. It sets no `cf-ray`,
  so nothing classifies it as an external proxy. All four verified by proxying
  a probe server and reading the headers it received.

## Residual, worth knowing

`tailscale serve` injects `tailscale-user-login`, `tailscale-user-name` and
`tailscale-user-profile-pic` headers identifying the calling tailnet user.
Nothing in this server reads them today. They are worth remembering as an
available identity signal, and worth not accidentally logging.

Tailnet HTTPS makes the board reachable over TLS by every device on the
tailnet. Those devices can already reach `http://<tailnet-name>:8787` with the
identical trusted-local classification, so this adds no reach that did not
exist — but "tailnet-only" is not "one person only", and that is a pre-existing
question rather than one this introduces.
