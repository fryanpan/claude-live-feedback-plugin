# Cookbook

How to integrate `claude-workspaces-plugin` into your project.

The plugin ships a generic webhook: when a new comment thread is created,
replied to, resolved, or reopened, the server POSTs a standard JSON
payload to a URL you specify. What happens next is up to you — file a
Linear ticket, append to a markdown doc, ping Slack, anything.

## Webhook payload

```json
{
  "event": "thread.created" | "thread.replied" | "thread.resolved" | "thread.reopened",
  "docId": "your-doc-id",
  "threadId": "...",
  "thread": {
    "id": "...",
    "status": "open" | "resolved",
    "anchor": { ... },
    "createdBy": { "id": "known-bryan", "name": "Bryan", "kind": "known", "color": "#2e7dd7" },
    "comments": [{ "id": "...", "author": { ... }, "text": "...", "ts": 1776400000000 }],
    "commentCount": 1,
    "lastActivity": 1776400000000
  },
  "doc": {
    "docId": "...",
    "type": "markdown" | "mockup" | "dev",
    "sourceUrl": "https://...",
    "title": "...",
    "createdAt": 1776400000000
  },
  "comment": { "id": "...", "author": { ... }, "text": "...", "ts": 1776400000000 },
  "seq": 1
}
```

- `event` tells you what kind of change happened
- `comment` is present on `thread.created` and `thread.replied`; absent on `resolve` / `reopen`
- `anchor.kind` is `text-range` (markdown surface) or `element` (widget) or `orphan`
- `seq` is a monotonically-increasing counter per doc — use for ordering if
  your consumer is eventually-consistent

## Configuring the URL

Per-doc:

```sh
curl -X POST http://localhost:8787/api/docs \
  -H 'content-type: application/json' \
  -d '{"docId":"my-doc","type":"markdown","webhookUrl":"https://yourapp.example/feedback"}'
```

You can also set the URL when re-creating the doc — the call is idempotent.

## Receivers

- [`echo-server.ts`](echo-server.ts) — a tiny Bun server that logs every
  webhook payload. Great for local debugging.
- [`file-log.ts`](file-log.ts) — appends every incoming payload to a JSON
  file. Useful as a minimal reference.
- [`linear.ts`](linear.ts) — example Linear GraphQL integration. Maps new
  threads to Linear issues in a configured team/project. Copy and adapt.

All three are standalone scripts. None are imported by the core — copy
them into your project and modify.

## Testing your integration

With the feedback server running and your webhook URL configured, open
the mockup demo at `/demos/mockup` and leave a comment. Your endpoint
should receive a `thread.created` event. Reply to the thread in the
widget; you'll receive a `thread.replied` event.

You can also fire a test event for the most recent thread on a doc:

```sh
curl -X POST http://localhost:8787/api/docs/my-doc/hooks/fire
```

## Retries

The dispatcher retries 5xx responses with exponential backoff (200ms,
400ms, 800ms, up to ~1s). It does not retry 4xx — if your endpoint
rejects a payload with 400, the event is dropped. Check the log ring
buffer at `GET /api/webhooks/log` to see recent delivery attempts.
