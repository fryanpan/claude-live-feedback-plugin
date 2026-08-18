# Delivery: how a merged change actually reaches someone

Merging is not shipping here. A change in this repo reaches three different
audiences over three different mechanisms, and each one can succeed loudly
while delivering nothing:

- **an agent in another session** gets the plugin — a versioned copy fetched
  from a GitHub marketplace into that machine's plugin cache;
- **a browser** gets the review client — bundles the server publishes at
  start;
- **you** get neither until the right one of those has happened, which is why
  "it's merged" has repeatedly been the wrong answer to "why don't I see it".

What this doc buys you: after a merge you should be able to say, in one line,
who has your change and who does not — and who has to do what about it.

| What | Travels as | Lands when | Who acts |
|---|---|---|---|
| Plugin (commands, skills, hooks, MCP bundle) | Version-keyed copy from the GitHub marketplace | Prod refreshes the cache on its own, ≤30 min after the merge | **The peer**, by restarting its own session |
| MCP server code | `packages/plugin/mcp/index.js`, **tracked in git** | Same as the plugin | Same |
| Browser client (markdown app + widget) | `packages/markdown-app/dist` / `packages/widget/dist`, **untracked**, published at server start | Prod restart | **You** — pull the deploy source, then restart prod (or `POST /api/deploy`, which is those two steps as one); the reader only reloads |
| Server code | The checkout the service runs from | Prod restart | Same |

Exactly one row needs a person, and it is not the one people assume. **A peer's
session restart cannot be run for it by anybody else.** Restarting prod can, and
as of 2026-08-17 it is an agent action — do it rather than asking (Bryan's call,
reversing an earlier rule that read the other way).

---

## The plugin ships through a GitHub marketplace

The marketplace `claude-live-feedback` resolves to the GitHub repo
`fryanpan/claude-live-feedback-plugin` (since 2026-08-13; it used to point at a
local directory). Installing or updating fetches the repo, reads
`.claude-plugin/marketplace.json`, and copies the plugin into a
**version-keyed** cache path — `.../plugins/cache/<marketplace>/<plugin>/<version>/`.
Everything downstream follows from that path containing the version number.

A peer installs, once:

```bash
claude plugin marketplace add fryanpan/claude-live-feedback-plugin
claude plugin install live-feedback@claude-live-feedback --scope user
```

and afterwards updates with:

```bash
claude plugin update live-feedback@claude-live-feedback
```

**Sharp edge — `claude plugin marketplace remove <name>` also uninstalls the
plugin.** Swapping the source (local directory → GitHub, or a rename) is
therefore remove-then-add-then-*reinstall*, and between the remove and the
install there is a window with no plugin at all — sessions started in that
window come up with no live-feedback tools. Do the three commands back to
back:

```bash
claude plugin marketplace remove claude-live-feedback
claude plugin marketplace add fryanpan/claude-live-feedback-plugin
claude plugin install live-feedback@claude-live-feedback --scope user
```

## Three version sites, one value

`claude plugin update` compares the version string. If plugin content changed
and the version did not, it **copies nothing and reports success** — silent on
both ends. That is how 25 feature commits sat undelivered between 2026-05-09
and 2026-08-10.

Bump the patch on every PR that touches `packages/plugin/**`, in all three
places, to the same value:

1. `packages/plugin/.claude-plugin/plugin.json` — what the installed copy
   reports about itself.
2. `.claude-plugin/marketplace.json` — what the marketplace advertises, and
   what `claude plugin update` compares against.
3. The `PLUGIN_VERSION` constant in `packages/mcp/src/mcp.ts` — the
   `serverInfo` a client sees in the MCP **initialize handshake**, and the
   version each session reports to its board on `attach_agent`. One constant
   for both, so those two can never disagree.

The third one exists because the MCP server introduces itself independently of
the plugin manifest, and it is the one that has actually drifted in the field:
a bump that followed the old "both manifests" instruction exactly still shipped
a handshake three minor releases behind. `packages/mcp/test/launcher.test.ts`
now asserts the handshake against `plugin.json` — but it drives the **bundle**,
so the assertion only sees your change after `bun run build:mcp`.

CI enforces the dangerous half: `bun run check:plugin-version` fails the build
when a PR touches `packages/plugin/**` without moving the version forward, or
when the two manifests disagree.

## Two bundles, two completely different mechanisms

Do not conflate these. They fail differently and are fixed differently.

**`packages/plugin/mcp/index.js` is TRACKED.** Peers load the MCP server from
this committed artifact (`.mcp.json` → `${CLAUDE_PLUGIN_ROOT}/mcp/index.js`),
not from the TypeScript source. Editing `packages/mcp/src/**` and merging
delivers nothing: any such PR must run `bun run build:mcp` and commit the
regenerated bundle in the same change. CI rebuilds it and fails if the
committed copy differs from a fresh build, which is also why CI pins its Bun
version — bundler output moves between releases. (`packages/mcp/dist/` is
gitignored and ships nothing.)

**`packages/markdown-app/dist` and `packages/widget/dist` are UNTRACKED.** They
are built on the machine that serves them, at server start. Nothing about them
travels through git, and grepping them proves little — they are minified, so
look for string literals or read `BUILD_INFO.txt`.

## Restart == deploy, for the browser client

A prod restart used to reload the *server* while every browser kept running the
*previous* client: `dist` was assumed to be "built at deploy time" and nothing
enforced it. On 2026-08-11 that shipped generated thread summaries the server
computed and no card could display.

Prod (`scripts/serve.ts --no-watch`, what the launchd service runs) now rebuilds
both browser bundles at startup, before the server process spawns. **Restarting
prod is the deploy.** A build that fails logs loudly and leaves the previous
client serving — stale beats down.

### Running it

```bash
git pull --ff-only origin main      # in the PRIMARY checkout — prod's deploy source
launchctl kickstart -k gui/$(id -u)/com.fryanpan.live-feedback
cat ~/.local/state/live-feedback/client/current/release.json
```

The pull is first because **the restart deploys whatever the deploy source is
parked on, not what is on `origin/main`.** Measured 2026-08-17: a kickstart run
specifically to ship a just-merged client came up in five seconds, answered 200,
and republished the *previous* client — the checkout was 10 commits behind, with
a clean tree and nothing wrong with it. A healthy server serving a stale bundle
is indistinguishable from a healthy server serving a fresh one, which is why the
third command is part of the procedure rather than a nicety: the deploy is done
when `release.json`'s `sourceRef` is the commit you meant to ship. `sourceRef`
is `git describe` on the deploy source at publish time, so it answers exactly
this question — see [deploy-source.ts](../../packages/server/src/deploy-source.ts)
for what its `-dirty` suffix does and does not mean.

### Or ask the server to do it

`POST /api/deploy` runs exactly those three steps as one operation — pull
(`merge --ff-only`, never a rebase or a reset), restart, and record the outcome
to disk, since the restart ends the process that would otherwise report on it.
`GET /api/deploy` reads that record back and is safe at any time; reading is not
deploying.

**There is no "just restart" verb, here or anywhere else, and that is the
design.** A restart over an unpulled checkout rebuilds the same bundles and
publishes the same client while printing a successful deploy — the failure the
section above is about. Binding the pull and the restart into one operation
makes that state unexpressible rather than merely discouraged.

Two limits worth knowing. The route answers only to a **loopback peer address**
(not the `Host` header, which is client-controlled — a LAN and a tailnet client
were both measured reaching this server sending `Host: localhost`), so it runs
from the box; dev and staging answer 501 by construction. And a bound document
with un-flushed edits **refuses** the deploy, with `force` to accept the loss —
see [learnings.md](learnings.md), "A git operation on a bound file is an editor
save", for why a pull over a live doc is undone about a second after git reports
success. The manual three steps remain the fallback for the one case the route
cannot serve: a server that is already down.

Then check a feature literal in the served bundle, old bundle first — a literal
only discriminates if it is absent from the previous release. `releases/` keeps
the previous one on disk precisely so that half is checkable.

The same ordering applies to any restart from any cause, including a
`scripts/launchd/install.sh` reinstall done for an unrelated config reason — see
[tailnet-https.md](tailnet-https.md), where it is the same trap wearing different
clothes.

What origin that client is *reached on* is a separate question from which
bundle it is, and it decides whether browser features gated on a secure
context (the microphone, and so all voice input) exist at all. See
[tailnet-https.md](tailnet-https.md).

### A failed build says so on the board, not only on stderr

Stale beating down is the right call, but for a while the only record of it was
a line on the supervisor's stderr, which is not a surface anybody reads. A build
that keeps failing then means an ever-older client against an ever-newer server
— the same server-new/client-old split this whole design descends from, arriving
through the failure path instead of the happy path.

So every publish attempt leaves a trace that outlives the process that made it:

- `releases/<id>/release.json` — when this release was published, the **source
  commit** it was built from, and which paths in the deploy source were
  uncommitted at the time. Freshness of the artifact is not freshness of the
  source: a checkout parked on an old commit builds successfully and stamps a
  current timestamp on old code, so the commit is part of the reading.
- `publish-log.json` beside the releases — how many attempts in a row have
  failed, since when, and with what error. A success clears the streak.

#### What `-dirty` on a `sourceRef` means

`sourceRef` is `git describe --always` plus `-dirty` **only when a modified
tracked path is something this deploy builds or serves.** It is not `git
describe --dirty`, and the difference is the whole point: prod's deploy source
is also where bound review documents live, so a tracked `.md` under `docs/`
sits modified for as long as a review is open. For a day in August 2026 every
release published during an ordinary editing session was stamped `-dirty`, and
a marker that fires on document editing is a marker people learn to skip.

The exemption list is **closed by default and deliberately tiny** — `docs/**`
and top-level `*.md`. Anything else, `demos/**` included (it is served live out
of the deploy source), still earns the suffix. The direction is chosen so that
a mistake in the list can only produce a `-dirty` on a release that was fine,
never a clean marker on a release built from uncommitted code. The rule, the
reasoning, and what to re-check before adding an entry live in
`packages/server/src/deploy-source.ts`.

`release.json` also carries `dirtyPaths` (capped) and `dirtyPathCount` — every
modified path, not only the ones that set the suffix. So a clean `sourceRef`
sitting next to `dirtyPaths: ["docs/product/plans/…"]` reads as a decision
rather than an oversight, and a `-dirty` one names the file that earned it.

The workspace hub's presence strip reads that, next to the plugin-drift notice,
and says how old the served client is, how long the build has been failing, and
that the fix ends in a restart. **It arms on two failed starts in a row, or one
over a client already older than a day** — a single failed start over a client
published minutes ago stays quiet, because the browser is running essentially
the code that build meant to replace and a warning there is how people learn to
ignore warnings.

Two deliberate limits. The signal is **owner-only** (a build error carries this
machine's absolute paths, and which release is live is a fact about the host's
deploy rather than workspace content). And only the process that **published**
the release reports on it: `serve.ts --no-watch` passes
`--client-release-root`, nothing else does, because `bun run dev` and `bun run
staging` serve their own checkout's `dist` while sharing this machine's default
release root — reading it there would put prod's deploy state on a board that is
not serving prod's client.

### Where the served client lives (and why not in the checkout)

Prod used to serve `packages/markdown-app/dist` *out of the primary checkout,
per request*. That made building bundles anywhere in that checkout a deploy to
everyone, and made the served client silently track whichever commit that
working tree was parked on.

So the built bundles are now copied **out** of the checkout at startup into an
immutable, numbered release:

```
<state root>/live-feedback/client/
  releases/<timestamp>-<seq>/{markdown-app,widget}/   ← never written to again
  current -> releases/<timestamp>-<seq>               ← symlink, for operators
```

The state root is `$XDG_STATE_HOME` (default `~/.local/state`), overridable
with `LF_CLIENT_ROOT`. The switchover cannot tear: the copy lands in a
dot-prefixed staging directory nothing scans, becomes a release by `rename(2)`
(so it appears complete or not at all), and the `current` pointer moves by
renaming a fresh symlink over it, which is also atomic. Nothing ever copies
into the directory being served. The server is handed the **resolved** release
path, so no request can resolve half a path either side of a swap. The last few
releases are retained, so a rollback is repointing `current` and restarting.

Consequences worth holding onto:

- A `git checkout` / rebase / stash in the repo no longer changes what any
  browser loads.
- The primary checkout is still prod's **deploy source** — bundles built there
  go out at the next restart. That is why `bun run staging` still refuses to
  run from it.
- `bun run dev` and `bun run staging` are unaffected: they serve the local
  `dist` directly (the server takes `--widget-dist` / `--markdown-app-dist`,
  and without them falls back to the checkout's own `dist`).

## The one step a person still has to take

**A peer must restart its session to pick up a new plugin version.** The plugin
cache path contains the version number, and a running session resolved
`CLAUDE_PLUGIN_ROOT` to the old version's directory at launch — so it keeps
loading the old commands, skills, and MCP bundle no matter what lands on disk.
An MCP reconnect re-execs that same old path: it can pick up new tool schemas
from the bundle it already points at, but it cannot cross a version boundary.
Same constraint as `FEEDBACK_AGENT_NAME` and `FEEDBACK_BASE_URL`, which are
read once from the launch environment.

So the full path for a plugin change is: merge → bump landed → the cache
refreshes itself (below) → **peer restarts the session**.

That session restart is the human step, and for the plugin it is the only one —
and unlike the prod restart it genuinely cannot be delegated. A running session
resolved `CLAUDE_PLUGIN_ROOT` to a version-keyed directory at launch, and an
MCP reconnect re-execs that same path — it can pick up new tool schemas from
the bundle it already points at, but it cannot cross a version boundary. Nothing
another process does to the cache reaches it; only its own relaunch does.

### Nobody has to remember to run the update

Prod polls it. `scripts/serve.ts --no-watch` passes
`--plugin-refresh-interval-ms`, and the server then runs
`claude plugin update live-feedback@claude-live-feedback` at boot and every 30
minutes (`LF_PLUGIN_REFRESH_MINUTES`; `0` turns it off). A merge therefore
reaches this machine's cache on its own, within the window.

This is safe to arm without asking because **it cannot interrupt anyone**: the
update rewrites a version-keyed cache directory and the `installed_plugins.json`
pointer, and every running session keeps loading the bundle it already resolved.
The refresh never touches a live session; peers take the new version at their
own next restart.

Dev and staging deliberately do **not** do this — they are copies of the deploy
source, and a `bun run staging` that quietly updated the fleet's plugin would be
the same class of accident as building bundles in the primary checkout. On those
the route answers `501`.

Any peer can also ask for it directly, without waiting for the poll or routing
the ask through anyone: the `request_plugin_refresh` MCP tool, or
`POST /api/plugin/refresh`. Concurrent asks collapse into one fetch.

Read the result rather than the exit code. It reports the cache version
**before and after, from disk** — `claude plugin update` reports success when
it copies nothing, which is how 25 commits once sat undelivered with green on
both ends. `changed: false` with matching versions means the cache was already
current; that is an answer, not a failure.

To run it by hand, do **not** use the bare command. On this machine `claude`
resolves to a wrapper that injects flags ahead of the subcommand, so
`claude plugin update …` is parsed as a prompt and dies with *"Input must be
provided either through stdin or as a prompt argument when using --print"*,
which reads like a permission refusal and was once written up as one. Use
`command claude plugin update live-feedback@claude-live-feedback` — `command`
bypasses functions and aliases. (The server never hits this: it spawns the
resolved binary path with an argv array and no shell.)

### Who is behind, without going to look

Every session reports the bundle it is **running** when it attaches to a
workspace, and the board's presence strip names any session older than the
version this server's deploy source would install, with both fix steps in
order. So "does my peer have this yet" is a thing you read rather than a thing
you audit — which matters because the failure mode is silence: eleven releases
once sat undelivered with everything green on both ends.

Two limits worth stating. "Released" means *this checkout's manifest*, not
GitHub — a checkout nobody pulled reports its own staleness as current, the
same limitation the published client release has. And a session that reports no
version at all is counted as behind, because the field ships in the release
that reads it; silence means older than this feature, not unknown.

### Neither side of that comparison reads a path (checked, negative result)

Worth stating because it is the natural next worry and re-deriving it costs
real time. The strip compares two numbers, and **neither is derived from an
install path, `installed_plugins.json`, or `${CLAUDE_PLUGIN_ROOT}`**, so
neither can be confidently wrong about which artifact is actually loaded:

- **What the session is running** is `PLUGIN_VERSION` in
  `packages/mcp/src/mcp.ts` — a compile-time literal **baked into the bundle**
  and sent on `attach_agent`. It is the artifact describing itself, so it is
  correct by construction whether that bundle was loaded from the version-keyed
  cache or straight out of a working tree. The MCP source contains no read of
  `installed_plugins.json`, `installPath`, or `CLAUDE_PLUGIN_ROOT` at all.
- **What the deploy source would install** is `readReleasedPluginVersion()`,
  which reads `packages/plugin/.claude-plugin/plugin.json` out of the checkout
  the *server process* was started from (resolved from `import.meta.url`). Also
  no cache, no pointer file.

The server's only reader of `installed_plugins.json` is
`readInstalledPluginVersion` in `plugin-refresh.ts`, and it has exactly one
call site: the before/after probe that decides whether `claude plugin update`
actually copied anything. It reads the `version` field, never `installPath`,
and it never feeds the strip. So a plugin's **source type — GitHub-source vs
directory-source — does not change any reading on this page.** (This
marketplace is GitHub-source, so `${CLAUDE_PLUGIN_ROOT}` does resolve into the
version-keyed cache; the point is that nothing here depends on that being
true.)

### The strip reads a board, not the fleet — and that is structural

The third limit is the sharpest, and it is the one that reads wrong rather
than merely being incomplete. **The strip's domain is "sessions that called
`attach_agent` on this workspace".** Anything else is not reported as current;
it is simply absent — and an absent session and a compliant one used to render
identically, as nothing at all.

Measured 2026-08-17. The board returned `behind: []` over exactly one
attachment, and a separate enumeration of the machine's sessions — taken
outside this server, which is what made it a control rather than a second look
at the same data — found several sessions releases back, including the one
doing the enumerating. Nothing on the board said so. The sting is that the
only session the strip had ever named as behind was the session that then
fixed itself: that took the reading from "names one" straight to "names
nobody", with no change whatsoever in the actual drift. **A surface whose
domain is "whoever opted in by attaching" measures participation, not
delivery** — and the sessions least likely to have attached are exactly the
stale ones, because attaching is itself something a newer bundle does more of.

**Can the server widen the domain?** Not for versions, no. A plugin version
reaches this server through exactly one door — the `pluginVersion` field on
`attach_agent` — and there is no server-wide session registry to compare
against. The MCP child makes no HTTP call at startup and never opens a
websocket, so a session that never attaches is invisible to every transport
the server has. Yjs awareness carries browsers, not agents. So "is the fleet
behind" is genuinely unanswerable from here, and **the answer is to say what
the reading covers, not to invent a fleet registry to make a broader sentence
true.**

That is what ships: every reading now carries its denominator and its domain.
`GET /api/workspaces/:id/attachments` returns `pluginRelease.checked` — how
many sessions the `behind` list was computed over, counted from the same
population the check filtered — and the presence strip renders a quiet line
even when nobody is behind: *"No attached session is behind 0.1.40 (1
checked) — only sessions that attach to this board are checked."* A board
nobody has attached to says *"nothing has been checked"* rather than going
silent. The only remaining silence is when there is no attachments read at
all, where even the domain is unknown.

**Consequence for anything that gates on this.** An empty `behind` list is
not a fleet-wide clearance and must not be used as one. Any precondition that
leans on it has to be written against sessions actually checked — "no session
attached to this board is older than X, and that was N sessions" — plus a
deliberate decision about the peers the board cannot see.

Note what this does *not* argue for. Removing an MCP **tool** needs no
delivery gate at all: each session launches its own MCP child from its own
version-keyed cache, both halves of a tool live in that one bundle, and the
restart that delivers a deletion is the same restart that delivers its
replacement — so a session that has not restarted never sees the removal.
What genuinely bites is **narrowing something old callers still send or still
read on the shared server**, and that is exactly the case where the strip
cannot tell you who those callers are, because the ones that never attached
are the ones you would most want named.

**The one widening that is available, and is not built.** The server does
record agents that never attached: `activity.jsonl` and each workspace's
`events.jsonl` carry an actor identity on every row, and those sets are a
strict superset of the attachment set. Neither carries a version, so it can
never say a peer is *behind* — but it could say "K agents have acted on this
board without ever attaching, and none of them has been checked", which turns
part of the invisible population into a named one. Deliberately left out here:
it puts a per-request log read on a polled route, and the denominator already
stops the reading from being mistaken for clearance.

## Reviewing work before it merges

Never build in the primary checkout to test something. Instead, from a **linked
worktree**:

```bash
bun run staging      # builds this worktree's bundles, serves :8788, throwaway data dir
```

Prod keeps serving 8787 with its own data throughout. The script refuses to run
from the primary checkout (that is prod's deploy source), and starts the server
via `packages/server/src/bin.ts` rather than `scripts/serve.ts` — because
`serve.ts` publishes the live port that the live-feedback MCP discovers, and
running it would silently repoint every agent on the machine at the staging
build.

To put an *agent* on staging, set `FEEDBACK_BASE_URL=http://<host>:8788` in its
launch environment (read once at session start, so it needs a restart).
Staging data never migrates to prod: evaluate pre-merge, then do the real work
once, after.

## Shipping checklist

- [ ] Touched `packages/mcp/src/**`? → `bun run build:mcp`, commit
      `packages/plugin/mcp/index.js`.
- [ ] Touched `packages/plugin/**`? → bump the patch in all three version
      sites, same value.
- [ ] `bun run test` and `bun run lint` green.
- [ ] Client change people need to see? → restart prod (that is the deploy),
      then confirm the release published — the supervisor log names it, and a
      failure that left the previous client serving shows up on the board's
      presence strip rather than only in that log.
- [ ] Plugin change peers need now? → restarting prod refreshes the cache at
      boot; otherwise it lands within 30 min on its own. Either way tell peers
      to **restart their sessions** — that step is still theirs.
