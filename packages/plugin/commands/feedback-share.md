---
description: Publish a board behind Cloudflare Access for an external team. A board is the unit of sharing; dev-server / mockup surfaces coming next.
---

You're being asked to share a claude-workspaces review surface publicly so an
external team can review it for a bounded window (default 72 hours).

## What this does

Wraps a **board** in a Cloudflare Access-gated public URL. Reviewers hit the
URL → email-OTP login → only allowed email domains can complete login →
arrive at the board, and navigate to everything filed on it.

**A board is the unit of sharing** (Bryan, 2026-08-17: "Workspace only — a
review must be filed on a board before it can be shared"). Two smaller grants
used to exist and both are gone:

- **Per-doc** — `share_doc` is gone and `share_link` no longer takes a
  `docId`. A doc with a `docId` in the body gets `410 per_doc_sharing_removed`.
- **Per-grouping** — a folder bind or diff review cannot be shared on its
  own. Passing a grouping / review id gets `410 grouping_sharing_removed`.

So the id you share is always a hub board id: the one `create_workspace`
returned, or the `hubWorkspaceId` that `bind_folder` / `create_diff_review`
reports. Everything on that board is available to everyone the share reaches
— that is the default and the point (see `.claude/rules/workspace-board.md`)
— so decide what belongs on the board before you share it, not afterwards.

## Steps

1. **Resolve the allow-list.** Read `.claude/live-feedback.json` from the
   current repo. Look for `share.defaultAllowDomains`. If present, use that
   value. If absent, **ask the user which domain(s) to allow**. Never default
   to "anyone."

2. **Find or create the BOARD.** If the thing to review is a loose doc bound
   via `create_review_doc`, file it on a board with `attach_doc`. A folder
   bind or diff review is already filed on one — `bind_folder` and
   `create_diff_review` return it as `hubWorkspaceId`. `list_docs` shows
   which workspace a doc already belongs to.

3. **Check what else is on that board before you share it — the share is
   board-wide.** The visitor gets every doc filed on it, each grouping's file
   tree, and the navigation endpoints. Two consequences worth pausing on:

   - For a DIFF review the grouping's root is the whole repo, so `files` /
     `context-file` reach every file in that repo.
   - A bind or review created without an explicit `hubWorkspaceId` lands on
     the default **"Unfiled"** board, which collects everything anyone bound
     without naming a board. Sharing Unfiled shares all of it.

   When the reviewer should see this review and nothing else, give it its own
   board: `create_workspace` takes about a second, and `create_diff_review`
   accepts the new board's id as `hubWorkspaceId` in the same call.

4. **Call `share_workspace`** with `{ workspaceId, allowDomains, ttlSeconds? }`,
   where `workspaceId` is the BOARD id. Default ttl is 72h; override only if
   the user requests a different window. For a link share with no sign-in,
   call `share_link({ workspaceId })` instead — the slug IS the credential,
   so keep the TTL short. Either call answers `410 grouping_sharing_removed`
   if you hand it a review id by mistake.

5. **Share the resulting URL** with the user along with a brief instruction
   the user can forward to reviewers:

   > "Click the link, enter your @<domain> email, you'll get a 6-digit code
   > by email, then you'll land on the review page. Comments save automatically."

6. **Watch the docs** via `watch_doc(docId)` if you aren't already, so external
   comments arrive on the same channel as internal ones.

## Lifecycle

- Shares expire on their own at the configured TTL — no Ctrl+C / process
  babysitting required. The cloudflared tunnel runs as a launchd service.
- Use `unshare(shareId)` for early teardown if the review wraps up faster.
- `list_shares()` audits what's currently live.
- `set_sharing_enabled(false)` is the master switch: it refuses every share
  host at once and hangs up open websockets and SSE streams.

## Limitations (current build)

- Markdown / code / diff surfaces only. `share_site` (dev server) and
  `share_mockup` (static HTML) are scoped for a later pass.
- One Cloudflare Access app per share — share creation is a real API call
  with ~1-2s latency. Don't loop-create shares.

## Prerequisites already in place (you should not need to do these)

- Cloudflare Access enabled on the account; team subdomain set
- API token in macOS Keychain at service `cloudflare-api-token`
- `cloudflared` installed as a launchd service routing the share wildcard
  ingress to the claude-workspaces server
- Server started with `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCOUNT_ID`, and
  `CF_SHARE_BASE_HOSTNAME` env vars set (see `docs/product/sharing.md`).
  Link mode needs only `CF_SHARE_PUBLIC_HOSTNAME`.

If a prerequisite is missing, the `share_workspace` MCP call returns a
specific error message — surface it to the user with the install hint and let
them follow up.
