---
name: embedding-feedback-widget
description: Use when generating HTML mockups, sample pages, or live dev-server pages that should accept live-feedback comments — covers the standard <script> tags, multi-page docId choice, and setContext calls for dynamic UI state (modals, tabs, SPA routes).
---

# Embedding the live-feedback widget

When you create any HTML surface the user might review — a mockup, a sample
page, a dev-server demo — drop in the feedback widget so they can
point-and-comment without any extra setup. Follow the patterns below
exactly; the widget relies on them to attach comments correctly.

## Base setup (every page)

Put these two `<script>` tags at the **end of `<body>`**, after all the
page content has rendered:

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

- `docId` names the review session. One `docId` per conceptual project,
  shared across all pages of that project.
- `user` comes from the `?as=<name>` query parameter so reviewers can
  self-identify; leave it `null` for anonymous.
- The widget auto-captures `location.pathname + location.search +
  location.hash` as each new comment's `context.url` — no manual
  per-page config needed.

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
