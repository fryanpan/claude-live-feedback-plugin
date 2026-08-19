---
name: setup
description: First-time setup for a fresh clone of claude-workspaces-plugin. Installs JS deps, wires the dev-channels shell alias, registers + installs the plugin user-wide, and optionally installs the macOS launchd supervisor so the server survives reboots. Run this once after cloning the repo, then ask Claude to start using the claude-workspaces tools.
user-invocable: true
---

# Setup

First-time setup for a fresh clone of `claude-workspaces-plugin`. Walk the user through the steps in order. Pause for confirmation between sections that touch system state; skip optional sections if they say no.

## What this skill does

Brings a fresh checkout of this repo to a working state:

1. Installs JS dependencies (`bun install`)
2. Wires the shell alias that enables Claude Channels for `plugin:claude-workspaces@claude-workspaces`
3. Registers the local repo as a Claude Code marketplace and installs the plugin at user scope
4. (Optional) Installs the macOS launchd supervisor so the claude-workspaces server survives logout / Mac reboot / crashes
5. (Optional on macs with home on a non-default volume) Surfaces the Full Disk Access prereq for the launchd-spawned bun

## Steps

### 1. Confirm scope with the user

Ask once:

> "I'll run first-time setup for this repo. Plan: install JS deps, wire the dev-channels shell alias in your `~/.zshrc` (or equivalent), register this repo as a local Claude Code marketplace, and install the plugin at user scope. Optionally I can install the macOS launchd supervisor so the server runs in the background and survives reboots. Anything you want to skip up front?"

Wait for their answer. If they say "just do it," proceed; if they want to skip parts (e.g. the launchd supervisor), honor that.

If `node_modules/` already exists, `~/Library/LaunchAgents/com.fryanpan.claude-workspaces.plist` is present, and the alias is already in their shell init — recap "Already set up — here's what I'd suggest next" and exit. Don't redo steps unnecessarily.

### 2. Install JS dependencies

```sh
bun install
```

If `bun` isn't on their PATH, point them at <https://bun.sh> — don't install bun for them. Once they have it, retry.

Verify: `node_modules/` exists at the repo root.

### 3. Wire the shell alias for Claude Channels

The plugin uses Claude Code's channel events (push notifications from the server to the agent session). That feature is currently behind the `--dangerously-load-development-channels` flag. Easiest way to keep it active is a shell function in their `~/.zshrc` (or `~/.bashrc` if they use bash):

```sh
claude() { /path/to/claude --dangerously-load-development-channels plugin:claude-workspaces@claude-workspaces "$@"; }
```

Important:

- Confirm their shell first (`echo $SHELL`).
- Find their actual `claude` binary path (`which claude`) — substitute it into the alias.
- Show them the line before appending it to their init file. Ask: "Want me to append this to your `~/.zshrc`?" Wait for explicit yes — this modifies a file they own.
- After appending, tell them to run `source ~/.zshrc` (or open a new terminal) and relaunch Claude Code from that new shell.

If they'd rather edit the file themselves, give them the exact line and the file path.

### 4. Register the plugin + install at user scope

From the repo root:

```sh
claude plugin marketplace add .
claude plugin install claude-workspaces@claude-workspaces --scope user
```

Explain: the first command registers this checkout as a local plugin marketplace; the second installs the claude-workspaces plugin user-wide so it's available in every Claude Code session.

There is **no `npm link` step** — the MCP server bundle is vendored into the plugin tree at `packages/plugin/mcp/index.js` and invoked via `${CLAUDE_PLUGIN_ROOT}` substitution in `.mcp.json`. (See PR #35 for why we moved off the `npm link` install path.)

After install, the plugin's tools should appear when they ask Claude things like:
- "Show me the doc `<your doc name>` in a workspace"
- "Show me a mockup in a workspace"
- "Show me the dev server in a workspace"

### 5. (Optional) Start the server

```sh
bun run dev
```

This is the foreground supervisor — fine for development, dies when the terminal closes. Lists three reachable URLs (`localhost`, Tailscale hostname, LAN). Hand them one of those URLs combined with the review URL pattern Claude will give them once a doc is bound.

Tell them to keep this terminal open while they work; close it when done. For an always-on setup, point them at the next step.

### 6. (Optional) Install the macOS launchd supervisor

If they want the server to stay up across logout / Mac reboot / crashes, install the per-user LaunchAgent:

```sh
./scripts/launchd/install.sh
```

Before running it, **check the repo path**:

```sh
pwd -P
```

**Heads-up for macs with home on a non-default volume.** If the resolved path starts with `/Volumes/<X>/Users/...` (e.g. `/Volumes/Data/Users/bryanchan/...`), the launchd-spawned bun needs **Full Disk Access** to read the repo — otherwise it wedges in `getcwd()` with EPERM, logs stay empty, and the install script times out. Grant it FIRST:

1. System Settings → Privacy & Security → Full Disk Access
2. Click "+", then ⌘⇧G to type `/Users/<user>/.bun/bin/bun`
3. Toggle it on
4. Then re-run `./scripts/launchd/install.sh`

If `pwd -P` shows a `/Users/...` path directly (standard macOS install), the FDA step is not required — skip it.

`install.sh` does its own detection and will print the same instructions if it sees the symptom pattern (empty logs + repo under `/Volumes/`). Either way, the recovery is the same.

Verify after:

```sh
launchctl print "gui/$(id -u)/com.fryanpan.claude-workspaces" | grep "state ="
curl -sS http://localhost:8788/ -o /dev/null -w "%{http_code}\n"
```

Should print `state = running` and `200`.

### 6b. (Optional) Serve over HTTPS on the tailnet — required for voice

Skip this unless the machine is on a Tailscale tailnet **and** anyone wants the
board's voice dock or review-doc dictation from a device other than the host.

`http://<tailnet-name>:8787` is **not a secure context**, so Chrome does not
expose the microphone there at all — `navigator.mediaDevices` is `undefined`.
The failure is worse than a plain refusal: the `SpeechRecognition` constructor
still exists, so `start()` answers `not-allowed` with no permission prompt, and
telling someone to "allow the mic for this site" sends them looking for a
control the browser never offered. Loopback is exempt (browsers trust it
whatever the scheme), which is why it works on the host and nowhere else.

Two steps, and **the second is not optional polish** — doing only the first
looks like success and changes nothing for voice:

```sh
# 1. Terminate TLS on the tailnet name, proxying to the running server.
#    Note the flag form: the port must arrive as --https=, because `serve`
#    reads a bare positional as the target.
tailscale serve --https=443 --bg http://127.0.0.1:8787
tailscale serve status        # must say "(tailnet only)"

# 2. Point every link the server emits at that origin, then restart it.
LF_PUBLIC_BASE_URL=https://<tailnet-name> ./scripts/launchd/install.sh
```

`publicBaseUrl` is the single source of every `reviewUrl`, `entryUrl` and
task-import `hubUrl` the server hands a human. Without step 2 those keep
reading `http://<tailnet-name>:8787`, so every link an agent pastes lands back
on the insecure origin and voice stays dead for whoever follows it. The value
is validated at boot — a malformed one is a named startup failure, never a
silent fallback.

**`serve` is tailnet-only. `tailscale funnel` is the verb that would make this
public — do not use it.** And `install.sh` regenerates the plist from a
template on every run, so a hand-edited `LF_PUBLIC_BASE_URL` is silently
discarded the next time anyone reinstalls; set it through the installer.

Full rationale, the measured before/after table, the non-vacuous verification
(each check needs its "before" reading or it proves nothing), and rollback:
[docs/process/tailnet-https.md](../../../docs/process/tailnet-https.md).

### 7. Confirm done + suggest next step

Recap in one line: "Setup complete. Plugin installed at user scope; server <foreground / launchd-supervised>."

Then suggest the natural next move:
- "Bind a markdown file you want to review: ask me `please bring docs/foo.md into a workspace` — I'll create the review doc and give you a URL."
- "Or try the demo mockup at `http://<host>:8788/demos/mockup` to see the comment widget in action."

## What to avoid

- **Don't append to `~/.zshrc` without explicit confirmation.** Shell init files are user-owned; modifying them requires per-turn user yes.
- **Don't run `./scripts/launchd/install.sh` without confirmation.** It writes to `~/Library/LaunchAgents/` and starts a service that persists across sessions.
- **Don't grant Full Disk Access on the user's behalf** — that requires the System Settings GUI + an auth prompt. Always direct the user to do it themselves.
- **Don't install bun for them** — let them install via the official installer (<https://bun.sh>).
- **Don't repeat this skill on subsequent runs.** If `node_modules/` exists and the alias is already wired and the plugin is installed, tell the user "Already set up — what would you like to do?" and exit.
