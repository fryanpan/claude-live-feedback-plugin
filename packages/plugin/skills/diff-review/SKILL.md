---
name: diff-review
description: Use when the reviewer asks to "review a diff", review a branch or PR-style change, or compare two commits of a local repo through claude-workspaces. Covers creating the diff review, sharing the URL, watching line comments, and cleaning up.
---

# Reviewing a git diff through claude-workspaces

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

**Group the files for the reviewer — always pass `groups`.** The sidebar's
default view shows the changed files in logical groups, and YOU know your
change's intent far better than the service's heuristic. Organize by INTENT —
the same judgment you'd use splitting a branch into reviewable commits:

```
groups: [
  { title: "Routing refactor", paths: ["src/router.ts", "src/routes/map.ts"] },
  { title: "Dark mode",        paths: ["src/theme.ts", "src/styles/dark.css"] },
  { title: "Tests",            paths: ["src/router.test.ts"] },
]
```

Order matters (first group = read first). A path entry may be a DIRECTORY —
`"maps/src/test"` claims every changed file under it, so you don't have to
enumerate them. Unlisted changed files land in an automatic "Other" group.
If you omit `groups`, a heuristic groups by module/tests/docs/config —
acceptable, but your semantic grouping is better. Re-binding without
`groups` preserves whatever grouping the review already has.

**Pinned mode** — pass `target: "<ref>"` to freeze the review at a commit
(reviewing merged/finished work). Anchors can never drift there; the same
`reviewId` with a different range is rejected.

**Browse mode** — omit `base` entirely to bind a folder with NO diff: the
reviewer navigates everything from the all-files sidebar, files open lazily
(markdown editable, source read-only). Works on plain folders and fresh
repos with no commits; `bind_folder` is an alias for this.

Then hand the human the returned `entryUrl`. Format it for wherever you are
putting it: an inline relative link when it goes on a task or a thread, bare
on its own line when terminal chat is the only surface you have. The rule is
written out once, under "Use Links Effectively" in
`claude-workspaces:working-in-a-workspace`. The file tree inside the page
navigates to every other changed file.

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
  in the repo, not through claude-workspaces edit tools (those are for markdown
  docs).
- If the reviewer wants to comment on a **deleted** line: not supported yet —
  ask them to comment on an adjacent kept line instead.

## Retiring a finished review

A diff review is content in the workspace it was filed on. When the pass is
over — the change merged — retire it yourself rather than leaving it to
present its unresolved threads forever: `archive_review(setId, reason)`, with
the id `create_diff_review` returned and a reason like `"merged in #301"`.

Archiving takes the review off the home page and off its board row and stops
its rooms syncing, and it **destroys nothing**: the docs stay on disk, every
comment still feeds the activity analyses, and `unarchive_review(setId)` puts
the whole thing back — threads, board links and all. Open threads do not block
it; that is the point. `list_archived_reviews` shows what can come back.

`delete_review(setId)` archives too (that is now what it means) but applies the
old open-threads guardrail, so it refuses unless `force:true`. Only
`purge:true` destroys anything, and reach for it essentially never — a purged
doc cannot be restored and silently shortens the history the weekly analyses
read.

## When NOT to use this

- The change is already on GitHub and a normal PR review is happening there —
  don't duplicate the surface unless the human asks.
- Reviewing a single standalone document — use `create_review_doc`.
  (Folder browsing is no longer separate: omit `base` here instead of
  reaching for `bind_folder`.)
