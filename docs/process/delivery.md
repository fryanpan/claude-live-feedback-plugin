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
who has your change and who does not — and the single human step that is left.

| What | Travels as | Lands when | Human step |
|---|---|---|---|
| Plugin (commands, skills, hooks, MCP bundle) | Version-keyed copy from the GitHub marketplace | Prod refreshes the cache on its own, ≤30 min after the merge | Peer restarts its session |
| MCP server code | `packages/plugin/mcp/index.js`, **tracked in git** | Same as the plugin | Same |
| Browser client (markdown app + widget) | `packages/markdown-app/dist` / `packages/widget/dist`, **untracked**, published at server start | Server restart | None (reload the page) |
| Server code | The checkout the service runs from | Server restart | None |

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

The restart is the human step, and it is the only one. A running session
resolved `CLAUDE_PLUGIN_ROOT` to a version-keyed directory at launch, and an
MCP reconnect re-execs that same path — it can pick up new tool schemas from
the bundle it already points at, but it cannot cross a version boundary.

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
      then confirm the release published in the supervisor log.
- [ ] Plugin change peers need now? → restarting prod refreshes the cache at
      boot; otherwise it lands within 30 min on its own. Either way tell peers
      to **restart their sessions** — that step is still theirs.
