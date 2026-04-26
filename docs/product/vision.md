# Vision

## The Goal

Replicate the experience of a few engineers watching over Bryan's shoulder while he points at things — for a remote team that includes one or more LLM agents, working asynchronously across timezones.

Today, when an agent is doing software work for Bryan, the feedback loop is:
1. Agent ships something
2. Bryan opens it (in Notion, in prod, in code review)
3. Bryan finds friction (UX confusion, wrong assumption, weird wording)
4. Bryan writes up the feedback in some place the agent can see (Notion comment, Discord, GitHub PR)
5. Agent reads it, asks clarifying questions, fixes
6. Loop

Each cycle has minutes-to-hours of latency. When the artifact is a UI mockup or a markdown spec or a live page, Bryan often gives up on detailed feedback because writing it up takes longer than just rewriting the thing himself. That kills the whole point of having agents do the work.

**The goal of this project:** make giving feedback as fast as pointing and saying "this." So fast that Bryan and the agent can iterate on a piece of work in real-time, the way two co-located engineers would.

## What Becomes Possible

- Agent shares a markdown spec link → Bryan opens it in a browser, leaves margin comments on specific paragraphs, edits text in place. Agent sees the comments and edits as they happen and starts addressing them.
- Agent ships a UI mockup → Bryan opens the mockup, points at the wrong button and types "this should be on the right." Agent updates the mockup, live-reload picks it up, comment thread persists across the reload, Bryan can mark resolved or reply.
- Agent works on a live dev server → same flow as mockup, but feedback turns into code changes that hot-reload back to Bryan's view.
- For shipped production sites → the same widget submits a Linear ticket for human review (the existing flow in health-tool / family-bike-map).
- Eventually: a remote team of human engineers can do this together with the agents — the same widget supports multi-user real-time collaboration.

## Non-Goals

- Not a general-purpose annotation tool. The point is the tight loop with an agent who's actively working on what's being reviewed.
- Not a replacement for production user research. This is for development-time review.
- Not a code review tool — GitHub PRs handle that fine.
- Not yet aiming for offline / async feedback at scale (that's where Notion and Linear already work). The novel piece is the synchronous live loop.

## The Three Surfaces

This project has to make three surfaces work, sharing as much of the comment-and-thread UX as possible:

### 1. Markdown + diagram review
Agent posts a link to a markdown file (often with mermaid diagrams). Bryan opens it in a browser on whatever device is convenient — the host machine's Tailscale hostname works from his phone or another laptop without any public-internet exposure. He then:
- Sees rendered markdown + mermaid
- Leaves comments anchored to specific text ranges (margin-style)
- Edits text in place, with redlining UX showing what the agent changed since the last view
- The agent gets edits and comments as events; Bryan gets agent edits as redlined diffs

### 2. UX mockup review (live-reload)
Agent serves a mockup with the feedback widget injected. Bryan can:
- Click on any element and leave a comment anchored to it
- See agent updates via live reload — comments persist across reloads, anchored to elements that still exist
- Mark threads resolved, reply to threads
- See an interface listing all open comment threads in case anchors break (e.g., element removed, page changed)

The widget has to be lightweight — injectable into any dev site without conflicting with their framework.

### 3. Live dev server review
Same flow as mockup, but instead of editing a static mockup file, the agent edits the underlying source code. The dev server's own live reload pushes the change back to Bryan's browser. Comment anchors need to survive the reload.

## Key Hard Things

These are the design problems we need to figure out — captured here so the new agent can dig in:

- **Anchor stability under edits.** A comment anchored to "the third paragraph" or "the Login button" needs to survive when the agent rewrites the surrounding content. We need a strategy that works for both DOM nodes (UX) and text ranges (markdown).
- **Comment thread tracking when anchors break.** Inevitably some anchors will be lost (element deleted, page replaced). The UI needs a "Threads" panel showing all open comments, including orphaned ones, so we can resolve or re-anchor them.
- **Realtime collaborative editing.** What framework do we build on? Yjs / Liveblocks / Automerge / something else? What's the minimum viable conflict resolution?
- **Lightweight injection.** The mockup/dev-server widget has to inject into anyone's site without breaking it. No React/Vue/Svelte deps. Vanilla JS or web components.
- **Agent-friendly API surface.** Agents don't need a UX — they need clean APIs to: receive comments as events, post replies, mark resolved, push edits, observe edits. Should be MCP server tools and/or HTTP webhooks.
- **Best-in-breed redlining UX.** When the agent edits markdown, Bryan needs to clearly see what changed. Find or build a good diff-and-accept UI.

## Where We Start

The feedback widget already exists in two of Bryan's projects (`~/dev/health-tool` and `~/dev/family-bike-map`). It collects feedback and submits Linear tickets — useful for production but slow for development iteration.

This project is the next major iteration: starting from those widgets, build a system that supports the three surfaces above with a shared comment-and-thread UX, real-time agent collaboration, and the lightweight injection model.

## Parallel Thread

Bryan's other concern: agents aren't great at UX yet (see `/ux-review` skill in ai-project-support). Until agents can self-evaluate UX well, this project gives Bryan more opportunities to give early feedback so the agent gets it right faster. As agents get better at UX, the feedback frequency will drop, but the tool will still matter for moments where Bryan has specific intent that the agent couldn't have inferred.
