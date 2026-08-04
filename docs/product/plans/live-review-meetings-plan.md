# Live review meetings — design & plan (2026-08-04)

Make synchronous, multi-person doc-review meetings genuinely productive:
fast Q&A grounded in the repo, task capture that hands off to Claude,
background research landing mid-meeting, cross-doc navigation, and
following a collaborator. First real use: **Ziv @ Greenlue, today/early
tomorrow.** Motivating session: Bryan + Hal reviewing the ADFA Quick
Build docs (worked example in the appendix).

## Design principles

- **Simplest design that works.** The live Q&A plumbing already exists
  (anchored comments → `watch_doc` channel events → `post_reply`); the
  meeting problem is mostly *protocol*, not infrastructure.
- **The watcher is the project peer session** that owns the repo the docs
  live in — it has the most context. It commits to no other work while
  the meeting runs.
- **Main loop stays free; subagents do anything slow.** The watcher's
  main loop must always be ready to answer the next question.

## Priorities (agreed with Bryan 2026-08-04)

| Pri | What | Type | Status |
|-----|------|------|--------|
| P0 | Meeting protocol skill + notes-doc pattern | Behavioral | building today |
| P0 | Public URL for Ziv (Cloudflare share) | Infra + Bryan steps | blocked on TLS decision + credentials |
| P1 | Cross-doc relative links | Code (small) | building today |
| P2 | Follow-lite presence | Code (moderate) | if time before meeting |
| Defer | Per-artifact chat pane | Code (large) | revisit after first real meeting |

## P0 — Meeting protocol (ships as plugin skill `live-review-meeting`)

### Pre-meeting checklist (watcher session)

1. Bind the docs: `bind_folder` over the folder holding the main doc +
   secondary research docs (gives the all-files sidebar), or
   `create_review_doc` per doc with a shared `setId` for a hand-picked
   bundle.
2. Create one extra bound doc: **`meeting-notes.md`** with sections
   `## Agenda`, `## Tasks`, `## Requests`, `## Doc durability` (list
   which docs are durable — see rule below).
3. `watch_doc` every doc including the notes doc.
4. **Prime**: read every bound doc end-to-end plus the key source files
   they describe, BEFORE the meeting. Answer speed comes from priming.
5. Verify participant identities resolve (name prompt / `?as=`).

### During the meeting

- **Response SLA: first reply within ~1 minute** of any comment event —
  either the answer (if primed context covers it) or an explicit ack
  ("digging into the relink path, back in ~5") so the humans keep
  talking instead of waiting.
- **Never block the main loop.** Anything needing more than ~2 minutes
  of work — code research, multi-doc reads, drafting a section — forks
  to a background subagent (Agent tool). The main loop keeps triaging
  new comments and integrates subagent results as follow-up replies or
  new doc sections when they land.
- **Comment grammar** (any doc):
  - Bare question → answer in-thread.
  - `TODO: …` → acknowledge in-thread AND append to `## Tasks` in the
    notes doc (checkbox list). Post-meeting these become Linear tickets.
  - `research: …` → subagent researches; result returns as a long
    in-thread reply or, if Bryan asks, a new doc section written with
    the live-feedback edit tools.
- **Cross-artifact requests** ("reorganize these three docs") → comments
  anchored on the `## Requests` section of the notes doc. Comments
  generate events today; plain typed text does not — so requests ride
  the comment channel. This is the deliberate poor-man's chat surface.

### Durable-doc rule

Questions are signals that the doc is unclear — but acting on that only
matters for docs that endure. For docs listed as **durable** in the
notes doc: after answering a comprehension question, ALSO make the
clarifying edit directly (direct edits are the norm — see
CLAUDE.md/suggest-mode convention), note the edit in the thread, and
resolve. For ephemeral docs: answer only, resolve, move on.

### Post-meeting sweep

Open threads → answered + resolved or converted to tickets. `## Tasks`
→ Linear tickets (team BRY or the project's team). Durable-doc edits
flushed. Summary comment on the notes doc.

## P0 — Public URL for Ziv (Cloudflare, un-tabled)

Ziv has no Tailscale access, so the meeting needs the share flow from
[cloudflare-sharing-plan.md](cloudflare-sharing-plan.md). Current state:
tunnel is UP (launchd service installed 2026-08-04, ingress fixed).
Remaining:

1. **TLS decision (Bryan, blocking):** Universal SSL can't cover
   `*.tunnel.fryanpan.com` (second-level wildcard). Either Advanced
   Certificate Manager (~$10/mo, zero code, fast — RECOMMENDED for
   tomorrow's deadline) or single-level `share-<slug>.fryanpan.com`
   with per-share DNS records (better long-term posture, ~1-2h code +
   broader token perms — fine as a later migration).
2. **Credentials (Bryan):** Zero Trust team domain; scoped API token →
   Keychain (`cloudflare-api-token`); then agent wires
   `CF_ACCESS_TEAM_DOMAIN` / `CF_ACCOUNT_ID` / `CF_SHARE_BASE_HOSTNAME`
   into the server plist and restarts.
3. Share with `--allow-domain @<greenlue-domain>` (domain TBD from
   Bryan/Ziv). Access = per-share Cloudflare Access app, email-OTP
   restricted to the allow-listed domains, TTL-bounded (default 72h),
   server-side JWT verification as defense in depth.

## P1 — Cross-doc relative links (code, small)

**Problem (verified):** a relative link `./research/foo.md` in a bound
doc Cmd+Click-opens a raw relative URL that 404s. In a
folder-bound/diff workspace, sibling docs have path-derived docIds, so
the mapping exists — nothing wires it.

**Design:** in the link-open path, when the current doc belongs to a
workspace/set and the href is a relative path ending in a doc-ish
extension, resolve it against the current doc's repo-relative path →
sibling docId → in-SPA navigation to that doc (same as a sidebar
click). Anchors (`#heading`) scroll after navigation when cheap.
External / absolute / non-member links keep today's `window.open`
behaviour, `safeLinkHref` guard unchanged. Pure resolver function +
unit tests; wiring in the editor's Cmd+Click handler.

## P2 — Follow-lite presence (code, moderate)

**Verified gap:** awareness carries `{name, color}` but nothing renders
remote presence; no cursors, no "who's here".

**Scoped-down design** (NOT continuous Figma-style following):
- Each client publishes `{user, docId, topBlockIndex}` via awareness
  (top visible block, throttled).
- Sidebar shows presence dots per doc ("Ziv is in foo.md").
- A **Follow <name>** toggle: when their docId changes, navigate; when
  their topBlockIndex changes, scroll that block into view. Coarse
  block-level sync is the 20% that gives 80% — full selection-cursor
  rendering and smooth scroll-mirroring are explicitly deferred.

## Deferred (revisit after the first real meeting)

- **Per-artifact chat pane** (Claude-Design-style): a real chat surface
  per review set where every doc event and agent status streams, and
  Bryan chats directly for large cross-artifact requests. Deferred
  because the Requests-section-comments channel covers the need with
  zero build, and one real meeting will show whether a dedicated pane
  is the actual bottleneck. If it is: design = a `chat` Yjs array on
  the set's workspace doc, a right-pane UI, agent posts via a new MCP
  tool, events mirrored into the same stream.
- Full continuous follow / remote selection cursors.
- Deletion/suggestion bubbles rendering full markdown + mermaid with
  tap-to-modal (designed separately — see conversation 2026-08-04; all
  machinery exists in `preview.ts`).

## Appendix: worked example — Bryan + Hal, ADFA Quick Build review

Raw capture (lightly categorized) of what one live review produced.
This is the shape of output the protocol must handle routinely:

**Doc-edit requests (durable docs → direct edits):** explain the secure
channel end-to-end (Gradle plugin, channel, reload) in the top-level
README; who manages it and how it's kept correct; how it extends to
other communication types; an explicit Concurrency section (what's
single-threaded vs farmed out; standard-vs-quick-build coordination;
reliability approach) in top-level or CORE README; architecture docs +
diagrams (overview sequence diagram, per-component diagrams, pipeline
details); better explanation of `final` + `android:process` limitations
(impact and why hard, not just "technical details"); document why we
didn't replace android.jar (Akash + Claude research notes); known-
limitations commentary (failed relink → stuck session should be FIXED;
crashing reload without self-healing is OK but must message the user;
same for stale-helper-classes-until-restart); one documented way to
search logcat for relevant logs.

**Tasks / tickets:** review Quick Build Phase 1 PR (3-4h, Goal 1);
prioritize 4GB devices, 1.9GB devices → future ticket; add question for
Akash to the low-spec ticket (the ExtraHeapMemory-style flag changed
from 192MB to ~3xxMB); more low-spec benchmarking; battery-life
instrumentation (Android IDE has ways); review all docs for coherence.

**Signal worth keeping:** Hal called out the *proxying* and *deliberate
things that look wrong* sections as especially useful — the doc style
to preserve.
