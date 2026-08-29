# Claude Workspaces Plugin

A Claude Code plugin that gives an owner and a team of Claude Code agents one shared surface — a board, the docs and mockups and dev servers hanging off it, and comment threads that survive edits — so the owner can review, redirect, and decide from a browser tab while the agents do the work. Point at a line, say "this", and the agent's edit lands seconds later.

## Goals

The root idea has not changed: make giving feedback to an agent as fast as pointing and saying "this." What changed is how much of my day runs through it. It began as a feedback widget for one agent and one doc; it is now the workspace I run a fleet of agents from, and the goals below are the ones it serves today.

1. **Work from the board, not chat.** Review, redirect, and meet in flows built for it. Agents file tasks and review items — a decision with options, or a question — and I answer them from a Home queue, one at a time. Each task carries an activity feed of what every agent did lately, so redirecting takes a comment on the task, not a chat session to find out where things stand.
2. **Review and steer from an iPad or phone, staying in flow.** Every surface is laid out for a tablet in landscape and a phone first; a review item is answerable with a thumb.
3. **Agents manage and prioritize the tickets so I rarely intervene.** Goals are ranked bands on the board; agents work them in strict priority order, file what they discover, and mark what blocks them. The server watches for stalled rows and unfiled asks and wakes the lead agent only when there is something to do. The `working-in-a-workspace` and `leading-a-workspace` skills the plugin ships are the contract every agent follows.
4. **An outside collaborator can review dev artifacts in under a minute of my time and five of theirs.** A share link publishes a board outside the tailnet; email-code sign-in means no account to create and nothing to install.
5. **Meetings on the doc.** Press one button and talk: live transcription in a strip beside the doc, and meeting notes that compose themselves at the natural pauses, with "file a ticket for that" landing on the board. Next: planning huddles started from the board with the mic on and everyone's recent edits summarized by person.

## What it does

- **The board.** Goals, ranked tasks, review items, comments, an activity feed per task, and a Home queue of everything waiting on me. Agents read it with `next_tasks`, write it with `create_tasks` / `task_transition` / `add_review_item`, and take the lead seat with `set_workspace_lead`.
- **Markdown docs** with comment threads anchored to text ranges. I edit the doc at the same time as the agent; the agent can propose edits as suggestions I accept or reject instead of applying them outright. `create_diff_review` turns a branch of a local repo into one review doc per changed file, with line comments.
- **Interactive mockups** — an HTML file served with the widget injected; point at an element and comment on it. Threads persist across the live reload when the agent updates the file.
- **Live dev servers** — the same flow, except the agent edits the source and the dev server's own reload pushes the change back to my browser.
- **Meetings** — live transcription and pause-driven notes on any doc; the transcript is durable and the notes go through the same edit path every other writer uses.
- **Voice navigation** — say what you want to see and the board opens it; a spoken change on the resource in view is applied on your own authority, and anything else goes to the attached agent verbatim.

## Installation

The fastest path:

```sh
git clone https://github.com/fryanpan/claude-workspaces-plugin.git
cd claude-workspaces-plugin
claude
```

Then in the Claude Code session, run:

```
/setup
```

Claude walks through every step — `bun install`, the dev-channels shell alias, plugin registration + install, and (optionally) the macOS launchd supervisor — pausing for confirmation on each side-effect.

After setup, ask Claude things like:

- "Show me the doc &lt;your doc name&gt; with workspaces"
- "Show me a mockup with workspaces"
- "Show me the dev server with workspaces"
- "Create a workspace for this project and file what we just discussed as tasks"

### Manual install (if you'd rather do it yourself)

1. Install JS deps:

   ```sh
   bun install
   ```

2. Enable channel events for the plugin. Add this one-line alias to your shell init file (e.g., `~/.zshrc`):

   ```sh
   claude() { /path/to/claude --dangerously-load-development-channels plugin:claude-workspaces@claude-workspaces "$@"; }
   ```

   Reload your shell (`source ~/.zshrc`) and relaunch Claude Code.

3. Register + install the plugin at user scope:

   ```sh
   claude plugin marketplace add .
   claude plugin install claude-workspaces@claude-workspaces --scope user
   ```

   The MCP server is bundled inside the plugin tree at `packages/plugin/mcp/index.js` and invoked via Claude Code's `${CLAUDE_PLUGIN_ROOT}` substitution, so no `npm link` step or PATH setup is needed — the plugin install is the complete install. Installing on another machine without a clone works too: `claude plugin marketplace add fryanpan/claude-workspaces-plugin`, then the same install command, and `claude plugin update claude-workspaces@claude-workspaces` afterwards.

## Run as a service (macOS)

By default `bun run scripts/serve.ts` runs in the foreground — convenient for development, but the server dies when the terminal closes. To keep it always-on (survives logout, Mac reboot, and crashes), install the launchd supervisor:

```sh
./scripts/launchd/install.sh
```

> **If your home directory lives on a non-default volume** (e.g. `/Volumes/Data/Users/...` symlinked into `/Users/`), grant **Full Disk Access** to `bun` first: System Settings → Privacy & Security → Full Disk Access → "+" → `~/.bun/bin/bun` (⌘⇧G to type the hidden path). Without it, the launchd-spawned bun gets EPERM on the repo's working directory and wedges in `getcwd()` — symptom is empty `~/Library/Logs/com.fryanpan.claude-workspaces.{out,err}.log`. Shell-spawned processes inherit Terminal's TCC scope and avoid this; launchd-spawned ones start fresh. `install.sh` detects the case and prints the same instructions.

The script writes `~/Library/LaunchAgents/com.fryanpan.claude-workspaces.plist`, bootstraps it into your user session, and waits for port 8787 to come up. Logs land at `~/Library/Logs/com.fryanpan.claude-workspaces.{out,err}.log`. The service runs as a per-user `LaunchAgent` — it starts at login (not boot) and stops at logout, which matches my always-logged-in Mac mini.

Re-run `install.sh` after pulling code that changes the launch args (it's idempotent — boots out the old plist first).

To uninstall:

```sh
./scripts/launchd/uninstall.sh
```

Useful commands once installed:

```sh
launchctl list | grep com.fryanpan.claude-workspaces   # status
launchctl kickstart -k gui/$(id -u)/com.fryanpan.claude-workspaces   # force restart
tail -f ~/Library/Logs/com.fryanpan.claude-workspaces.err.log         # follow logs
```

## What It Does Under The Hood

- **Uses [Claude Channels](https://code.claude.com/docs/en/channels) for push.** Comments, review answers, new tasks, voice requests, and board wakes arrive at the agent's session as `<channel source="claude-workspaces" ...>` events the same way GitHub mentions and CI failures do — no polling, no MCP round-trips just to check an inbox. A stalled board wakes the lead once per finding, not per tick, because a wake is a whole agent turn and priced like one.
- **Surface-anchored, not chat-anchored.** Docs are Yjs CRDTs; every comment carries an anchor to the exact text range or DOM element it is about, and the anchors ride along through concurrent edits. A big rewrite of the surrounding text can still detach a thread; the thread survives, and re-attaching it is manual.
- **Primitives, not bespoke flows.** The MCP surface is small and composable: `get_doc`, `find_and_replace`, `create_anchor`, `edit_at_anchor`, `rewrite_thread_region`, `post_reply`, `add_review_item`, `create_tasks`, `next_tasks`. Agents stitch them however the workflow needs. Two hooks close the loop from the other side: a Stop hook posts a one-line note of each turn to the agent's current task, which is what the activity feed is made of, and a PermissionDenied hook notes the denial there too.
- **A vanilla web-component widget.** One `<script>` tag, Shadow DOM, no framework dependencies, so it injects into any mockup or dev server without fighting the host page.

## What it's not

- **Not a hosted SaaS.** The server runs on your machine, on your network. Reviewers reach you over Tailscale or LAN, or through a share link you choose to publish. No public tunnel by default.
- **Not a replacement for issue trackers, except that for me it has become one.** It started as the inner loop — minutes-to-hours iterative review — and the board grew out of needing somewhere for the agents' questions to wait for me. On personal projects, where I can build things faster than I can come up with ideas to build, the board is now the tracker.
- **Not a code review tool.** Diff review covers a branch of a local checkout; pull requests still happen on GitHub.
- **Not framework-specific.** The widget is a vanilla web component; inject one `<script>` tag into any HTML page.

## Status

v0.1.0 — beta. My own fleet of agents works from it every day, which is a different claim from "works for you"; expect sharp edges.

- Comment anchors hold through ordinary editing; a large rewrite of the surrounding text can still detach a thread, and re-attaching it is manual.
- Mobile and tablet layouts are still being tuned surface by surface; iPad landscape and a phone are the targets, and not every surface fits both yet.
- Disk ↔ doc sync is bidirectional (`fs.watch` plus a debounced write-back), so a bound file is edited through the plugin's tools, never with a plain editor save that races the flush.
- Meetings need a transcription API key on the server; without one the strip says so and everything else works.

## License

[MIT](LICENSE)
