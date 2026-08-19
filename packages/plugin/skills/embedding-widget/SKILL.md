---
name: embedding-feedback-widget
description: Use when generating HTML mockups, sample pages, or live dev-server pages that should accept claude-workspaces comments — covers the standard <script> tags, multi-page docId choice, and setContext calls for dynamic UI state (modals, tabs, SPA routes).
---

# Embedding the claude-workspaces widget

When you create any HTML surface the user might review — a mockup, a sample
page, a dev-server demo — drop in the feedback widget so they can
point-and-comment without any extra setup. Follow the patterns below
exactly; the widget relies on them to attach comments correctly.

## Base setup (every page)

The simplest embed is one element + one script tag:

```html
<claude-feedback-widget doc-id="<DOC_ID>" user="bryan"></claude-feedback-widget>
<script src="http://<lf-server-host>:8788/widget.iife.js"></script>
```

- The bundle registers the custom element at load time. The element's
  `connectedCallback` reads attributes and auto-initializes — no JS call
  required from the consumer.
- The widget's WebSocket defaults to the **bundle's origin** (where the
  script came from), so dev-server pages on a different port still reach
  the LF server without a `server-url` attribute.
- `docId` names the review session. One `docId` per conceptual project,
  shared across all pages of that project.
- `user` self-identifies the reviewer; omit for anonymous.
- The widget auto-captures `location.pathname + location.search +
  location.hash` as each new comment's `context.url` — no manual
  per-page config needed.

### Programmatic init (when you need conditional setup)

If you need to derive `docId` or `user` at runtime — e.g. from a query
parameter — call `FeedbackWidget.init` instead. Idempotent; safe to call
even if a `<claude-feedback-widget>` element is already in the DOM.

```html
<script src="/widget.iife.js"></script>
<script>
  (function () {
    var params = new URLSearchParams(location.search);
    window.FeedbackWidget.init({
      docId: '<DOC_ID>',
      user: params.get('as'),
    });
  })();
</script>
```

### Supported element attributes

| Attribute | Maps to opt | Notes |
|---|---|---|
| `doc-id` | `docId` | required |
| `user` | `user` | optional; omit for anonymous |
| `server-url` | `serverUrl` | optional; defaults to bundle origin |
| `view` | `context.view` | optional; SPA modal/tab state |

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

### Static multi-page demo
Each HTML file ends with the base snippet above, with a single shared
`docId`. Nothing else needed.

### Mockup with a modal
Base snippet on the page. In the modal's open/close handlers, call
`setContext` per the example above. No other change.

### SPA with routing + modals
Base snippet at app root. Router changes: widget handles automatically.
Modals: wire `setContext` in the modal component's `useEffect` /
`onMount` / equivalent.

### Live dev server
Same as any other HTML — just make sure the widget snippet is served.
If Vite / webpack strips `<script>` tags in HTML, add the widget to
`main.ts` / entry JS with a dynamic import.

## Don'ts

- Don't add the widget to production builds. It's for review-time
  surfaces only.
- Don't set `context.url` manually — the widget owns it. Only set
  `view`.
- Don't wrap the widget in a framework component that re-mounts it on
  each render. Initialize once, let it live for the page lifetime.
- Don't use a different `docId` when you rebuild the mockup — comments
  are keyed to `docId`, so changing it orphans every prior comment.
- Don't hand the mockup URL over in chat. Post it as a reply on the task
  thread or doc comment the mockup answers (with a `review` payload when
  you're asking someone to look), bare URL on its own line — see "Present
  the work itself in context" in the
  `claude-workspaces:working-a-workspace-board` skill.
