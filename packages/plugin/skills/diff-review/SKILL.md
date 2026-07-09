---
name: diff-review
description: Use when the reviewer asks to "review a diff", review a branch or PR-style change, or compare two commits of a local repo through live-feedback. Covers creating the diff review, sharing the URL, watching line comments, and cleaning up.
---

# Reviewing a git diff through live-feedback

When the human wants to review a code change — "review this diff", "let me
review the branch", a PR-style pass over `base..target` — use
`create_diff_review` instead of pasting a diff into chat or pointing them at
raw files. They get a GitHub-PR-style surface: files in a tree, unified diff
with old/new line numbers, collapsed unchanged regions, and live line-anchored
comment threads that reach you as channel events.

## Create the review

```
create_diff_review(
  repo: "/abs/path/to/local/checkout-or-worktree",
  base: "<ref of the BEFORE side>",   // hash, branch, HEAD~3 …
)
```

**Default = live working-tree mode.** The diff is base → the folder as it is
NOW — uncommitted edits and untracked files included. Every file doc binds to
the live file on disk, so this is the live loop: you keep editing the code
with your normal tools, and the reviewer's diff re-renders within ~1 second.
Their comments stay anchored to their lines through your edits; when an
anchored line disappears, the thread drops into the existing Orphaned /
outdated-comments section where the reviewer (or you, via the reanchor route)
can re-attach it.

- One review doc per changed file, grouped as a workspace (`reviewId`).
- Re-running the tool is idempotent (same docIds, threads survive) and
  **refreshes the file list and badges** — do it after you change a file that
  wasn't part of the diff before, so it appears in the tree.
- Per-file **Diff ↔ File** toggle shows the whole file as it is on disk, also
  commentable.

**Pinned mode** — pass `target: "<ref>"` to freeze the review at a commit
(reviewing merged/finished work). Anchors can never drift there; the same
`reviewId` with a different range is rejected.

Then hand the human the returned `entryUrl`, as a bare URL on its own line
(no markdown around it). The file tree inside the page navigates to every
other changed file.

## Big or noisy diffs

- Binary files and files >512 KB are skipped automatically (see `skipped[]`).
- Vendored/generated directories drown reviewers: pass
  `exclude: ["path/prefix/to/vendored-dir"]` so they never become docs.
- More than `maxFiles` (default 300) changed files → `too-many-files`; use
  `exclude` to narrow, or raise `maxFiles` deliberately.

## During the review

- You're auto-subscribed to every file doc: comments arrive as
  `<channel source="live-feedback" doc_id="..." thread_id="...">` events.
  The `doc_id` tells you which file (`<reviewId>:<relPath with / as ~>`).
- Prefer one poll over N: `GET /api/workspaces/<reviewId>/threads?status=open`
  returns every open thread across the whole review, each tagged with its
  `docId` + `relPath` — use it to survey a big review instead of hitting
  every file's thread route.
- Treat each comment as an explicit ask. Reply with `post_reply`, and
  `resolve_thread` once you've addressed it — in working-tree mode the fix
  itself shows up in the reviewer's diff as soon as you save, so resolve with
  a short "done, see line N" reply.
- The diff surface is **read-only** — you change code with your normal tools
  in the repo, not through live-feedback edit tools (those are for markdown
  docs).
- If the reviewer wants to comment on a **deleted** line: not supported yet —
  ask them to comment on an adjacent kept line instead.

## Cleanup

A diff review is a workspace. When the pass is over (threads resolved, change
merged), call `delete_workspace(reviewId)`. It refuses while open threads
remain unless `force:true`.

## When NOT to use this

- The change is already on GitHub and a normal PR review is happening there —
  don't duplicate the surface unless the human asks.
- Reviewing a document or a folder of files at HEAD — use `create_review_doc`
  or `bind_folder`.
