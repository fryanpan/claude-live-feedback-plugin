# streamlined_review — collapsed thread cards you can read at a glance

**Status:** design, awaiting approval
**Date:** 2026-08-10
**Scope:** the collapsed comment balloon only. Read/unread awareness is a
separate spec (see *Out of scope*).

## The problem

The collapsed view made the review surface calmer, and that was the right
call — but it collapsed away the information needed to triage. Today a
collapsed comment card renders exactly four things (`markup-margin.ts`,
`buildCollapsedComment`):

```
[swatch] [author name] [text of the FIRST comment] [reply count]
```

So it shows how a thread *started* and never what it *became*. On a review
with dozens of threads, the reviewer must expand each one to learn whether it
still needs them. The collapse saved screen space and cost triage.

**Goal:** a reader scanning collapsed cards can tell, without expanding, what
each thread is about, where it got to, and whether it is still open — and can
close it in one click.

## Design

### Card layout

Four lines, against a six-line budget:

```
● Alex · open · +2 others
"the retry loop swallows the underlying error"
↳ Debating whether to keep the fallback path
3 replies · 2h ago                            [✓]
```

| Line | Content | Source |
|---|---|---|
| 1 | author swatch + name · status · other participants | existing meta |
| 2 | topic, ≤10 words | generated from the anchor snippet |
| 3 | thread state, ≤10 words | generated from the comments |
| 4 | reply count · relative time · resolve button | existing meta |

Each line truncates with ellipsis rather than wrapping, so the card cannot
grow past four lines at any viewport.

### Status

`open | resolved` only — the two states the model actually stores. An earlier
draft derived a third "replied" state from `commentCount > 1`; it was cut as
redundant, because line 4 already shows the reply count. Nothing new is
persisted for status.

### Other participants

Distinct comment authors minus the thread's first author, rendered as
`+N others`. Names are rendered as text, never HTML — author names are
untrusted (agent-supplied), matching the existing `collapsedIdentity` handling.

### Resolve button

A `✓` on line 4, right of the card body, wired to the same resolve path the
expanded card uses — mirroring how collapsed *suggestions* already put a
compact `✓/✕` next to the same `resolveSuggestion` the full card calls
(`.lf-collapsed-actions`). Reusing that class keeps the icon identical between
collapsed and expanded by construction rather than by discipline.

**Collapsed suggestion cards do not get a resolve button.** Accept/reject is
already their resolution; a third checkmark beside `✓/✕` would be ambiguous.

## Summary generation

### Where it runs

Server-side. The server holds the API key; a client-side call would expose it.
Model: `claude-haiku-4-5-20251001`, matching `scripts/scrub-haiku.py`.

### One call, both lines

A single request per thread returns `{topic, summary}`, each capped at 10
words. The anchor snippet is frequently multi-line, so the topic needs
compressing too — generating both together costs one call instead of two.

### Caching and invalidation

The result is stored on the thread in the ydoc, alongside a hash of the
comment content it was generated from. On render, a hash mismatch schedules
regeneration; a match reuses the stored value. Consequences:

- cost is per **thread change**, not per render
- the summary syncs to every connected client for free, with no client-side
  API access
- a burst of replies debounces into one call

Storing derived text in the CRDT is acceptable here specifically because a
thread summary is no more sensitive than the comments it summarizes, and
share visitors already receive those comments. This does **not** generalize —
see the `private-meta.ts` precedent for fields that must not reach visitors.

### Degradation

No API key, no network, or a failed call falls back to deterministic
truncation: the opening words of the latest comment for line 3, and of the
anchor snippet for line 2. The card always renders. The generated summary is
an enhancement to a card that is already useful without it.

### Accepted tradeoff

This sends comment text to an external API. Flagged explicitly and accepted;
`scrub-haiku.py` establishes the precedent of sending repo content to the same
vendor. Recorded here so the decision is visible rather than implicit.

## Interfaces

| Unit | Responsibility |
|---|---|
| `summarizeThread(anchor, comments)` | pure prompt construction + response parsing; no I/O |
| thread-summary cache | hash, store, invalidate; owns the debounce |
| `buildCollapsedComment` | render four lines from meta + cached summary |
| resolve action | reuse existing resolve path; no new server route |

The first two are unit-testable without DOM or network.

## Testing

- status rendering for both states
- participant list: dedup, self-exclusion, `+N others` formatting
- hash invalidation: changed comments regenerate, unchanged reuse
- fallback path: missing key and failed call both produce a usable card
- word caps enforced on both generated lines
- **browser check at 430px** before this is called done — four lines must
  survive mobile without becoming eight (`design-mobile.md` is load-bearing)

## Out of scope

Read/unread awareness — per-file "viewed" markers that auto-invalidate when a
file changes, unread markers on threads, and "changes since my last review" —
is a separate, larger feature needing per-user server-side state. It gets its
own spec, opening with research into how Word, Google Docs, and GitHub model
per-reader review state.
