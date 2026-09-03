# Security model

Claude Workspaces runs on one person's own computer. That person is the owner. The owner's Claude Code agents talk to the server from the same machine. Anyone else reaches it only through a Cloudflare tunnel the owner set up. There is no shared service and no shared database: the security boundary is the owner's machine.

One server holds many workspaces. A share link opens exactly one workspace, fixed when the share is made, and a share that names no workspace opens nothing. The collaboration hostname is one stable address for many workspaces, so it asks a second question after Cloudflare Access confirms the email: was this email given the workspace the address names? The answer comes from the live shares of that workspace (their email and domain lists) plus the owner's own emails. A workspace nobody has shared admits nobody there.

This document describes how the server decides who gets in, what each kind of caller can read and write, and where secrets are kept. It describes the design as it is; it is not a promise that nothing was missed. Every check named below has a comment at the top of its own file explaining why it exists. Read that before changing it.

## Who can reach the server

```mermaid
flowchart LR
  visitor[Invited collaborator]
  bot[Meeting-bot service]
  world[Everyone else]
  tunnel[Cloudflare tunnel]
  agents[Owner's agents and shell]
  browser[Owner's browser]
  gate{Which caller is this?}
  routes[Boards, docs and everything else]
  secrets[(Keychain and key files)]
  refused[Refused]

  visitor --> tunnel
  bot --> tunnel
  world --> tunnel
  tunnel --> gate
  agents --> gate
  browser --> gate
  gate -->|known caller| routes
  gate -->|unknown| refused
  routes --> secrets
```

The tunnel is the only way in from outside the owner's machine. Every request, whether it came through the tunnel or from the machine itself, is sorted into one of these groups before anything else happens.

| Group                    | Who is in it                                                 | How the server knows                                         |
| ------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------ |
| Programs on this machine | The owner's agents, hooks and shell                          | The request is addressed to `localhost` **and** the connection starts on this machine. Both must be true. |
| The owner in a browser   | The owner, using their own hostname through the tunnel       | The hostname is on the owner's list, and Cloudflare Access has confirmed the owner's email |
| Invited collaborator     | Someone the owner shared a workspace with                    | A hostname made for that share, and Cloudflare Access has confirmed their email |
| Meeting-bot service      | Recall.ai, delivering transcripts                            | Its own hostname, and a signed message                       |
| Everyone else            | The rest of the internet, and any local-network or Tailscale name | Not recognized. Refused before any page or API runs.         |

There is one level of access. A signed-in person reads and writes as the email Cloudflare confirmed, and a comment they post is attributed to that email, whatever the request claims.

One function makes the sorting decision, `classifyHost` in `packages/server/src/middleware/host-guard.ts`, and every page and API sits behind it, so the answer cannot depend on which URL someone tried. Each outside group has its own list of hostnames, and a hostname on one list never counts for another. Cloudflare stamps every request it forwards with a marker of its own, and that marker alone proves a request came through the tunnel, so a tunnel visitor who claims to be `localhost` is not believed.

Two questions are kept apart: may this caller talk to the server at all, and who are they? The groups above answer the first. A sign-in cookie, a Cloudflare Access identity, or a widget token answers the second. A program on this machine skips the first question and still has to answer the second before it may change anything.

## Every browser signs in through Cloudflare Access

The rule: **programs running on this machine get in without signing in. Nobody else does.** There is no exception for the local network, for Tailscale, or for a hostname the owner wrote into a config file. Listing a name is not the same as signing in.

Two details make the rule hold. First, "on this machine" means both things at once: the request names `localhost`, and the connection itself starts on this machine. The tunnel and the local proxy both connect to the server from this machine, so the connection alone cannot tell a visitor from an agent, and the name `localhost` alone can be typed by anyone. Second, any name that happens to point at this machine, such as a Tailscale name or a local-network alias, is refused.

The only thing that reaches the server without a Cloudflare sign-in is a program on this machine calling `http://localhost:8787`. That is the same port the tunnel connects to. Agents and hooks learn that address from a small file the server writes when it starts (`~/.claude/claude-workspaces/server.json`). Everything a person opens in a browser (the board, a document, its attachments, a folder listing, a diff review, live editing, live updates) requires a confirmed identity.

Because Cloudflare confirms the person's email before the page loads, the server's own emailed-code sign-in is switched off. (`CW_EMAIL_CODE_SIGNIN=1` switches it on.) The `/signin` page and its two helper routes answer "not found". Reading your session, changing your display name, and signing out still work, and `/api/auth/session` tells the page which mode it is in, so no page shows a link to a sign-in that is not there.

If the rule is on and no Access hostname is configured, the server prints a clear warning when it starts, because then the only browser that can reach it is one on this machine.

## What each caller can read and write

| Caller                                                   | Reads                                                        | Writes                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| Program on this machine                                  | Everything                                                   | Everything                                                   |
| Owner in a browser                                       | Everything, after Cloudflare confirms an email on the owner's list | Everything, except binding a path on this machine (see below) |
| Share or collaboration visitor                           | A share: the one workspace it names. The collaboration hostname: only the workspaces whose live shares list the visitor's email | Comments, suggestions, the reading tracker, and the text of documents through live editing |
| Meeting-bot service                                      | Two routes                                                   | One incoming message                                         |
| Anyone else, including local-network and Tailscale names | Nothing                                                      | Nothing                                                      |

In code: programs on this machine pass `isTrustedLocalHost` with no sign-in; the owner's browser passes `isProxiedTrustedHost`; a visitor is held to `shareScopeAllows` and `collabScope`, which list what is allowed and refuse everything else; the meeting bot passes `middleware/recall-callback-gate.ts`; everyone else is refused by `classifyHost`.

Letting a visitor edit document text is on purpose: that is what a live review is. It happens over the live-editing connection, not over the normal API, and only for a visitor whose email Cloudflare confirmed.

`SharingGate` (`share/sharing-gate.ts`) is the master switch above all of this. Turned off, every outside hostname is refused before any sign-in check runs, and a setting that cannot be read counts as off. It covers the share, collaboration and owner-through-the-tunnel groups. The meeting-bot hostname is deliberately outside it, because switching it off in the middle of a meeting would drop the transcript; that hostname serves two routes, and each one works only while its own credential is configured.

## Changing anything from a browser needs a sign-in

`CW_REQUIRE_SIGNIN_TO_WRITE` is on by default, and only an explicit `0`, `false`, `no` or `off` turns it off. The check (`isGatedWrite` in `middleware/write-gate.ts`) looks at whether a request is asking to read or asking to change something, not at a list of routes, so a new route that changes data is covered without anyone remembering to add it. The one place that does not hold is a live connection, because opening one looks like a read: the document-editing connection and the meeting-audio connection each check the sign-in themselves when the connection opens and keep that answer for as long as the connection lasts. Anyone adding a third live connection has to do the same; nothing will catch it for them.

The exceptions to the check are reads to let through, not writes to catch, so a mistake shows up as a refused read rather than as a silent gap. The sign-in flow itself is exempt, because otherwise nobody could ever sign in.

Agents are not affected, because the check keys on markers only browsers attach to a request. That tells the server who made a change; it is not what keeps strangers out. The sorting above is what keeps strangers out.

Four routes turn a path on this machine into content the server reads and serves: binding a file, binding a folder, importing a task list, and starting a diff review. All four refuse every browser, signed in or not. The danger is a web page running on this same machine, such as a dev server on another local port: the browser would treat it as coming from the owner, and the owner's signed-in session would come with it. The deploy, plugin-refresh, agent-merge and share-management routes refuse browsers for the same reason.

## What a reviewer can open from a shared folder

Sharing a folder or a diff review exposes a whole checkout, so one rule decides what a reviewer can open (`isListedFile` in `fs-scan.ts`): the file must appear in the folder listing, and the listing is `git ls-files --cached --others --exclude-standard`. A file that git ignores never appears, and anything under `.git/` is refused before the listing is even consulted.

Ignore rules are not the whole story, because the listing includes untracked files and a checkout may never have had an ignore rule for one of them. So the listing also refuses files whose names look like credentials: `.env` and its variants, `.npmrc`, `.netrc`, `.pgpass`, `.htpasswd`, `.pypirc`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.keystore` and `id_*`.

Outside a git checkout, the server reads the directory directly. There is no ignore file to follow there, so it also hides every file whose name starts with a dot. That wider rule is deliberately not used inside a repository, where such files are committed content a reviewer has to see.

What a visitor is sent is built from a list of allowed fields, not a list of forbidden ones: `share/redact-meta.ts` rewrites review links to the visitor's own workspace and removes paths on this machine, and the record of which agents are present names exactly the fields a visitor gets. A field added later is withheld until someone decides otherwise.

## Where secrets live

Secrets are kept in the macOS Keychain or in files only the owner's account can read, and none is checked into this repository or written into the launchd configuration by design. This table says where the server looks for each one.

| Secret                                                       | Where                                                        |
| ------------------------------------------------------------ | ------------------------------------------------------------ |
| LLM API key (summaries, notes, judging)                      | Keychain, service `claude-workspaces-summary-api-key`        |
| AssemblyAI key                                               | Keychain, service `assemblyai-api-key`                       |
| Soniox key                                                   | Keychain, service `claude-workspaces-soniox-api-key`         |
| Recall.ai key                                                | Keychain, service `claude-workspaces-recall-api-key`         |
| Google OAuth client and refresh token                        | Keychain, service `claude-workspaces-google-oauth`, three accounts |
| Postmark server token                                        | Keychain, service `postmark-api-token`                       |
| Cloudflare API token                                         | Keychain, service `cloudflare-api-token`                     |
| Cookie signing key (sign-in cookie, share cookie, widget token) | `<dataDir>/share-cookie.key`, readable only by the owner's account |
| The key that signs browser notifications                     | `<dataDir>/push-vapid.json`, readable only by the owner's account |
| Meeting webhook signing secret                               | `RECALL_WEBHOOK_SECRET` in the environment                   |

The server creates the two key files itself on first use and resets their permissions if they already exist. The launchd configuration holds hostnames and feature switches only; no API key is set there.

When the emailed-code sign-in is on, login codes are never stored in the clear. They are kept scrambled with a per-code salt, in memory only, behind rate limits per code, per email and per network address. The fallback that prints a code to the console hides it unless a development flag is set.

Signed tokens (the share cookie, the sign-in cookie and the widget token) all go through one module, `auth/signed-token.ts`: each token is stamped with a signature made from the secret key, and a token whose signature does not match is rejected. Each kind of token contributes only its own purpose, its contents and its expiry, so none of them has its own copy of the signing code.

## Reporting a vulnerability

Please do not open a public issue. Report privately through GitHub's [private vulnerability reporting](https://github.com/fryanpan/claude-workspaces-plugin/security/advisories/new) on this repository. Include what you did, what you saw, and the version or commit you tested. This is a personal project with no bug bounty and no response-time promise, but reports are read and acted on.

## Changing any of this

Run the checklist in [`.claude/rules/security-review.md`](../../.claude/rules/security-review.md) before opening a pull request that adds or changes a route, a token, a share surface, a webhook, or a sign-in default. The `ship-it` skill runs it automatically when the changed files touch those areas. Independent reviews of this document against the code run from time to time, and their fixes land through normal pull requests.

## Settings, by name

Which hostnames face a browser is configuration, read once in `server-config.ts`:

| Setting                                  | What it means                                                |
| ---------------------------------------- | ------------------------------------------------------------ |
| `CW_ACCESS_ONLY_BROWSER_HOSTS`           | The rule itself. On by default; only `0`, `false`, `no` or `off` turns it off, so a typo leaves it on. |
| `CW_PROXIED_TRUSTED_HOSTS`               | The owner's own hostname(s) through the tunnel. Behind Access, they see the whole product. |
| `CW_PROXIED_TRUSTED_EMAILS`              | Which confirmed emails those hostnames admit. Defaults to `CW_OWNER_EMAIL`. |
| `CF_ACCESS_TUNNEL_HOSTS`                 | Hostnames for collaborators. They see the shared surfaces, not the owner's controls. |
| `CF_SHARE_BASE_HOSTNAME`                 | The parent domain that each workspace share gets its own hostname under. |
| `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` | The Cloudflare Access team and application that the owner and collaborator hostnames are checked against. |
| `CW_EMAIL_CODE_SIGNIN`                   | Turns the server's own emailed-code sign-in on.              |
| `CW_REQUIRE_SIGNIN_TO_WRITE`             | Whether a browser must be signed in to change anything. On by default. |
