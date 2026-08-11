# Collaborative work surfaces — what the landscape says about LF, and how to unblock sharing

**Distilled 2026-08-11** from the Research Notes agent's landscape study
(topic note `agent-native-work-surfaces-2026`, kept in its own private notes
repo — that doc holds the full lineage, ~40 sourced links, and per-claim
caveats; this one holds only what changes decisions in THIS repo).

## The five learnings worth internalizing

### 1. LF's bet has a name, a canon, and independent validation

The idea LF is built on — durable documents as the shared ground between
humans and agents, rather than chat — is the "thread B" of a field Ink &
Switch calls [malleable software](https://www.inkandswitch.com/essay/malleable-software/).
The strongest research artifact in that thread,
[Patchwork](https://www.inkandswitch.com/patchwork/notebook/2024-version-control/07/)
/ [GAIOS](https://www.inkandswitch.com/newsletter/dispatch-014/), reaches the
same architecture LF did: CRDT documents as the substrate, agents as
versioned co-editors, human review through the document's own grammar.

The sharpest lens from the study is the **inversion test**: in every big-lab
product, chat is primary and the artifact hangs off it. The inversion — the
artifact is primary and the agent integrates into *it* — exists only where
someone owns the substrate: Notion, tldraw, Patchwork, **and LF**. That is
the defensible position, and it is also why renting the substrate (Notion)
was rightly rejected.

### 2. Don't build what vendors are absorbing

The standalone agent-supervision category consolidated to death in ~18
months (Vibe Kanban sunset, Crystal deprecated, Omnara pivoted), while
vendors rebuilt live diffs, status boards, and PR review natively. Rule for
this repo: **generic** surfaces (code diff pipelines, session monitors) are
absorption bait; **project-specific surfaces on a substrate we own** are the
durable layer. LF's diff review survives this test because it reviews the
*live working tree with comment threads an agent watches* — a shape tied to
our loop, not a generic PR viewer.

### 3. The two underserved surfaces are both LF-shaped

Nobody ships (a) a cross-agent **attention queue** — "top 3 things needing
me, with a jump to the artifact" — or (b) **plan-together docs** — human
types in an empty doc, agent expands, the plan stays live through
execution. Both are thin conventions over existing LF plumbing
(`watch_doc`, bidirectional sync, threads). When we next add a surface,
these two are the priority order — not more code-review machinery.

### 4. Three patterns to steal, all cheap here

- **Agents join through the existing collaboration grammar** (Google Docs'
  Gemini acts via comments + suggested edits, never a freeform cursor).
  LF's threads/suggestions are already this — treat it as load-bearing
  design, not coincidence.
- **Agent proposals land as reviewable branches** (Patchwork). LF's
  suggest-mode is the lightweight version; if suggestions ever grow, grow
  them toward "branch you merge," not toward silent auto-apply.
- **Persistent live pages beat ephemeral generated UI** (Anthropic's Live
  Artifacts; Google's own eval found per-prompt generated UI loses once
  you count latency). An LF doc an agent rewrites on a cadence is our
  version — the daily-brief and run-status surfaces should be exactly this.

### 5. Watch, don't adopt: MCP Apps and the Yjs-peer pattern

[MCP Apps](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/)
(sandboxed interactive tool results; both big labs implement it) is the
standardized cousin of LF's embedding widget — a future LF surface could
*host* MCP Apps rather than compete with them.
[Electric's agents-as-CRDT-peers](https://electric.ax/blog/2026/04/08/ai-agents-as-crdt-peers-with-yjs)
is the cleanest published blueprint for agent presence in a live doc
(cursor, token-by-token streaming into the doc via a `start_streaming_edit`
tool) — architecturally what LF's follow-lite plan becomes if it ever wants
a visible agent cursor.

## The sharing gap — analysis and the way out

### Where we actually are

Two share modes are **built and hardened** (five security PRs merged
2026-07→08; the 2026-08-04 authorization gaps fixed in PR #87; master
kill-switch in #99):

- **Link mode** (`share_link`): unguessable capability URL → signed
  cookie; TTL enforced per-request; scope locked to one doc or workspace.
  Needs only a single public hostname (`CF_SHARE_PUBLIC_HOSTNAME`).
- **Access mode** (`share_doc` / `share_workspace`): per-share hostname
  behind Cloudflare Access email OTP. Blocked since 2026-08-04 on the
  wildcard-TLS decision (Universal SSL can't do two-level subdomains) plus
  team-domain/account/API-token setup.

The reason we can't share today is **not missing software — it's that the
blocked mode (Access) was treated as the prerequisite while the unblocked
mode (link) sat finished.** A single-level hostname (`lf-share.<domain>`)
sidesteps the TLS blocker entirely: Universal SSL covers it, the tunnel is
already running, and link mode needs no Cloudflare account features at all.

### What the landscape adds to the security picture

The three security-relevant patterns in the study all point the same
direction: **share the document, never the machine.**
[A2UI](https://a2ui.org/) sends no executable code across the trust
boundary; MCP Apps confines UI to sandboxed iframes; Patchwork/GAIOS make
the *document* the interop surface between mutually-untrusting teams. Our
own learnings file already converged on the same invariant from the other
side ("anything in the Yjs doc is readable by every peer" — so private
fields must live outside the doc).

Today's sharing model puts the whole LF server — a process whose local
trust model is "loopback can read any file the user can read" — on a
public hostname, and defends it with a host-guard, share-scoping, and a
sharing gate. That defense is real (it's where the five security PRs
went), but the *class* of bug is structural: every one of those PRs was a
consequence of one process serving both trust worlds.

The structural fix, when sharing becomes routine: an **outbound-only
relay** — a small cloud process (the Durable-Objects / y-sweet /
Liveblocks shape) that holds only the review-app bundle, the synced ydocs
of explicitly shared docs, and the comment routes. The Mac connects out
and mirrors selected docs; nothing inbound ever reaches it; the visitor
surface physically cannot serve a file, a diff, or a tailnet name it was
never given. That is Patchwork's topology with LF's doc model, and it
would retire the exposed-server bug class outright rather than patching
instances of it.

### Recommendation — in this order

| Step | What | Effort | Gets us |
|---|---|---|---|
| **1. This week: turn link mode on** | One single-level DNS record → tunnel, one ingress line, `CF_SHARE_PUBLIC_HOSTNAME` in the launchd plist, restart | ~1 hr agent + ~15 min operator (DNS) | Shareable review URLs for any doc/diff/workspace, TTL'd, revocable, master-switched — the "can't share" problem ends |
| **2. When identity matters: finish Access mode** | Decide per-share DNS records (recommended over $10/mo ACM — hostname exists only while the share lives) + team domain + scoped token | ~½ day agent + operator credential steps | Email-verified reviewers, per-person revocation, attribution |
| **3. When sharing is routine: relay split** | Design doc first — outbound-only sync relay owning only shared ydocs + app bundle | ~1 wk build | Retires the exposed-server bug class; scales past one Mac |

Step 1 is deliberately boring: it ships within the week using code that is
already reviewed, tested, and gated. Steps 2–3 are ordered by when their
threat actually arrives — identity when a link leaking would matter,
topology when external review stops being occasional.

**Link-mode caveat to keep in view:** the URL is the credential. Fine for
bounded review windows with people you're already emailing; wrong for
anything where forwarding the link would be a problem — that's step 2's
job, and the `share_link` tool description already says so.
