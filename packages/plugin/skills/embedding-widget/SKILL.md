---
name: embedding-feedback-widget
description: Use when an HTML surface should accept claude-workspaces comments — a mockup, a sample page, a generated report, a live dev server — or when deciding where widget markup may be written.
---

# Embedding the claude-workspaces widget

Any HTML surface a person might review can accept point-and-comment feedback.
Two ways to get there, and **which one you use is decided by a command, not by
judgement.**

## Run this before you type widget markup into anything

```bash
git ls-files --error-unmatch <path>   # exit 0 → git tracks it today
git check-ignore -q <path>            # exit 0 → gitignored; git will never track it
```

| Result | The file is | What to do |
|---|---|---|
| `ls-files` exits 0 | tracked | **No widget in the source.** Bind the output — next section. |
| `check-ignore` exits 0 | ignored | Embed by hand. |
| neither exits 0 | a new file inside a repo that `git add -A` will sweep up | Treat as tracked. |
| not in a repo at all | scratch | Embed by hand. |

This replaces an older rule that said "don't add the widget to production
builds". That rule was true and did not reach far enough: a benchmark harness
has no production build, so it read as permission. The measured result was
`<claude-feedback-widget … user="…">` — a real reviewer's name in it —
committed inside a tracked HTML
template on a repo bound for a **public** remote, plus a report generator that
hard-failed when the tag was absent — a clean checkout could not produce a
report, because review scaffolding had become a build dependency.

Ask "is this file tracked", never "is this a production build". The first is
one command. The second is a judgement, and that judgement is the one that
failed.

## Tracked → bind the rendered file; the server attaches the widget

You do not need the file to change. Generate the page exactly as it normally
renders — bare, no widget anywhere in the template, the generator, or the
output — and hand the produced file to `bind_mock`:

```
bind_mock(docId: "<DOC_ID>", sourceHtmlPath: "/abs/path/to/out/report.html")
```

The reviewer opens the returned `reviewUrl` and gets the widget. The server
re-reads the file on every request and attaches the embed on the way out, so
regenerating the report keeps working and `docId` keeps the threads. Nothing
about the repo changed, and nothing has to be reverted before you commit.

If the page already carries its own embed, the server leaves it alone.

## Untracked → embed by hand

One element + one script tag, in a file git does not track:

```html
<claude-feedback-widget doc-id="<DOC_ID>"></claude-feedback-widget>
<script src="http://<workspaces-server-host>:8787/widget.iife.js"></script>
```

- The bundle registers the custom element at load time. The element's
  `connectedCallback` reads attributes and auto-initializes — no JS call
  required from the consumer.
- The widget's WebSocket defaults to the **bundle's origin** (where the
  script came from), so dev-server pages on a different port still reach
  the server without a `server-url` attribute.
- `docId` names the review session. One `docId` per conceptual project,
  shared across all pages of that project.
- **No `user` attribute.** The widget resolves the reviewer from the browser
  it is running in. A name in the markup does not identify the reader — it
  re-brands them, seeding whoever opens the page as that person. See the
  attribute table for the one case where passing it is right.
- The widget auto-captures `location.pathname + location.search +
  location.hash` as each new comment's `context.url` — no manual
  per-page config needed.

## The page must render without the widget

Whatever you build, removing the widget must leave a working page. A generator
that fails, a template that renders broken, or a test that goes red when the
embed is missing has turned review scaffolding into a build dependency — the
second half of the measured incident above.

So: no required placeholder the renderer must fill, no assert that the tag is
present, no code path that reads the widget's state. If you cannot delete the
embed and still get a page, the embed is in the wrong place.

### Programmatic init (when you need conditional setup)

If you need to derive `docId` at runtime — e.g. from a query parameter — call
`FeedbackWidget.init` instead. Idempotent; safe to call even if a
`<claude-feedback-widget>` element is already in the DOM.

```html
<script src="/widget.iife.js"></script>
<script>
  (function () {
    var params = new URLSearchParams(location.search);
    window.FeedbackWidget.init({ docId: params.get('doc') || '<DOC_ID>' });
  })();
</script>
```

### Supported element attributes

| Attribute | Maps to opt | Notes |
|---|---|---|
| `doc-id` | `docId` | required |
| `server-url` | `serverUrl` | optional; defaults to bundle origin |
| `view` | `context.view` | optional; SPA modal/tab state |
| `user` | `user` | **omit.** It seeds an identity into a fresh browser rather than reading one, so it is right only for a throwaway local page you are driving yourself — and never in a file anything commits. |

## Multi-page sites — same docId, let context do the filtering

**Use ONE `docId` across all pages of the site** (e.g.
`'atlas-labs-v3'`). The widget tags each comment with the page URL
automatically. When the reviewer navigates between pages, only the
pins for the current page stay visible; cross-page threads remain
available in the sidebar.

Do NOT make up a different docId per page — that silos comments and
breaks cross-page views. One docId, one review session.

## Dynamic UI state — `setContext({ view })`

For anything that changes what's visible without changing the URL —
modals, drawers, tabs, filters, step wizards — the widget cannot tell
from pathname alone whether a comment belongs to the visible state.
Call `setContext` when the app enters or leaves that state:

```html
<script>
  function openSettings() {
    document.getElementById('settings-modal').hidden = false;
    window.FeedbackWidget.setContext({ view: 'modal=settings' });
  }
  function closeSettings() {
    document.getElementById('settings-modal').hidden = true;
    window.FeedbackWidget.setContext({ view: undefined });  // clear
  }
</script>
```

Guidelines for picking a `view` key:

- **Short, stable, namespaced.** `modal=settings`, `drawer=cart`,
  `tab=billing`, `wizard=step-3`.
- **Not ephemeral.** Don't put scroll positions, timestamps, or
  per-click IDs in `view` — it'd be unique every time and no pin would
  ever re-match.
- **Combine with `;` if multiple dimensions matter.** e.g.
  `modal=settings;tab=security`.
- **Clear with `undefined`** when the state ends.

If you need to annotate an element that only exists in a given state,
put the app into that state **before** the widget creates the anchor
(i.e. `setContext` → open the modal → wait a frame → let the user
annotate). The widget will capture the current `view` on anchor
creation and use it to filter later.

## SPA routes (pushState-based routers)

The widget patches `history.pushState` / `replaceState` and listens for
`popstate` / `hashchange`, so you don't need to wire anything extra
for the URL part. You still need `setContext({ view: … })` for
non-URL dynamic surfaces.

## Concrete patterns

### Generated report / static build output
The generator stays bare. `bind_mock` the file it wrote. If the output is
gitignored (it usually is), you may also embed by hand — but binding survives
a regeneration and hand-editing the output does not.

### Mockup you are writing from scratch
Write the HTML outside the working tree and `bind_mock` it. Mockups do not
enter the repo, so this needs no widget markup at all.

### Multi-page demo in a scratch directory
Each file ends with the hand embed, one shared `docId`. Nothing else needed.

### Mockup with a modal
Embed present (by hand or attached). In the modal's open/close handlers, call
`setContext` per the example above. No other change.

### Live dev server
Its entry file is almost always tracked, so the embed goes somewhere git does
not follow: a gitignored local entry, a dev-only plugin behind `.env.local`, or
a working-tree edit you revert before committing. If Vite / webpack strips
`<script>` tags in HTML, add the widget from that same untracked JS with a
dynamic import.

## Don'ts

- Don't write widget markup into any tracked file — the page, the template it
  renders from, the generator that emits it, or a test fixture. Run the check
  at the top instead of deciding.
- Don't make the page depend on the widget. It must render without it.
- Don't set `context.url` manually — the widget owns it. Only set `view`.
- Don't wrap the widget in a framework component that re-mounts it on
  each render. Initialize once, let it live for the page lifetime.
- Don't use a different `docId` when you rebuild the mockup — comments
  are keyed to `docId`, so changing it orphans every prior comment.
- Don't hand the mockup URL over in chat. Post it as a reply on the task
  thread or doc comment the mockup answers (with a `review` payload when
  you're asking someone to look) — and there it goes in as an inline
  relative link rather than a raw URL. See "Use Links Effectively" in the
  `claude-workspaces:working-in-a-workspace` skill.
