# Plan: `workspaces.fryanpan.com`, and renaming the repo

Two independent pieces of the Workspaces rename that are **not** in the copy PR
because neither is a code change:

1. serving the existing server at `workspaces.fryanpan.com`, and
2. renaming the GitHub repo to `claude-workspaces-plugin`.

Plan only. Nothing here touches DNS, Cloudflare, or the repo settings — those
are steps for the parent session and for Bryan.

> **Measured 2026-08-18** against the installed launchd plist and the current
> `main`, not read off documentation. Every claim below that says "today" was
> checked; the file and line references are where to re-check it. Premises
> decay, so re-read the host gate before acting on this if it has been a while.

---

## Part 1 — `workspaces.fryanpan.com`

### Where the product is served today

`~/Library/LaunchAgents/com.fryanpan.live-feedback.plist`, read 2026-08-18:

| | value |
|---|---|
| `ProgramArguments` | `bun run scripts/serve.ts --no-watch` |
| `WorkingDirectory` | the primary checkout (prod's deploy source) |
| `LF_PUBLIC_BASE_URL` | `https://mac-mini.<private-network>` |
| other env | `HOME`, `PATH` — and nothing else |

Two facts follow from that last row and they shape everything below.
**`TRUSTED_HOSTS` is not set**, and **none of the `CF_SHARE_*` variables are
set** — so on prod today `shares` is null, link mode is off, Access mode is off,
and the only hostnames that reach the server are this machine's own names.
HTTPS comes from `tailscale serve` in front of the process; the server itself
does not terminate TLS and still will not after this.

The tailnet hostname `mac-mini.<private-network>` **stays** — Bryan cancelled
the rename of the machine ("looks like I can't change mac-mini. That's fine.
Keep it as mac-mini"). `workspaces.fryanpan.com` is an addition, not a
replacement.

### The constraint that decides the design

The host gate (`packages/server/src/middleware/host-guard.ts`) is
**default-deny**, and it classifies every request into exactly one of four
kinds via `classifyHost`:

| kind | how it is reached | what it can touch |
|---|---|---|
| `local` | Host exactly matches loopback, the tailnet name, a LAN name, or an entry in `TRUSTED_HOSTS` | everything — this is the product |
| `share` | Host matches a live per-share Access hostname `share-<slug>.<baseHostname>` | one workspace, via `shareScopeAllows` |
| `link` | Host equals the single `CF_SHARE_PUBLIC_HOSTNAME` | one workspace, after redeeming `/s/<token>` for a session cookie |
| `deny` | anything else | `403 unknown_host` |

**The load-bearing line is `viaProxy`.** `isTrustedLocalHost` returns false
before it ever consults the candidate list when the request carries a `cf-ray`
header:

```ts
if (opts.viaProxy) return false; // arrived via Cloudflare — not our LAN
```

That is deliberate and the comment says why: cloudflared forwards the visitor's
`Host` verbatim, so without the veto any tunnel visitor could send
`Host: localhost` and be classified local. It is the same lesson the deploy
route learned — a gate on the `Host` header is spoofable by exactly the callers
it exists to exclude.

**So putting `workspaces.fryanpan.com` behind the Cloudflare tunnel does not
give Bryan the product at a nicer name.** Every request through the tunnel
carries `cf-ray`, is therefore never `local`, and lands in one of three places:

- **`deny`** if the hostname is configured nowhere → `403 unknown_host`.
- **`link`** if it is set as `CF_SHARE_PUBLIC_HOSTNAME` → `401 no_share_session`
  until a `/s/<token>` link is redeemed, and then still scoped: `shareScopeAllows`
  is an allowlist that does **not** include `/` (the landing page), `/api/docs`
  (the doc list), or any workspace other than the shared one. Opening
  `https://workspaces.fryanpan.com/` would 403 even with a valid session.
- **`share`** if it matches `share-<slug>.<base>` — a per-share hostname, not a
  product address.

Reaching the whole product at that hostname requires it to classify as `local`,
and that is the decision Bryan needs to make rather than something to pick
silently.

### Three options

| | how | works today? | what it costs |
|---|---|---|---|
| **A. Tunnel it as a share host** | cloudflared ingress → `:8787`, set `CF_SHARE_PUBLIC_HOSTNAME=workspaces.fryanpan.com` | yes, no code change | It is not the product. It is the external-reviewer surface: one workspace per redeemed link, no landing page, no doc list. Good for *sharing*, wrong for *being the address Bryan opens*. |
| **B. DNS-only CNAME to the tailnet name** | grey-cloud `workspaces.fryanpan.com` → `mac-mini.<private-network>`, plus `TRUSTED_HOSTS=workspaces.fryanpan.com` | no | No `cf-ray`, so it *would* classify local — but the tailnet cert is issued for `*.ts.net`, so `https://workspaces.fryanpan.com` presents a cert for the wrong name and every browser refuses. The name would also resolve only for devices already on the tailnet, which is the reachability the tailnet name already has. |
| **C. Tunnel + Cloudflare Access on the whole hostname + a small code change** | cloudflared ingress → `:8787`; an Access application covering `workspaces.fryanpan.com`; a new opt-in list of hostnames that may classify `local` **despite** being proxied | needs a ~30-line change | Real TLS on a real public name, reachable off the tailnet. The code change is a deliberate narrowing of a security property and must not ship without the Access application in front — see below. |

**Recommendation: C, and do not start it until Bryan has answered one
question** — is `workspaces.fryanpan.com` meant to be reachable from outside
the tailnet at all? If the honest answer is "no, I just want a nicer name on my
own devices", then the whole problem is TLS for a custom name on a tailnet host,
and B's blocker is the thing to solve (or the answer is to keep the ts.net name
and drop the domain). C only earns its complexity if off-tailnet access is the
point.

### What option C would actually change

Deliberately small, and phrased so its failure mode is refusal rather than
exposure:

1. **A second env var, not a widening of `TRUSTED_HOSTS`.** Something like
   `LF_PROXIED_TRUSTED_HOSTS` — a host in it classifies `local` even with
   `cf-ray` present. Keeping it separate matters: `TRUSTED_HOSTS` currently
   means "a name for this machine on a network I control", and quietly changing
   that meaning would grant tunnel access to entries added for LAN reasons.
2. **Refuse to honour it unless Access is configured.** If
   `CF_ACCESS_TEAM_DOMAIN` is unset, the list must be ignored with a loud
   startup log — otherwise anyone who can reach the tunnel and send
   `Host: workspaces.fryanpan.com` has the full API, which is precisely the
   hole the `viaProxy` veto was added to close (security review 2026-08-05, per
   the header comment in `host-guard.ts`).
3. **The existing legacy whole-server Access branch then does the work.**
   `server.ts` already has `else if (cfAccessVerifier && !shares)` — "cfAccess
   configured WITHOUT per-share hostnames means the entire deployment sits
   behind Access, so even a local-looking Host must present a token." A
   proxied-trusted host classifying `local` falls into exactly that branch. Note
   the `!shares` condition: if link/Access sharing is ever configured on the
   same process, this branch stops running and the design needs re-reading.
4. **Tests to write, both directions.** A proxied request on the listed host
   with a valid Access token reaches the product; the same request with the
   Access team domain unset is refused. The second is the one that must go red
   when the guard is removed — an "it works" test alone passes against a build
   with no gate at all.

### What in this repo reads a hostname

Everything that would need to know about a new host, from a full sweep:

| location | what it does | needs changing? |
|---|---|---|
| `TRUSTED_HOSTS` env → `bin.ts:96` → `opts.trustedHosts` | feeds **both** the host gate (`extraHosts`) and the browser-origin/CORS policy (`server.ts:989`, `server.ts:1000`) | yes — one variable covers both surfaces, which is why there is no second CORS step below |
| `LF_PUBLIC_BASE_URL` → `normalizePublicBaseUrl` (`public-host.ts`) | the single source of every `reviewUrl` / `entryUrl` / `hubUrl` an agent pastes to Bryan | **yes, and this is the step that is invisible if skipped** — see the trap below |
| `scripts/launchd/com.fryanpan.live-feedback.plist.template` | carries only `HOME`, `PATH`, `LF_PUBLIC_BASE_URL` today | yes, if any new env var must survive a reinstall |
| `scripts/launchd/install.sh` | regenerates the plist from that template on every run | yes, to pass the new variable through |
| `.claude/live-feedback.json` → `trustedPreviewDomains` | gates which hosts an agent may `navigate` to via the Chrome hook | yes — add `fryanpan.com`, or agents cannot open the new URL |
| `CF_SHARE_PUBLIC_HOSTNAME` / `CF_SHARE_BASE_HOSTNAME` | link-mode and Access-mode share hostnames | only if option A |
| `publicHost()` / `lanHostnames()` / `tailscaleHost()` (`public-host.ts`) | discovers this machine's own names, 60s TTL | no — discovery, not configuration |
| `packages/server/test/host-guard.test.ts` and friends | use `mac-mini.<private-network>` as a fixture | no — fixtures, and the tailnet name is staying anyway |

**No hostname is hardcoded in server or MCP source.** The tailnet name appears
only in tests, docs, and `.claude/live-feedback.json`.

### The trap, stated because it has already cost a deploy once

Standing up HTTPS on a new name and **not** moving `LF_PUBLIC_BASE_URL` looks
exactly like success: the new URL answers, a spot check passes, and every link
the server emits still points at the old origin. `docs/process/tailnet-https.md`
records this happening for the tailnet cutover, and the shape is identical here.

Two more, both from `docs/process/learnings.md`:

- **Editing the installed plist by hand is a stopgap.** `install.sh`
  regenerates it from the template on every run, so a hand-written value is
  discarded at the next reinstall.
- **The reinstall's restart is the client deploy.** Prod rebuilds the browser
  bundles from the primary checkout at every start, so a config-only reinstall
  ships whatever that checkout is parked on. **Pull first**, then reinstall,
  then read `release.json` — the deploy is done when `sourceRef` is the commit
  you meant to ship, not when the restart returns.

### Cutover (option C), step by step

Ordered so that each step's failure is visible before the next one depends on
it. Steps 1–3 are reversible; step 6 is the one that changes what agents paste.

1. **Decide the question above** — off-tailnet access, yes or no. If no, stop
   and re-scope.
2. **DNS + tunnel.** Add a `workspaces.fryanpan.com` public hostname to the
   existing cloudflared tunnel, pointing at `http://127.0.0.1:8787`.
   `docs/product/sharing.md` §6 has the ingress shape; the wildcard entry for
   shares stays alongside it.
   *Verify:* `curl -sS -o /dev/null -w '%{http_code}' https://workspaces.fryanpan.com/`
   returns **403** with body `{"error":"unknown_host"}`. A 403 here is the
   **success** condition — it proves the tunnel reaches the server and the gate
   is doing its job. A `000` means the tunnel is not wired; a `200` means
   something is very wrong and should be investigated before continuing.
3. **Cloudflare Access application** covering that exact hostname, allowing
   Bryan's identity. *Verify:* an incognito window is challenged before it ever
   reaches a 403 from the server.
4. **Land the code change** (option C above) as its own PR, with both
   directions tested. Nothing about the deploy has changed yet at this point.
5. **Reinstall the launchd job** with the new environment, after pulling:
   ```bash
   git pull --ff-only origin main            # in the PRIMARY checkout
   LF_PUBLIC_BASE_URL=https://workspaces.fryanpan.com \
   LF_PROXIED_TRUSTED_HOSTS=workspaces.fryanpan.com \
   CF_ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com \
     ./scripts/launchd/install.sh
   cat ~/.local/state/live-feedback/client/current/release.json
   ```
   *Verify:* `sourceRef` matches the commit you meant to ship, and the startup
   log names the proxied-trusted host.
6. **Verify both origins, with the old one as the control.** The tailnet origin
   must keep working — if it stops, the change has replaced rather than added:
   | check | expect |
   |---|---|
   | `https://workspaces.fryanpan.com/` after Access | 200, landing page |
   | `https://mac-mini.<private-network>/` | 200, unchanged — **this is the control** |
   | `http://localhost:8787/` | 200, unchanged |
   | a `reviewUrl` from a fresh `create_review_doc` | starts `https://workspaces.fryanpan.com` |
7. **Add `fryanpan.com` to `trustedPreviewDomains`** in
   `.claude/live-feedback.json` so agents can navigate to the new URL.
8. **Roll back** by reinstalling with the previous `LF_PUBLIC_BASE_URL` and
   removing the Cloudflare hostname. The DNS record and the Access application
   are the only pieces outside the repo, and both are deletable.

---

## Part 2 — renaming the repo to `claude-workspaces-plugin`

**The rename itself is Bryan's, confirmed in the terminal — not an agent
action.** What follows is the checklist and the risks.

### What is at stake

The repo is a **GitHub-source plugin marketplace**. Peers do not clone it; each
session's MCP child loads
`${CLAUDE_PLUGIN_ROOT}/mcp/index.js` out of a version-keyed cache under
`~/.claude/plugins/cache/`, and that cache is refreshed by
`command claude plugin update live-feedback@claude-live-feedback` — which prod
now runs at boot and every 30 minutes (`LF_PLUGIN_REFRESH_MINUTES`). If a rename
breaks the fetch, the symptom is **silent**: `claude plugin update` reports
success when it copies nothing, so the fleet simply stops receiving releases
and no surface says so.

### The install id does not change

`live-feedback@claude-live-feedback` is `<plugin name>@<marketplace name>`, and
both come from JSON inside the repo — `.claude-plugin/marketplace.json` declares
marketplace `claude-live-feedback` containing plugin `live-feedback`. Neither is
the repo name. **Renaming the repo does not change the install id**, and
changing the id is a separate, more disruptive decision (every peer would have
to remove and re-add the marketplace). This PR deliberately leaves the id alone.

### Checklist

**Before the rename**

- [ ] Confirm nobody has a PR mid-flight that would be disrupted. Open PRs
      survive a rename, but a peer with the old remote will push through a
      redirect, which is worth knowing about rather than discovering.
- [ ] Note the current fleet state: which peers are on which plugin version, so
      "did the rename break delivery" has a before-value. The workspace presence
      strip reports attached sessions — and remember its stated limit, that an
      empty `behind` list is not a fleet-wide clearance.

**The rename** (GitHub UI, Bryan)

- [ ] Settings → General → Repository name → `claude-workspaces-plugin`.

**Immediately after**

- [ ] **Update this machine's primary checkout remote** —
      `git remote set-url origin git@github.com:fryanpan/claude-workspaces-plugin.git`.
      The redirect makes this optional, not unnecessary: an explicit remote is
      what stops the repo depending on a redirect nobody controls.
- [ ] **Update every linked worktree's expectation** — they share the primary
      checkout's `.git`, so one `set-url` covers all of them. Verify with
      `git remote -v` from one worktree.
- [ ] **Re-point the marketplace registration** if `claude plugin marketplace
      list` still shows the old URL. This is the step most likely to be needed
      and least likely to be remembered.
- [ ] **Verification, and it must be run by a PEER, not here.** One peer runs
      `command claude plugin update live-feedback@claude-live-feedback` and then
      restarts — in that order, because the cache is version-keyed and
      restarting first has demonstrably moved a session *backwards* a version.
      The check that counts is the plugin version that session reports on
      `attach_agent`, read off the board's presence strip. `claude plugin
      update` printing success proves nothing; it prints success when it copies
      nothing.
      Note `command` is load-bearing — on this machine `claude` is a shell
      function that injects flags ahead of the subcommand, so the bare form dies
      with "Input must be provided either through stdin or as a prompt
      argument", which reads exactly like a permission refusal and was once
      filed as one.
- [ ] **Confirm the prod auto-refresh still works** — it spawns the resolved
      binary with a fixed argv, so it is not affected by the shell function, but
      it *is* affected by a stale marketplace URL. Check the server log after
      the next 30-minute tick, or call `request_plugin_refresh`.

**Outside this repo — name them, do not edit them from here**

- [ ] `~/dev/ai-team-lead/registry.yaml` — the fleet registry's entry for this
      project carries the repo name and its `public: true` flag. The pre-push
      leak gate resolves project names from it, so a stale entry there is a
      scrub-gate concern, not just tidiness.
- [ ] Any peer's `.mcp.json` or launch config that names the repo path. Paths on
      *this* machine do not move (the rename is remote-only), so this is about
      other machines if any exist.
- [ ] Bookmarks, Linear links, and the storyboard doc's repo URL
      (`docs/product/video-storyboard-v0.0.1.md`) — cosmetic, left as history.

### Risks, and how each one presents

| risk | how it shows up | mitigation |
|---|---|---|
| Marketplace fetch silently stops | peers stay on their current version forever; no error anywhere | the peer verification step above, with the *version the session reports* as the reading — not the updater's own success message |
| Someone creates `fryanpan/claude-live-feedback-plugin` later | the redirect stops working, and the failure is indistinguishable from a network problem | consider keeping the old name claimed, or move off the redirect immediately by re-pointing every remote and the marketplace registration |
| A peer restarts before updating | drops onto a stale cache — moves *backwards* a version | update, **then** restart; already recorded in learnings.md |
| The prod refresher's URL goes stale | no release reaches this machine; prod keeps serving whatever it has | check the server log after one refresh tick rather than assuming |

### One thing this plan does not answer

Whether `.claude-plugin/marketplace.json`'s `description` ("Home for the
live-feedback plugin — point-and-comment review for Claude Code agents") and
`homepage` should move to the new name at the same time. Both are user-visible
in a marketplace listing, but they sit in the file the version gate reads, and
editing them alongside a rename mixes two changes whose failure modes are
different. Suggested: do it as a separate, boring PR after the rename is
verified.
