# Live review meetings — design & plan (2026-08-04)

Make synchronous, multi-person doc-review meetings genuinely productive:
fast Q&A grounded in the repo, task capture that hands off to Claude,
background research landing mid-meeting, cross-doc navigation, and
following a collaborator.

Driven by a real session: two people reviewing a technical doc set
together, generating a stream of comprehension questions, doc-edit
requests, and follow-up tasks faster than either could write them down.
First external use is with a partner-org reviewer who has no access to
the private tailnet — hence the public-URL dependency below.

## Design principles

- **Simplest design that works.** The live Q&A plumbing already exists
  (anchored comments → `watch_doc` channel events → `post_reply`); the
  meeting problem is mostly *protocol*, not infrastructure.
- **The watcher is the project peer session** that owns the repo the docs
  live in — it has the most context. It commits to no other work while
  the meeting runs.
- **Main loop stays free; subagents do anything slow.** The watcher's
  main loop must always be ready to answer the next question.

## Priorities

| Pri | What | Type | Status |
|-----|------|------|--------|
| P0 | Meeting protocol skill + notes-doc pattern | Behavioral | shipped |
| P0 | Public URL for external reviewers (Cloudflare share) | Infra + operator steps | blocked (see below) |
| P1 | Cross-doc relative links | Code (small) | shipped |
| P2 | Follow-lite presence | Code (moderate) | next |
| Defer | Per-artifact chat pane | Code (large) | revisit after first real meeting |

## P0 — Meeting protocol

Ships as the plugin skill `live-review-meeting`; that SKILL.md is the
authoritative version. Summary:

**Pre-meeting:** bind the doc set (`bind_folder`, or `create_review_doc`
per doc with a shared `setId`); add a bound `meeting-notes.md` with
`## Agenda`, `## Tasks`, `## Requests`, `## Doc durability`; watch every
doc; **prime** by reading every doc and the key source files before the
meeting; verify participant identities resolve.

**During:** first reply within ~1 minute of any comment (answer or an
explicit ack with an ETA). Never block the main loop — anything over ~2
minutes forks to a background subagent while triage continues. Comment
grammar: bare question → answer in-thread; `TODO:` → ack + append to
`## Tasks`; `research:` → subagent, result returns as a reply or a new
doc section. Cross-artifact requests ("reorganize these docs") are
comments on the `## Requests` section — comments generate events, plain
typed text does not, so requests ride the comment channel. That is the
deliberate poor-man's chat surface.

**Durable-doc rule:** questions are evidence the doc is unclear, but
acting on that only pays for docs that endure. For docs marked durable:
answer, then ALSO make the clarifying edit directly (direct edits are
the norm), note it in the thread, resolve. Ephemeral docs: answer and
resolve.

**Post-meeting sweep:** open threads answered/resolved or converted;
`## Tasks` → tickets; durable edits flushed (check `syncError`); summary
comment on the notes doc.

## P0 — Public URL for external reviewers

External reviewers without tailnet access need the Cloudflare share flow
([cloudflare-sharing-plan.md](cloudflare-sharing-plan.md)). The tunnel
itself is up (launchd service installed 2026-08-04, ingress fixed).

**Blocked on two things:**

1. **Security hardening (engineering, MUST land first).** A security
   review on 2026-08-04 found two authorization gaps in the public-URL
   path — see [public-url-threat-model.md](public-url-threat-model.md).
   No external share should be minted until those are fixed.
2. **Operator setup + a TLS decision.** See the Cloudflare plan: a
   second-level wildcard can't use Universal SSL, so either Advanced
   Certificate Manager (~$10/mo, zero code) or single-level hostnames
   with per-share DNS records (free, ~1-2h code). Plus Zero Trust team
   domain, account ID, and the API token in Keychain.

## P1 — Cross-doc relative links (shipped)

Relative links between docs in a bound folder / diff workspace used to
open a raw relative URL and 404. A pure resolver (`resolveDocLink`) now
maps `href` + the current doc's `relPath` to the sibling member docId
(`workspaceId:path~with~tildes`) and navigates in-SPA; external,
absolute, and anchor-only links keep `window.open`, and paths escaping
the workspace root or containing the `~` separator refuse. Wired on the
markdown editor and the editable redline surface.

## P2 — Follow-lite presence (next)

**Verified gap:** awareness carries `{name, color}` but nothing renders
remote presence — no cursors, no "who's here". Awareness is also
PER-DOC (one websocket + awareness per doc), so cross-doc presence needs
a shared channel.

**Design:** a workspace-level presence room (a Yjs room keyed off the
workspace id) that each client also connects to, publishing
`{user, docId, topBlockIndex}` through its awareness — ephemeral,
auto-clears on disconnect, no new REST surface. Sidebar shows presence
dots per doc; a **Follow <name>** toggle navigates when their docId
changes and scrolls their top block into view. Coarse block-level sync
is the 20% that buys 80%; continuous cursor mirroring is deferred.
(Check first whether the ws path auto-creates rooms for an unknown
docId or needs an explicit create/allow route.)

## Deferred

- **Per-artifact chat pane** (a real chat surface per review set where
  doc events and agent status stream, and the operator can make large
  cross-artifact requests). Deferred because the Requests-section
  comment channel covers the need with zero build; one real meeting
  will show whether a dedicated pane is the actual bottleneck. If it
  is: a `chat` Yjs array on the workspace doc, a right-pane UI, an MCP
  tool for agent posts, doc events mirrored into the same stream.
- Full continuous follow / remote selection cursors.
- Balloon bubbles rendering full markdown + mermaid with tap-to-modal
  (all machinery exists in `preview.ts`: safe GFM renderer + mermaid).

## Appendix: what one real review session produced

Kept deliberately abstract — the point is the *shape and volume* of
output the protocol must absorb, not the content of any one project.

A single ~1 hour two-person review of one primary doc plus ~8 secondary
docs produced roughly:

- **~10 doc-edit requests**, nearly all of one kind: "this section
  describes *what* but not *how it's managed*, *how it extends*, or
  *what it costs me*." Several asked for a cross-cutting concept
  (concurrency, ownership, reliability) that lived implicitly across
  several docs and belonged in one explicit section. Two asked for
  architecture diagrams that did not exist anywhere.
- **~6 follow-up tasks**, mixing engineering work, prioritization
  calls, benchmarking requests, and one question to route to an
  engineer who wasn't present.
- **Limitations commentary**: reviewers sorted known limitations into
  "must fix", "acceptable but must tell the user", and "needs a better
  explanation of *why* it's hard" — a distinction the doc hadn't drawn.
- **Positive signal worth capturing**: reviewers named two sections as
  especially useful, which is style guidance for the rest of the doc
  set. The protocol should capture praise, not just defects.

Design implications: (1) most questions are answerable from primed
context — priming is what buys the sub-minute SLA; (2) the dominant
output is doc edits, not answers, which is why the durable-doc rule
exists; (3) tasks and questions-for-absent-people need a capture slot,
hence `## Tasks` in the notes doc.
