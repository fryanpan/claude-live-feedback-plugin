# Architecture Overview

## **Goal:** Make it easier to explore ways for human(s) to work with a team of agents to do work.

It's built on a few guiding principals or observations:

- Built for Bryan and his side projects / fractional gigs
  - *Approach*: *Start with a [local-first](https://www.inkandswitch.com/) approach that lets one primary user iterate faster with their agent fleet*
  - *Caveats: This system may or may not work for how you want to work!*
- A team of humans & agents benefit from knowing the same shared context
  - *Approach: Real-time, multiplayer space to share knowledge and streamline all important work*
- Existing APIs (and MCP) in legacy systems are evolving too slowly to explore
  - e.g. in Notion, Asana, Confluence, Jira, Linear, Figma, Github, Zoom, etc.
  - Integrating with each of these and across multiple legacy systems slows agents down
  - *Approach: Keep moving critical workflows into the workspace and synchronize with legacy tools as needed*
- Human input to make consequential decisions is becoming even more important, not less
  - *Approach*: *Make human decisions first class citizens in the architecture and make them pervasive*
  - *Approach: Try to give humans the ideal user interface where they can make decisions, in context, and just point at something and give feedback with minimal overhead*
- When our main work is review and making decisions, that work can be done from anywhere
  - *Approach: Everything works on the go from a phone, tablet, or laptop or at home on a desktop* 

## Workflows Covered by Workspaces

This project started first as a way to give real-time synchronous document, mockup, and dev server feedback between one human and a Claude Code agent.  

Over time, we've evolved this to try to cover all of these workflows and decision types in an integrated way:

- Setting goals
- Research and planning
- Prioritization against goals
- Gathering human feedback on decisions, docs, code diffs, mockups, or running apps(the original intent of this repo)
- Building, testing, peer reviewing, and deploying software products
- Having discussions

There are lots of similarities between this tool and [Claude Desktop](https://claude.com/product/claude-code), [Claude Design,](https://claude.com/product/design) [Nimbalyst](https://nimbalyst.com/), [Conductor](https://www.conductor.build/), [Ink & Switch](https://www.inkandswitch.com/), [Fireflies](https://fireflies.ai/lpv/g110-fireflies?utm_source=google&utm_medium=cpc&utm_campaign=brand_fireflies&utm_content=us_eng&utm_term=fireflies&gad_source=1&gad_campaignid=21764657946&gbraid=0AAAAA-Os34oLUjX4hsXgMSHdyUt-3sWlf&gclid=Cj0KCQjwkt_UBhDMARIsALpnOAzs6_kZcSTN_oRsK4HiOF0Fu1671Wx9rzY7xXtcqHaLIm9mk-bagfoaAs1ZEALw_wcB), [Notion](https://www.notion.com/), but all of these other tools are inflexible and have major gaps for my workflow.

**Goal:** one person and a team of agents share one live workspace — docs,
mockups, dev servers, a board, meetings — so giving feedback is as fast as
pointing at a thing and saying "this". Why that is worth building is
[docs/product/vision.md](../product/vision.md); this page is only how the code is
arranged. Read it before non-trivial work.

## The packages, and what is inside `server`

```mermaid
flowchart TB
  subgraph browser[Browser]
    app["workspaces-app<br/>5 bundles: doc · board · signin · landing · sentry"]
    wid["widget<br/>injectable web component"]
  end
  plug["plugin<br/>skills · hooks · bundled mcp"]
  mcp["mcp<br/>stdio MCP server"]
  subgraph srv["server — one Bun process"]
    edge["HTTP edge<br/>server.ts · routes/ · middleware/ · shells.ts<br/>request-admission · request-attribution<br/>socket-handlers · server-options"]
    docs["Doc store and attachments<br/>doc-store.ts · binds.ts · file-binding.ts<br/>doc-*.ts · doc-origin-repo.ts · attachment-backfill.ts<br/>yjs-protocol.ts · sse.ts · sse-mux.ts"]
    board["Board<br/>tasks.ts · task-*.ts · review-items/<br/>home-pane.ts · board-membership.ts · activity.ts"]
    meet["Meetings<br/>meetings.ts · meeting-*.ts · notes-*.ts<br/>transcribe-*.ts · recall*.ts"]
    keep["Keep-moving<br/>stall-wiring · stall-gate · stall-nudge<br/>stall-escalation · note-ask · keep-moving"]
    ident["Identity and sharing<br/>auth/ · share/ · identities.ts"]
    ops["Ops<br/>deploy*.ts · client-release.ts · plugin-release.ts · sentry.ts"]
  end
  core["core — pure shared library"]
  disk[("data dir<br/>.ydoc · JSONL · JSON")]
  files[("bound files<br/>.md in the user's repos")]

  app -->|"REST · Yjs WS · SSE"| edge
  wid -->|REST| edge
  plug --> mcp
  mcp -->|"REST · SSE"| edge
  edge --> docs & board & meet & ident & ops
  board --> keep
  docs <--> files
  docs & board & meet --> disk
  app & wid & mcp -.-> core
  srv -.-> core
```

| Package | What it is | Hard constraint |
| --- | --- | --- |
| `core` | Wire types, the Yjs⇄markdown document model, anchors, attachment-set ids (`attachment.ts`), review-item rules, goal arithmetic, schedule rules and their English, prompts. | Imports no other workspace package. No `node:` I/O beyond path math, no DOM. |
| `server` | The one process: data dir, the doc store, board, meetings, auth, sharing, deploys. | The only writer of durable state. Everything else asks it. |
| `workspaces-app` | The browser client, five bundles from `scripts/build.ts`. | Ships as static assets the server publishes as a numbered release. |
| `mcp` | The stdio MCP server agents talk to — a **client** of the server's REST and SSE. | No business logic the server does not also enforce. |
| `widget` | The injectable comment widget for mockups and dev servers. | 40 KB gzipped (`check:widget-size`). Vanilla JS, no framework deps. |
| `plugin` | Skills, hooks, and a bundled copy of `mcp`. | Version bumped in three places; see CLAUDE.md. |

**Where a route lives.** Everything that decides which URL paths it answers is
under `routes/`, `server.ts` composes and delegates to it and matches nothing
itself, and imports point one way: `server.ts` → `routes/` → everything else.
So `routes/shell-static.ts` (which page or asset an address gets) and
`routes/upgrade-stream.ts` (this request wants a connection, not a response)
sit there rather than at the top level, while `request-admission.ts`,
`request-attribution.ts` and `socket-handlers.ts` stay top-level because they
run for a request whatever path it named. `server-options.ts` holds
`ServerOptions` so a route can name it without importing the router back, and
`review-gate-types.ts` holds the two verdict shapes a route and the gate both
need. Full rule: [.claude/rules/code-health.md](../../.claude/rules/code-health.md).

**What runs on a clock.** Three loops in the server tick rather than answer a
request, and all three take an injected `now` so a test moves the clock
instead of waiting: the two board wakes in the Keep-moving group, and
`task-scheduler.ts`, which files an instance each time a row's schedule comes
due ([scheduled-tasks](scheduled-tasks.md)). The scheduler joins the Board
group under its `task-*.ts` glob rather than changing the picture — it reads
and writes the same rows through the same store, and only its clock is new.

**A schedule rule has one spelling.** `core` holds four modules for it and no
other package holds any: `task-schedule.ts` (the rule type and the occurrence
arithmetic), `schedule-timezone.ts` (instant ⇄ wall clock),
`schedule-phrase.ts` (a rule written as canonical English) and
`schedule-phrase-parse.ts` (English read back into a rule). The last two are a
pair and are asserted to be inverses, which is what lets the editor show one
rule as a phrase and as chips without either view being the source
([scheduled-tasks](scheduled-tasks.md)).

**Which channel carries what.** *Yjs*, one WebSocket per document, carries what
two people watch change under each other's cursors: text, threads, replies,
suggestions, anchors, presence, live notes. Agents hold no replica, so an agent
edit is a REST call the server applies to the doc. *REST* carries what needs the
server as an authority — sign-in, binds, diffs, shares, deploys, and the board,
where a write is a decision with an author and a gate rather than a merged
value. *SSE* pushes changes to anyone holding no Yjs socket for them.

## Layers inside `server`

**Imports point downward only** — a file may import its own layer and every layer below it, never one above.

| Layer | Where it lives | Why it is its own layer |
| --- | --- | --- |
| **HTTP** | `server.ts`, `routes/**`, `middleware/**`, `shells.ts`, `request-admission.ts`, `request-attribution.ts`, `socket-handlers.ts` | The only code that knows about HTTP. Parse, admit, call one service, format. |
| **Services / stores** | `doc-store.ts`, `tasks.ts` and the `task-*` stores, `review-items/**`, `home-pane.ts`, `share/**`, `auth/**`, the `meeting-*` and `notes-*` families, `sse.ts`, `activity.ts` | Owns durable state and orchestrates one change across stores and adapters. |
| **Domain (pure)** | `task-owner.ts`, `task-fields.ts`, `task-row.ts`, `decision-shape.ts`, `safe-path.ts`, `workspace-path.ts`, `diff-groups.ts`, `pause-ticker.ts`, `keep-moving.ts`, `stall-gate.ts`, `notes-section.ts`, `ask-detection.ts`, `notes-link-intent.ts` | Functions over values: no clock, filesystem or socket unless passed in, so a rule is testable without a server. |
| **Adapters** | `transcribe-*.ts`, `recall*.ts`, `google-oauth.ts`, `summarize.ts`, `deploy*.ts`, `client-release.ts`, `push-notify.ts`, `share/cf-api.ts`, `share/keychain.ts`, `git-diff.ts`, `sentry.ts` | One vendor or OS facility each, behind an injected interface, so a swap or a test double touches one file and no state. |
| *Composition root* | `bin.ts`, `server-config.ts`, `server-deps.ts` | Reads the environment once, builds adapters, wires services. Beside the stack, not on top of it. |

`workspace-path.ts` is the newest name in that row and it sat under `routes/`
until the canonical-routes cutover. It parses `/workspaces/<id>/…` and holds the
one list of which of those addresses are HTML pages — and the reason it moved is
that it now has TWO readers on opposite sides of the import rule:
`routes/shell-static.ts`, which serves those pages, and
`middleware/workspace-scope.ts`, which must pass them over. It answers no
request and returns no `Response`, so it belongs beside the other functions over
values; leaving it in `routes/` would have meant a module outside `routes/`
importing out of it, which is the direction `check:imports` exists to refuse.

`workspaces-app` layers the same way — entries, controllers, views, models,
transport — and its models are DOM-free, which is what lets `board/board-model.ts`,
`board/board-review-model.ts` and `board/board-presence-model.ts` be tested without a
document. `suggestions/` sits in the editor tier rather than inside `redline/`,
because Redline is the change view and a suggestion is the proposal: the chip
and the doc-level pending badge render on the plain markdown surface and on the
board's task-body editor, neither of which mounts a redline module. `notes-link-affordance.ts` joins the editor tier beside
`task-link-chips.ts`, and is the one plugin there that WRITES: the chips are
render-time and change nothing, while accepting a note's suggestion or undoing
a link edits the stored doc and calls the board. `core` is three tiers: wire types, the document model (`prose-*.ts`,
`anchor/**`, `redline.ts`), then the rules both sides must compute identically
(`review-item*.ts`, `effort-*.ts`, `goal-effort.ts`, and
`note-suggestion.ts`, which is how a note's written "did you mean this row?"
is spelled — server writes it, browser reads it back, one definition so the
two cannot drift into a suggestion nobody can accept).

`prose-integrity.ts` belongs to that document-model tier and does not move the
picture: it is the check the server runs after a write, asserting the live doc
holds no markdown syntax that should have become blocks. It is named here so the
next reader knows a new `prose-*` module was placed rather than missed.

## The core flows

```mermaid
flowchart LR
  subgraph f1["A comment: browser → .ydoc → agent"]
    B1[Browser] -->|Yjs update over WS| R1["Live doc<br/>doc-store.ts"]
    R1 -->|debounced persist| Y1[(".ydoc · bound .md")]
    R1 -->|thread event| S1["SSE bus<br/>sse.ts · sse-mux.ts"]
    S1 -->|channel frame| A1["Agent<br/>mcp watch_doc"]
  end
  subgraph f2["A task: MCP tool → board"]
    A2[Agent] -->|tool call| M2[mcp] -->|"REST /api/tasks"| G2["write gate<br/>owner · shape · deps"]
    G2 --> T2["TaskStore<br/>tasks.ts"] --> J2[("tasks JSON · activity JSONL")]
    T2 -->|SSE| H2[Board tab]
  end
  subgraph f3["A meeting tick"]
    Mic[Browser mic] -->|PCM16| W3["WS /audio/&lt;docId&gt;"] --> Rl[MeetingRelay]
    Rl <-->|turns| En[Transcription engine]
    Rl --> St[("append-only transcript")]
    Rl --> N3["Notes session<br/>pause-or-cadence clock"]
    N3 -->|"Haiku compose · planNotesMerge"| D3[Doc notes section]
  end
```

The file is the source of truth at rest, the live doc at runtime, both
directions debounced — which is why a plain `Write` to a bound file loses: the
doc reasserts itself a second later while git still exits 0. A new field needs
three additions, MCP tool schema, route and service, and the route is the one
nothing type-checks, so add an HTTP-level test for every new parameter. The
audio socket is the meeting's lifecycle: every way it can end ends the meeting
exactly once, and nothing word-rate enters the SSE buffer.

## Subsystem docs

- [meeting-assistant.md](meeting-assistant.md) — live transcription and notes on a pause-or-cadence clock.
- [stall-detection.md](stall-detection.md) — board wakes, what counts as stalled, and their economics.
- [goal-projection.md](goal-projection.md) — the goal bar, the remainder, and when a goal lands.
- [security.md](security.md) — the boundaries, and which gate decides each one.
- [glossary.md](glossary.md) — the nouns, once each; [exceptions.md](exceptions.md) — every file over 500 lines, split or excepted, with [split-plan.md](split-plan.md) as its queue.

## Adding a file

1. Name its layer first. If you cannot, it is doing two jobs.
2. Check the import direction. A service importing a route, or a model
   importing the DOM, is the error the layers exist to catch.
3. Keep it under 500 lines, or add a row to `exceptions.md` saying why —
   `bun run loc:audit` fails a file that crosses the line with no row.
4. If it is a **top-level** module — a file or directory sitting directly in
   `packages/<pkg>/src/` — redraw the diagram above in the same PR.
   `bun run check:architecture` fails a PR that moves that map without it.
5. In `server`, if it names a URL path it goes under `routes/`; if it runs for
   every request whatever the path, or never sees a `Request`, it stays at the
   top level. The rule and its two consequences are
   [.claude/rules/code-health.md](../../.claude/rules/code-health.md), "A route
   lives in `routes/`", and `bun run check:imports` fails the import edges it
   forbids.
