---
alwaysApply: true
---

# Claude Workspaces as the Default Review Surface

When you want Bryan to review a markdown doc OR a dev server / interactive preview, **bind it to the claude-workspaces widget by default** rather than just sending him a file path or a URL. The plugin is stable and is the fleet-wide standard.

## When this applies

- Drafting any markdown for Bryan's voice / structure / content pass (blog posts, plans, audits, retros, design docs, decision docs)
- Sharing a dev server URL or HTML mockup for UX feedback
- Surfacing any document where you want comment-level input, not just a thumbs up
- Bryan asking to review a git diff / branch / two commits of a local checkout — use `create_diff_review` (see the `claude-workspaces:diff-review` skill)

## When to skip

- One-or-two-line acks where there's no review surface
- Code review already happening on a GitHub PR — don't duplicate the surface unless Bryan asks for a claude-workspaces review pass
- Your own logs / private notes (no Bryan input expected)

## Finding the tools

The claude-workspaces tools are **deferred** — they do NOT appear in your direct function list, and searching the single-segment name `mcp__plugin_claude-workspaces__*` finds nothing. The real prefix has a **doubled segment** (plugin name, then MCP-server name): `mcp__plugin_claude-workspaces_claude-workspaces__<tool>`. Load them with:

```
ToolSearch → select:mcp__plugin_claude-workspaces_claude-workspaces__create_review_doc,mcp__plugin_claude-workspaces_claude-workspaces__watch_doc,mcp__plugin_claude-workspaces_claude-workspaces__resolve_thread
```

If that returns nothing, THEN the plugin isn't enabled for your session — but check the doubled-prefix name first. "The tools aren't in my list" is expected for deferred tools, not a broken MCP.

## Present the work in the workspace, not in chat

The workspace is the **primary work surface** (Bryan, 2026-08-18: *"Chat is so weird and out of context — I'd like you to start showing me review items tied to tasks or doc comments or wherever they are in context, instead of making me figure it out from a funny chat screen."*). When the thing you built answers a task or a comment, the URL goes there:

- Reply on the thread that asked for it (`post_reply`), or open a subject thread on the task (`create_thread(docId="task:<taskId>", …)`) when nothing asked yet.
- Pass the `review` payload on `create_thread` / `post_reply` when you're asking Bryan to look or decide — that's what makes it a Review Item on his Home queue rather than a comment he has to notice.
- Chat gets at most a one-line pointer. Bare URLs on their own line, never markdown-wrapped.

The full rule ships fleet-wide in the `claude-workspaces:working-in-a-workspace` skill ("The workspace is where you share status and ask for human help").

## How

**Markdown docs** — bind via `mcp__plugin_claude-workspaces_claude-workspaces__create_review_doc(docId, path, title?)`. Post the review URL (`http://mac-mini.<private-network>:8787/review/<docId>`) on the task or thread the doc belongs to (see above); a chat message carries at most a pointer.

**Dev servers / HTML mockups** — use the `claude-workspaces:embedding-widget` skill (it covers the `<script>` tags + `setContext` calls).

**Git diffs** — `create_diff_review(repo, base)` → share the returned `entryUrl` (bare URL on its own line). Default diffs base against the LIVE working tree: keep editing and Bryan's view re-renders in ~1s, his comments riding along (orphaning into the outdated-comments flow if their line disappears). Pass `target` only to pin a finished range. One doc per changed file; comments arrive per file via the auto-watch; `archive_review(reviewId, reason)` when done — it retires the review without destroying it, and `unarchive_review` brings it back.

**Apply Bryan's comments via the claude-workspaces edit tools** — once a doc is bound, NEVER edit the .md file directly with Write/Edit. Use `find_and_replace`, `rewrite_thread_region`, `insert_blocks_after_thread`, etc. The plugin serializes the live doc back to disk ~1s after every change; direct filesystem edits get silently clobbered by the next flush. See the `claude-workspaces:editing-review-docs` skill for the full pattern.

**Watch for comments** via `watch_doc(docId)` — comment events arrive as `<channel source="claude-workspaces" doc_id="..." thread_id="..." event="...">` blocks. (Sessions still running a pre-rename bundle emit `source="live-feedback"`; the attribute changes when that session restarts, not when this rule does.) Resolve threads when you've addressed the feedback (`resolve_thread`).
