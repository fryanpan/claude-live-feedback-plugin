# Claude Live Feedback Plugin

A Claude Code plugin that lets people and a Claude Code instance securely co-edit a Markdown document, mockup, or live dev server **on the same surface, in real time** — point at a line, leave a comment, watch the agent's edit land within seconds.

## Goal: Faster Remote Iteration with Claude

Giving feedback to vanilla Claude Code is slow, especially on a development server or live mockup — it takes work to explain what elements you're looking at, and then you need to translate that to a prompt.

This plugin is inspired by Claude Design, Nimbalyst, Antigravity and other tools that have a more integrated workflow; however, instead of a bulky heavy-weight tool, this is a lightweight plugin that you can spin up in any Claude Code session.

The plugin lets you work interactively with Claude on each of the following:

- **Markdown docs** to plan with or give context to Claude. You can also edit the doc in real-time at the same time as Claude.
- **Interactive mockups** for UX design iteration while planning with Claude.
- **Development servers** for testing and improving features with Claude.

You point at an element and tell Claude what to change, and a minute later, Claude updates what you're looking at.

If you've used [Claude Design](https://claude.ai/design), there's some overlap; however, this plugin is mainly meant to:

- **Integrate directly into your code repo.** No translation needed from Claude Design on the design. The requests you make get implemented directly in code, not just in the mockup.
- **Work on artifacts throughout the plan/design, implement, and test cycle.**

Note that this plugin does **not** work with code yet, but could be extended to do so. On my personal projects, I've stopped writing code and review code in larger batches after multiple features land in an IDE. So I do not need to do this regularly any more.

## Installation

1. Clone this plugin to a local folder:

   ```sh
   git clone https://github.com/fryanpan/claude-live-feedback-plugin.git
   cd claude-live-feedback-plugin
   bun install
   ```

2. Enable channel events for live-feedback. Add this one-line alias to your shell init file (e.g., `~/.zshrc`):

   ```sh
   claude() { /path/to/claude --dangerously-load-development-channels plugin:live-feedback@claude-live-feedback "$@"; }
   ```

   Reload your shell (`source ~/.zshrc`) and relaunch Claude Code.

3. Install the plugin at the user level. From the cloned plugin directory:

   ```sh
   cd packages/mcp && npm link && cd ../..
   claude plugin marketplace add .
   claude plugin install live-feedback@claude-live-feedback --scope user
   ```

   The `npm link` step registers the `live-feedback-mcp` binary on your PATH so Claude Code can resolve it. The two `claude` commands register this repo as a local plugin marketplace and install the plugin user-wide.

4. Use the plugin by asking Claude like this:
   - "Show me the doc &lt;your doc name&gt; with live feedback"
   - "Show me a mockup with live feedback"
   - "Show me the dev server with live feedback"

## Run as a service (macOS)

By default `bun run scripts/serve.ts` runs in the foreground — convenient for development, but the server dies when the terminal closes. To keep it always-on (survives logout, Mac reboot, and crashes), install the launchd supervisor:

```sh
./scripts/launchd/install.sh
```

The script writes `~/Library/LaunchAgents/com.fryanpan.live-feedback.plist`, bootstraps it into your user session, and waits for port 8788 to come up. Logs land at `~/Library/Logs/com.fryanpan.live-feedback.{out,err}.log`. The service runs as a per-user `LaunchAgent` — it starts at login (not boot) and stops at logout, which matches Bryan's Mac-mini-always-logged-in setup.

Re-run `install.sh` after pulling code that changes the launch args (it's idempotent — boots out the old plist first).

To uninstall:

```sh
./scripts/launchd/uninstall.sh
```

Useful commands once installed:

```sh
launchctl list | grep com.fryanpan.live-feedback   # status
launchctl kickstart -k gui/$(id -u)/com.fryanpan.live-feedback   # force restart
tail -f ~/Library/Logs/com.fryanpan.live-feedback.err.log         # follow logs
```

## What It Does Under The Hood

- **Uses [Claude Channels](https://code.claude.com/docs/en/channels) for messaging.** Comments arrive at the agent's session as `<channel source="live-feedback" ...>` events the same way GitHub mentions and CI failures do — no polling, no MCP tool round-trips just to check inbox. The agent typically posts a reply or lands an edit within a few seconds of you clicking "send."
- **Surface-anchored, not chat-anchored.** Every comment carries a CRDT anchor to the exact text range or DOM element you're discussing. When the agent edits, we try to keep anchors stable and attached. This could use some more work.
- **Primitives, not bespoke flows.** The MCP surface is small and composable: `get_doc`, `find_and_replace`, `create_anchor`, `edit_at_anchor`, `rewrite_thread_region`, `post_reply`. Agents stitch them however the workflow needs.

## What it's not

- **Not a hosted SaaS.** The server runs on your machine, on your network. Reviewers reach you over Tailscale or LAN. No public tunnel by default.
- **Not a replacement for issue trackers.** This is for the inner loop — minutes-to-hours iterative review, not days-to-weeks ticket lifecycles. However, at least on personal projects, where the speed I can build things is faster than I can come up with ideas to build, I have mostly stopped using issue trackers.
- **Not framework-specific.** The widget is a vanilla web component (Shadow DOM); inject one `<script>` tag into any HTML page.

## Status

v0.0.1 — alpha. Working well enough to be barely useful.

- Inline marks (bold / italic / link / strike) round-trip cleanly; cross-block `rewrite_thread_region` falls back to `find_and_replace`.
- Disk ↔ doc sync is bidirectional via `fs.watch` + debounced 800ms write-back, with a `lastWritten` cache to break echo loops.

## License

[MIT](LICENSE)
