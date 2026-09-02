# Per-release security review

Run this **before opening any PR** whose diff adds or changes a route, a
token or signing scheme, a share surface, a webhook, or an auth default. The
`ship-it` skill decides that automatically from the changed-file list; run it
by hand when you skip ship-it.

**Who reads the result:** the merging lead. Put the checklist in the PR body
with a one-line answer under each heading — the answer, not a tick. "N/A" is
valid and must say why. An unanswered heading blocks the merge. The
boundaries are mapped in
[docs/architecture/security.md](../../docs/architecture/security.md).

## The checklist

### 1. New routes gated
Name the gate each new or moved route sits behind: trusted-local, loopback
only, `shareScopeAllows`, `collabScope`, or the Recall callback allowlist. A
route that needs no gate has to say why reading it is free.

### 2. New inputs validated
Every new body field, path segment and query parameter: what rejects a
hostile value? Name the check. Host paths, ids and file paths are the ones
that have bitten this repo.

### 3. No secrets in any artifact
No key, token, password or partial value in the diff, the tests, the
fixtures, the commit messages or the PR body. New secret files are mode 600
and gitignored. The pre-push leak gate ran and passed.

### 4. Share scope unchanged
Did the diff widen what a share or collab visitor may reach? If a path was
added to an allowlist, say which one and why that is intended. Adding a
route under an already-allowed prefix counts as widening.

### 5. Tokens through one signing module
New signed values use an existing scheme — the share link-session cookie,
the auth session cookie, or the widget popup token — with a domain-separated
key. A fourth scheme needs a reason in the PR body, not just a diff.

### 6. Webhook replay protection intact
The signature check still runs before the replay guard, the tolerance window
is unchanged, and every delivery id still passes through the guard.

### 7. Deploy and refresh still loopback-only
`POST /api/deploy` still requires a loopback peer address and still refuses a
request carrying `cf-ray`. `POST /api/plugin/refresh` still refuses `cf-ray`.
Both still refuse share visitors.

## Copy this into the PR body

```markdown
## Security review
1. Routes gated:
2. Inputs validated:
3. Secrets:
4. Share scope:
5. Token schemes:
6. Webhook replay:
7. Deploy/refresh:
```
