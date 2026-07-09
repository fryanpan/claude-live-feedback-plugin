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
  repo:   "/abs/path/to/local/checkout-or-worktree",
  base:   "<ref of the BEFORE side>",   // hash, branch, HEAD~3 …
  target: "<ref of the AFTER side>",
)
```

- One review doc per changed file, grouped as a workspace (`reviewId`).
- Content is pinned to the **target hash** — comments can never drift, and the
  per-file **Diff ↔ File** toggle shows the whole file at that hash, also
  commentable.
- Re-running with the same range is idempotent; threads survive. The same
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
- Treat each comment as an explicit ask. Reply with `post_reply`, and
  `resolve_thread` once you've addressed it (e.g. pushed a fix commit).
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
