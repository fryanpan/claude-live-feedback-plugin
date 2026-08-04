# Cloudflare external sharing — remaining work (tabled 2026-08-04)

Status: **tabled by Bryan** in favor of the live-meeting flow. Everything
below is the state as of 2026-08-04 so pickup is cheap.

## Where it stands

**Software: fully built.** `share_doc` / `list_shares` / `unshare` MCP
tools, per-share CF Access app creation (`packages/server/src/share/`),
host-gated JWT verification (`middleware/cf-access.ts`), TTL expiry.
See docs/product/sharing.md for the design + runbook.

**Infra: partially stood up (2026-08-04):**
- ✅ Tunnel `live-feedback` ingress fixed (`localhost:9900` → `:8787`).
- ✅ launchd service `live-feedback.cloudflared`
  (`~/Library/LaunchAgents/live-feedback.cloudflared.plist`, mirrors the
  notion/sentry bridge pattern) — running, edge connections registered.
- ✅ Wildcard DNS `*.tunnel.fryanpan.com` resolves to Cloudflare.

## Blockers

1. **TLS decision (Bryan).** Universal SSL covers only one subdomain
   level, so `share-<slug>.tunnel.fryanpan.com` fails TLS handshake at
   the edge (confirmed by probe — this is why the working bridges are
   single-level, e.g. `notion-bridge.fryanpan.com`). Options:
   - Advanced Certificate Manager (~$10/mo) for `*.tunnel.fryanpan.com`
     — zero code changes.
   - Switch to single-level `share-<slug>.fryanpan.com` + extend the
     share code to create/delete a real DNS record per share (hostname
     exists only while the share lives — better security posture; token
     then also needs Zone-DNS-edit; moderate code change).
2. **Credentials (Bryan, per sharing.md one-time setup):**
   - Zero Trust team domain chosen/enabled (permanent).
   - Scoped API token → Keychain as `cloudflare-api-token`.
   - `CF_ACCESS_TEAM_DOMAIN` / `CF_ACCOUNT_ID` / `CF_SHARE_BASE_HOSTNAME`
     env into the server launchd plist (agent can wire once values known).

## First shares when resumed

ADFA → allow-domain `@appdevforall.org`. Greenlue → domain TBD.
