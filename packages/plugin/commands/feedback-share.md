---
description: Publish a review surface behind Cloudflare Access for an external team. Markdown doc only in the current build; dev-server / mockup support coming next.
---

You're being asked to share a live-feedback review surface publicly so an
external team can review it for a bounded window (default 72 hours).

## What this does

Wraps an existing review surface (a markdown doc bound via `create_review_doc`,
in the current build) in a Cloudflare Access-gated public URL. Reviewers
hit the URL → email-OTP login → only allowed email domains can complete
login → arrive at the review surface.

## Steps

1. **Resolve the allow-list.** Read `.claude/live-feedback.json` from the
   current repo. Look for `share.defaultAllowDomains`. If present, use that
   value. If absent, **ask the user which domain(s) to allow**. Never default
   to "anyone."

2. **Verify the doc exists.** The doc must already be bound via
   `create_review_doc`. If it isn't, do that first.

3. **Call `share_doc`** with `{ docId, allowDomains, ttlSeconds? }`. Default
   ttl is 72h; override only if the user requests a different window.

4. **Share the resulting URL** with the user along with a brief instruction
   the user can forward to reviewers:

   > "Click the link, enter your @<domain> email, you'll get a 6-digit code
   > by email, then you'll land on the review page. Comments save automatically."

5. **Watch the doc** via `watch_doc(docId)` if you aren't already, so external
   comments arrive on the same channel as internal ones.

## Lifecycle

- Shares expire on their own at the configured TTL — no Ctrl+C / process
  babysitting required. The cloudflared tunnel runs as a launchd service.
- Use `unshare(shareId)` for early teardown if the review wraps up faster.
- `list_shares()` audits what's currently live.

## Limitations (current build)

- Only `share_doc` (markdown) is implemented in this commit. `share_site`
  (dev server) and `share_mockup` (static HTML) are scoped for the next pass.
- One Cloudflare Access app per share — share creation is a real API call
  with ~1-2s latency. Don't loop-create shares.

## Prerequisites already in place (you should not need to do these)

- Cloudflare Access enabled on the account; team subdomain set
- API token in macOS Keychain at service `cloudflare-api-token`
- `cloudflared` installed as a launchd service routing the wildcard
  `*.tunnel.fryanpan.com` ingress to the live-feedback server
- Server started with `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCOUNT_ID`, and
  `CF_SHARE_BASE_HOSTNAME` env vars set (see `docs/product/sharing.md`)

If a prerequisite is missing, the `share_doc` MCP call returns a specific
error message — surface it to the user with the install hint and let them
follow up.
