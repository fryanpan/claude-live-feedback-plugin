# Dev-server demo

Demonstrates Surface 3: the widget injected into a live dev server, with
anchors surviving HMR.

## Running

Two terminals:

```
# feedback server (serves /widget.iife.js)
bun run dev

# vite dev server (serves this demo)
cd demos/dev-server
bun install
bun run dev
```

Then open `http://localhost:5173/`.

Add `?as=bryan` or `?as=agent` to identify yourself. Leaving the parameter off
joins as an anonymous viewer who still sees live edits and can comment as
`Anon-<id>`.

## Testing anchor survival

1. Open `http://localhost:5173/` in Chrome.
2. Click the blue ✎ button in the bottom-right → "Comment on element…".
3. Click any element (e.g. the "Start your day" button) and leave a comment.
4. In a second terminal, edit `demos/dev-server/src/main.ts` — change some
   text that doesn't remove the commented element.
5. Vite HMR will refresh; the pin should stay attached.
6. Remove the commented element's markup. The pin should move to the
   Orphaned section of the widget panel.
