# Route inventory

*Untracked working document. Written 2026-09-02 against `bc7acd83`.*

The canonical shape is the Google API design guide: plural collection names, and every resource a workspace owns addressed under the workspace that owns it. A task is `/workspaces/{workspaceId}/tasks/{taskId}`, a doc is `/workspaces/{workspaceId}/docs/{docId}`, and the JSON twin of each page path is the same path with `?format=json` (owner's call, 2026-09-03: the `/api` prefix goes; table cells below that still say `/api/workspaces/…` read as `/workspaces/…` plus `?format=json`). Pages already work this way. The REST surface mostly does not: `/api/tasks/{taskId}` and `/api/docs/{docId}` name a resource and leave the server to look up which board holds it.

One rule follows from the shape. The workspace is resolved from the path once, by a single middleware, before any handler runs, and access is enforced there and nowhere else. Today 97 routes cannot be covered by such a middleware, because the workspace is not in their path at all. Ninety-one of them the server can still resolve, by asking a store which board holds that doc, task, goal or attachment set. That lookup is the thing the move deletes. The remaining six are worse: four carry the workspace in a request body or query string, one carries it in a path segment that is not under `/workspaces`, and one reads across every board at once.

Route counting rule below: one row per distinct path pattern, with HTTP methods multiplexed onto it. `GET` and `PUT` on one path is one route.

---

## 1. Top-level routes that stay top-level

These have no owning workspace, or are reached before one is known.

| Path                                                         | Who calls it           | Why it cannot live under a workspace                         |
| ------------------------------------------------------------ | ---------------------- | ------------------------------------------------------------ |
| `GET /`                                                      | browser                | Landing page. Lists every board; picking one is what produces a workspace id. |
| `GET /signin`                                                | browser                | Runs before identity exists, so before workspace access can be evaluated. |
| `GET /widget-auth`                                           | widget popup           | Cross-origin auth handshake keyed to the host page's origin, not a board. |
| `GET /share/{slug}`, `GET /s/{slug}`                         | external collaborator  | Share entry. The slug is the only thing the visitor has; it resolves to a workspace. |
| `GET /projects/{owner}`                                      | browser                | Project artifact page, keyed by owner across boards.         |
| `GET /demos/*`                                               | browser                | Static demo pages, no board involved.                        |
| `/widget.js`, `/widget.iife.js`, `/widget.esm.js`            | third-party host sites | Bundle URL is pasted into `<script src>` on sites that know no workspace id. |
| `/widget/*`                                                  | host sites             | Widget dist assets, same reason.                             |
| `/app/*`                                                     | browser                | Client bundle assets.                                        |
| `/sw.js`, `/sw.js.map`, `/manifest.webmanifest`, `/icon.svg`, `/icon-192.png`, `/icon-512.png`, `/apple-touch-icon.png` | browser                | PWA assets aliased to root so the service worker's scope covers `/workspaces/…`. Moving them narrows the scope. |
| `POST /recall/status`                                        | Recall.ai webhook      | External vendor posts to a fixed URL registered out-of-band. |
| `/recall/{token}` (WS)                                       | Recall.ai backend      | Vendor connects with a token it was handed; it has no board id. |
| `GET /api/webhooks/log`                                      | agent, debugging       | Server-wide webhook log.                                     |
| `GET /api/calendar/google/callback`                          | Google OAuth           | Redirect URI is registered with Google as a fixed string.    |
| `/api/auth/*` (7 routes)                                     | browser, widget        | Identity is established before workspace access can be checked. |
| `/api/share/*` (7 routes)                                    | MCP tools              | Sharing is server administration; a share may cover many resources. |
| `/api/metrics`, `/api/deploy`, `/api/plugin/refresh`, `/api/push/key`, `/api/push/subscriptions` | ops, browser           | Host-level operations, one server not one board.             |
| `/api/chat-audit`, `/api/chat-audit/{who}`, `/api/summaries/backfill`, `/api/refs/backfill` | agents                 | Cross-board maintenance and rollups.                         |
| `/api/agents/{agentId}/watches`, `/api/agents/{agentId}/merge`, `/api/agents/{agentId}/notes` | MCP, agent             | An agent is a server-level actor that attaches to many boards. |
| `/api/dispatches`, `/api/dispatches/{taskId}`                | MCP                    | Worktree registry, keyed by task but server-scoped.          |
| `POST /api/agent-notes`                                      | plugin hooks           | Hook posts a note and the server infers the task from `cwd`. The hook has no ids. |
| `/api/calendar`, `/api/calendar/events`, `/api/calendar/events/{eventId}/join`, `/api/calendar/google`, `/api/calendar/google/connect` | browser                | Per-person calendar connection, not per-board.               |
| `GET /api/meeting-engines`                                   | browser                | Server capability list.                                      |
| `POST /api/links/titles`                                     | browser                | Resolves titles for URLs that may span boards. See Notes in §3.9. |

**52 routes.**

---

## 2. The inventory

Glossary renames are marked **[G]** and follow [glossary.md](glossary.md): `/review/{docId}` → `/workspaces/{id}/docs/{docId}`, `/api/reviews` → attachments, huddle → plan / meeting notes, `retire` → `archive`.

### 2.1 Pages

| Current path (method)                                        | What it does               | Who calls it                                          | Canonical replacement                     | Notes                                                        |
| ------------------------------------------------------------ | -------------------------- | ----------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------ |
| `GET /workspaces/{workspaceId}` and `…/home`, `…/tasks`, `…/mine`, `…/activity` | Serves the board shell     | browser                                               | unchanged                                 | Already canonical. One regex, five paths, client-side routing picks the pane. |
| `GET /workspaces/{workspaceId}/docs/{docId}`                 | Serves the document editor | browser                                               | unchanged                                 | Already canonical.                                           |
| `GET /workspaces/{workspaceId}/mockups/{docId}`              | Serves a bound mockup      | browser                                               | unchanged                                 | Already canonical.                                           |
| `GET /workspaces/{workspaceId}/reviews/{reviewId}`           | Redirects to the entry doc | browser                                               | `…/attachments/{attachmentSetId}` **[G]** | Canonical shape, wrong noun. Redirects to `…/docs/{entryDocId}`. |
| `GET /review/{docId}`                                        | Legacy document editor     | browser bookmarks, old bundles, pasted comment bodies | `/workspaces/{id}/docs/{docId}` **[G]**   | LEGACY. Redirects when the doc's workspace resolves; serves in place when it does not. Still emitted today by `hub-app.ts:501` and `hub-live-wiring.ts:152`, and written into durable review-item bodies by two skills. |
| `GET /mockup/{slug}`                                         | Legacy mockup address      | browser                                               | `/workspaces/{id}/mockups/{docId}`        | LEGACY. Same redirect-or-serve pattern.                      |

### 2.2 WebSocket and server-sent events

| Current path                                   | What it does             | Who calls it                           | Canonical replacement                  | Notes                                                        |
| ---------------------------------------------- | ------------------------ | -------------------------------------- | -------------------------------------- | ------------------------------------------------------------ |
| `WS /y/{docId}`                                | Yjs CRDT document sync   | browser page, widget                   | `/workspaces/{id}/docs/{docId}/sync`   | No workspace. Auto-creates mockup rooms; read-only is decided before the room exists. |
| `WS /audio/{docId}`                            | Meeting audio relay      | browser page                           | `/workspaces/{id}/docs/{docId}/audio`  | No workspace. Path is built in `core/src/meeting.ts:37`, not in the client. |
| `SSE /events/{docId}`                          | Per-doc event stream     | browser page, widget, MCP `watch_doc`  | `/workspaces/{id}/docs/{docId}/events` | No workspace. `observe_url` returns this string to agents, so the old shape leaks into agent memory. |
| `SSE /events/workspace/{workspaceId}?agentId=` | Board event stream       | browser page, MCP auto-watch on attach | `/workspaces/{id}/events`              | Has the workspace, at the wrong place. **Collides** with `GET /api/workspaces/{id}/events`, which is the activity feed. See Decision 2. |
| `WS /recall/{token}`                           | Vendor transcript socket | Recall.ai                              | unchanged                              | Stays top-level. Order-sensitive: `POST /recall/status` must be matched above it. |

### 2.3 `/api/workspaces/*` — already canonical

All 32 carry the workspace as the first path variable.

| Current path (methods)                                       | What it does                      | Who calls it                                        | Notes                                                        |
| ------------------------------------------------------------ | --------------------------------- | --------------------------------------------------- | ------------------------------------------------------------ |
| `/api/workspaces` (POST, GET)                                | Create board; list boards         | MCP `create_workspace`, `bind_folder`               | `bind_folder` passes `workspaceId` **and** `hubWorkspaceId` in the body. |
| `/api/workspaces/{id}` (GET, DELETE)                         | Read board; destroy board         | MCP `get_workspace`, `delete_workspace`; board page | DELETE fronts **two stores** — a board or an attachment set, dispatched by id. Deliberately excluded from the `reviewApi` alias. |
| `…/{id}/home` (GET)                                          | Home brief for one person         | board page                                          | Identity in the query string (`?user=`) on an authenticated route. |
| `…/{id}/home/read` (POST)                                    | Mark the brief read               | board page                                          |                                                              |
| `…/{id}/home/instructions` (PUT)                             | Edit standing instructions        | board page                                          |                                                              |
| `…/{id}/review-items` (GET)                                  | The review queue                  | board page                                          |                                                              |
| `…/{id}/next` (GET)                                          | Ready-to-work queue               | MCP `next_tasks`                                    |                                                              |
| `…/{id}/tasks` (GET, POST)                                   | List and create tasks             | MCP `list_tasks`, board page, spin-off menu         |                                                              |
| `…/{id}/tasks/batch` (POST)                                  | Bulk create                       | MCP `create_tasks`                                  |                                                              |
| `…/{id}/import-tasks` (POST)                                 | Import a markdown task list       | MCP `import_tasks_markdown`                         | Custom verb on the board, not a collection.                  |
| `…/{id}/goals` (PUT)                                         | Replace the ordered goal list     | MCP `set_goal_list`                                 |                                                              |
| `…/{id}/goals/rename` (POST)                                 | Rename a goal                     | MCP `rename_goal`, board page                       | Custom verb.                                                 |
| `…/{id}/goals/add` (POST)                                    | Add a goal                        | board page                                          | Custom verb; duplicates `PUT …/goals`.                       |
| `…/{id}/goals/reorder` (POST)                                | Reorder goals                     | MCP `reorder_goals`                                 | Custom verb.                                                 |
| `…/{id}/goal` (PUT)                                          | Set the board's active goal       | agent                                               | Singular `goal` next to plural `goals` doing something unrelated. |
| `…/{id}/settings` (GET, PUT)                                 | Review criteria, cap              | board page, MCP `set_review_item_criteria`          |                                                              |
| `…/{id}/parallelism-cap` (GET, PUT)                          | Dispatch cap                      | MCP `set_parallelism_cap`                           | Duplicates a field inside `…/settings`.                      |
| `…/{id}/lead` (PUT)                                          | Set the lead seat                 | MCP `set_workspace_lead`, `declare-lead.ts` hook    |                                                              |
| `…/{id}/rename` (POST)                                       | Rename the board                  | MCP `rename_workspace`                              | Custom verb.                                                 |
| `…/{id}/retired` (PUT)                                       | Archive / restore the board       | MCP `retire_workspace`, `unretire_workspace`        | **[G]** `retire` → `archive`.                                |
| `…/{id}/voice` (POST)                                        | Spoken command                    | board page                                          |                                                              |
| `…/{id}/events` (GET)                                        | Activity feed                     | board page                                          | Name collides with the SSE stream at `/events/workspace/{id}`. |
| `…/{id}/load-reports` (GET, POST)                            | Client load telemetry             | board page                                          |                                                              |
| `…/{id}/docs` (POST)                                         | Attach a doc to the board         | MCP `attach_doc`                                    |                                                              |
| `…/{id}/huddles` (POST)                                      | Start a plan or meeting-notes doc | board page                                          | **[G]** huddle → `…/plans`, `…/meetings`.                    |
| `…/{id}/attachments` (GET, POST)                             | List / attach **AGENTS**          | MCP `attach_agent`, `list_attachments`, board page  | **Name collision.** The glossary reserves "attachment" for docs, mockups, previews and diffs. See Decision 1. |
| `…/{id}/attachments/{agentId}` (DELETE)                      | Detach an agent                   | MCP                                                 | Same collision.                                              |
| `…/{id}/attachments/{agentId}/heartbeat` (POST)              | Keep presence alive               | MCP `heartbeat`, timer                              | Same collision.                                              |
| `…/{id}/comment-queue/{rowId}/ack` (POST)                    | Acknowledge a queued comment      | MCP `attach_agent`, `declare-lead.ts`               | Singular collection name.                                    |
| `…/{id}/voice-queue/{queueId}/ack` (POST)                    | Acknowledge a voice request       | MCP SSE handler                                     | Singular collection name; no tool calls it directly.         |
| `…/{id}/threads`, `…/grouped`, `…/refresh`, `…/groups`, `…/files`, `…/tree`, `…/context-file`, `…/editable-file` | Attachment-set operations         | board page, MCP                                     | **Alias arm.** One regex, `reviewApi()` at `server.ts:1009`, serves these under both `/api/workspaces/` and `/api/reviews/`. Counted once, in §2.6. |

### 2.4 `/api/docs/*` — 50 routes, none carrying a workspace

Every one moves to `/api/workspaces/{workspaceId}/docs/{docId}/…`. `routes/docs.ts:783` canonicalizes the doc id once, and ~30 sub-routes inherit it.

| Current path (methods)                                       | What it does                        | Who calls it                                                 | Notes                                                        |
| ------------------------------------------------------------ | ----------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| `/api/docs` (POST)                                           | Bind a file or mockup               | MCP `create_review_doc`, `bind_mock`                         | Workspace in the **BODY** as `hubWorkspaceId`.               |
| `/api/docs` (GET)                                            | List docs                           | MCP `list_docs`, `set-nav.ts`                                | Workspace in the **QUERY** as `workspaceId`; the client sends `?setId=` instead. |
| `/api/docs/{docId}` (GET, DELETE)                            | Read meta; hard/soft delete         | MCP `delete_doc`, `doc-meta.ts`, `plan-gate.ts`              | GET returns `backTo`, which is how a doc reached by the flat path learns its board. Owner-only, so a share visitor never gets one. |
| `…/{docId}/content` (GET, POST)                              | Read / rewrite markdown             | MCP `get_doc`, `set_doc_content`                             |                                                              |
| `…/{docId}/status` (GET)                                     | Bind and sync state                 | MCP `doc_status`                                             |                                                              |
| `…/{docId}/reparse_from_disk` (POST)                         | Force pull from disk                | MCP `reparse_from_disk`                                      | Snake_case sub-resource.                                     |
| `…/{docId}/archive`, `…/unarchive` (POST)                    | Soft delete and restore             | MCP `archive_doc`, `unarchive_doc`                           | Handled in `server.ts:6245`, **not** in `routes/docs.ts`, because that block 404s when no room exists — exactly an archived doc's state. Order-sensitive. |
| `…/{docId}/diff` (GET)                                       | Diff hunks                          | redline and code surfaces                                    |                                                              |
| `…/{docId}/activity` (POST)                                  | Record a read session               | reading tracker (sendBeacon)                                 |                                                              |
| `…/{docId}/tasks` (GET)                                      | Tasks referencing this doc          | board page                                                   | Queries under both the canonical id and the alias.           |
| `…/{docId}/home` (GET, PUT, DELETE)                          | Pin / read / unpin the origin repo  | agent                                                        | **[G]** `DocHome` → `DocOriginRepo`. Owner-only: it is host filesystem paths. |
| `…/{docId}/plan` (POST)                                      | Approve a plan                      | plan gate                                                    |                                                              |
| `…/{docId}/plan-request` (POST)                              | Ask for a plan                      | board page                                                   |                                                              |
| `…/{docId}/review-request` (POST)                            | Ask for a review                    | board page                                                   |                                                              |
| `…/{docId}/research-request` (POST)                          | Spin off research                   | spin-off menu                                                |                                                              |
| `…/{docId}/lead-presence` (GET)                              | Is a lead listening                 | lead banner                                                  |                                                              |
| `…/{docId}/threads` (GET, POST)                              | List threads; open a subject thread | MCP `list_threads`, `create_thread`; review composer; widget | Also hit by a hardcoded `curl` in `commands/feedback-threads.md`. |
| `…/{docId}/threads/by_find` (POST)                           | Open an anchored thread             | MCP `create_thread` with `find`                              | Snake_case sub-resource; a second create path for one concept. |
| `…/{docId}/threads/{threadId}` (GET)                         | Read one thread                     | MCP `get_thread`                                             |                                                              |
| `…/threads/{threadId}/comments` (POST)                       | Add a comment                       | MCP `post_reply`, `request_more_info`; widget                |                                                              |
| `…/threads/{threadId}/resolve`, `/reopen` (POST)             | Flip thread status                  | MCP, review chrome, widget                                   |                                                              |
| `…/threads/{threadId}/summary` (POST)                        | Summarize the thread                | MCP `summarize_thread`                                       |                                                              |
| `…/threads/{threadId}/reanchor` (POST)                       | Re-pin a moved comment              | review chrome                                                |                                                              |
| `…/threads/{threadId}/answer`, `/answer/undo` (POST)         | Answer a review item                | MCP `answer_review_item`; board page                         | **Duplicate concept.** The same act on a task goes to `/api/tasks/{taskId}/review-items/{itemId}/answer`; the client picks by `item.kind`. |
| `…/threads/{threadId}/revise` (POST)                         | Revise a review item                | MCP `revise_review_item`                                     | Same duplication.                                            |
| `…/threads/{threadId}/withdraw`, `/withdraw/undo` (POST)     | Withdraw a review item              | MCP `withdraw_review_item`                                   | Same duplication.                                            |
| `…/threads/{threadId}/promote` (POST)                        | Thread becomes a task               | MCP `promote_to_task`                                        | **[G]** → `spin_off_task`. Routed separately at `server.ts:5857` so it is matched above the doc catch-all. |
| `…/threads/{threadId}/rewrite_region`, `/insert_after`, `/insert_blocks_after` (POST) | Comment-anchored edits              | MCP edit tools                                               | Snake_case sub-resources.                                    |
| `…/{docId}/find_and_replace` (POST)                          | Prose edit                          | MCP `find_and_replace`                                       | Snake_case.                                                  |
| `…/{docId}/delete_section`, `/delete_block_at_anchor`, `/delete_blocks_in_range` (POST) | Remove content                      | MCP delete tools                                             | Snake_case; `POST` used for deletes.                         |
| `…/{docId}/agent_anchors` (POST)                             | Mint an anchor                      | MCP `create_anchor`                                          | Snake_case collection.                                       |
| `…/agent_anchors/{anchorId}/edit`, `/insert_blocks` (POST), `…/{anchorId}` (DELETE) | Anchored edits and removal          | MCP `edit_at_anchor`, `insert_blocks_at_anchor`, `delete_anchor` |                                                              |
| `…/{docId}/suggestions` (GET)                                | List suggestions                    | MCP `list_suggestions`                                       |                                                              |
| `…/suggestions/{sid}/accept`, `/reject` (POST)               | Resolve one suggestion              | MCP, markup margin                                           |                                                              |
| `…/suggestions/resolve_all` (POST)                           | Resolve all                         | MCP `resolve_all_suggestions`                                | Custom verb sitting where a suggestion id goes.              |
| `…/{docId}/hooks/fire` (POST)                                | Fire doc hooks                      | agent                                                        |                                                              |
| `…/{docId}/meetings` (GET)                                   | List meetings                       | speaker voices                                               | Matched in `routes/meetings-calendar.ts`, which must run **above** the doc catch-all. |
| `…/{docId}/meetings/{meetingId}` (GET)                       | One meeting                         | speaker voices                                               |                                                              |
| `…/meetings/{meetingId}/speakers` (POST)                     | Name a speaker                      | speaker voices                                               |                                                              |
| `…/{docId}/meeting-bot` (GET, POST, DELETE)                  | Meeting-bot lifecycle               | meeting-bot client                                           |                                                              |

### 2.5 `/api/tasks/*` and `/api/goals/*` — 25 routes, none carrying a workspace

All move to `/api/workspaces/{workspaceId}/tasks/{taskId}/…`. This is the shape the owner named: *"Should be `/workspaces/{id}/tasks/{taskId}` no?"*

| Current path (methods)                                       | What it does                    | Who calls it                                                 | Notes                                                        |
| ------------------------------------------------------------ | ------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| `/api/tasks/{taskId}/transition` (POST)                      | Move the row's status           | MCP `task_transition`, board page                            | Also used for goals, which are tasks.                        |
| `…/{taskId}/title`, `/body` (POST)                           | Edit the story text             | MCP `rewrite_task`                                           | One tool, two calls.                                         |
| `…/{taskId}/assignee`, `/due`, `/goal`, `/after` (POST)      | Field writes                    | MCP `assign_task`, `set_task_goal`, `set_task_dependencies`; board page |                                                              |
| `…/{taskId}/park` (POST)                                     | Move to triage with a note      | MCP `park_task`                                              | **[G]** → `block_task` per Decision 7.                       |
| `…/{taskId}/archive`, `/restore` (POST)                      | Soft delete and restore         | MCP `archive_task`, `unarchive_task`                         |                                                              |
| `…/{taskId}/evidence` (POST)                                 | Attach completion evidence      | agent                                                        |                                                              |
| `…/{taskId}/links` (GET, POST, DELETE)                       | External refs                   | MCP `link_refs`, `unlink_refs`                               |                                                              |
| `…/{taskId}/notes` (POST)                                    | Activity-tab status note        | MCP `post_status`                                            |                                                              |
| `…/{taskId}/answer`, `/answer/undo` (POST)                   | Answer a legacy decision        | MCP `answer_decision`; board page                            |                                                              |
| `…/{taskId}/more-info` (POST)                                | Ask for more information        | MCP `request_more_info`                                      |                                                              |
| `…/{taskId}/review-items` (POST)                             | File a review item              | MCP `add_review_item`                                        |                                                              |
| `…/review-items/{itemId}/answer`, `/more-info`, `/release`, `/revise`, `/withdraw`, `/withdraw/undo` (POST) | Review-item lifecycle           | MCP, board page                                              | **Duplicate concept.** Doc-anchored review items use `/api/docs/{docId}/threads/{threadId}/…` for the same six verbs. |
| `/api/goals/{goalId}/cascade` (GET)                          | Goal roll-up                    | board page                                                   | A goal is a task, addressed under a third prefix.            |
| `/api/goals/{goalId}/archive`, `/restore` (POST)             | Goal lifecycle                  | board page                                                   | Goal verbs are spread over four prefixes: `/api/goals/*`, `/api/tasks/{goalId}/transition`, `/api/workspaces/{id}/goals/*`, and threads under `/api/docs/task:{goalId}/`. |
| `/api/review-items/{reviewItemId}` (GET)                     | Resolve item → task + workspace | MCP `set_review_item_criteria`, `request_more_info`          | Exists **because** ids carry no workspace: `tasks.ts:145` round-trips a bare item id to learn which board judges it. This route is the lookup the move deletes. |

### 2.6 `/api/reviews/*` and `/api/diffs` — 13 routes, the attachment set **[G]**

Glossary target: `/api/workspaces/{workspaceId}/attachments/…`. Subject to Decision 1, because that path is taken.

| Current path (methods)                            | What it does                          | Who calls it                             | Notes                                                        |
| ------------------------------------------------- | ------------------------------------- | ---------------------------------------- | ------------------------------------------------------------ |
| `POST /api/diffs`                                 | Build a diff review                   | MCP `create_diff_review`                 | Workspace in the **BODY** as `hubWorkspaceId`. Handled in `workspaces-create-read.ts` despite the path. |
| `GET /api/reviews/archived`                       | List archived sets and docs           | board page                               | **No workspace at all** — reads across every board.          |
| `DELETE /api/reviews/{setId}`                     | Archive, or purge with `?purge&force` | MCP `delete_review`                      | `REVIEW_DELETE` at `server.ts:1022`.                         |
| `POST /api/reviews/{setId}/archive`, `/unarchive` | Soft delete and restore               | MCP `archive_review`, `unarchive_review` |                                                              |
| `GET …/{setId}/threads`                           | All threads across the set's files    | board page                               | **Dual-prefix alias.**                                       |
| `GET …/{setId}/grouped`                           | Grouped diff model                    | board page                               | **Dual-prefix alias.**                                       |
| `POST …/{setId}/refresh`                          | Re-diff against the tree              | MCP `refresh_review`                     | **Dual-prefix alias.**                                       |
| `POST …/{setId}/groups`                           | Set file grouping                     | MCP `set_review_groups`                  | **Dual-prefix alias.**                                       |
| `GET …/{setId}/files`                             | List repo files                       | board page                               | **Dual-prefix alias.**                                       |
| `GET …/{setId}/tree`                              | File tree                             | board page                               | **Dual-prefix alias.**                                       |
| `POST …/{setId}/context-file`                     | Open a read-only sibling file         | board page                               | **Dual-prefix alias.** File addressed by `relPath` in the body. |
| `POST …/{setId}/editable-file`                    | Open a companion editable doc         | redline app                              | **Dual-prefix alias.** Same body addressing.                 |

The eight aliased rows are one regex, `reviewApi()` at `server.ts:1009`: `^/api/(?:reviews|workspaces)/([^/]+)/<sub>$`. **It is the existing precedent for surviving a route move**, added for plugin bundles nobody can restart and tabs already open.

### 2.7 The one route the plugin hooks call

| Current path            | What it does                        | Who calls it                                | Canonical replacement | Notes                                                        |
| ----------------------- | ----------------------------------- | ------------------------------------------- | --------------------- | ------------------------------------------------------------ |
| `POST /api/agent-notes` | Post a note; server infers the task | `stop-note.ts`, `permission-denied-note.ts` | unchanged             | The hook has no doc, task or workspace id. It sends `cwd` and the server resolves. Stays top-level. `hooks/lib/agent-notes.ts:48` falls back to a hardcoded `http://localhost:8787`. |

### 2.8 What breaks per named MCP tool

Every MCP call goes through one helper, `http()` at `packages/mcp/src/mcp.ts:1380`.

| Family                                                | Named tools whose path moves                                 |
| ----------------------------------------------------- | ------------------------------------------------------------ |
| Doc reads and edits                                   | `get_doc`, `set_doc_content`, `find_and_replace`, `edit_at_anchor`, `delete_section`, +12 more |
| Threads                                               | `create_thread`, `post_reply`, `resolve_thread`, `get_thread`, `summarize_thread`, +6 more |
| Review items                                          | `add_review_item`, `answer_review_item`, `revise_review_item`, `withdraw_review_item`, `request_more_info` |
| Tasks                                                 | `task_transition`, `assign_task`, `rewrite_task`, `park_task`, `set_task_goal`, +5 more |
| Attachment sets                                       | `create_diff_review`, `archive_review`, `refresh_review`, `set_review_groups`, `delete_review` |
| **Unaffected** (already under `/api/workspaces/{id}`) | `create_workspace`, `list_tasks`, `next_tasks`, `create_tasks`, `attach_agent`, `heartbeat`, `set_goal_list`, `set_workspace_lead` |

### 2.9 Notes on odd routes

- **`POST /api/links/titles`** takes whole workspace URLs in the body and

  returns titles and statuses. It is a body-addressed read across arbitrary boards, and no middleware can scope it from the path.
- **`GET /api/workspaces/{id}/home?user=`** puts identity in the query string

  on an authenticated route.
- **Custom verbs** already exist and do not follow the guide's `:verb` syntax:

  `/rename`, `/reorder`, `/add`, `/refresh`, `/resolve_all`, `/import-tasks`, `/reparse_from_disk`. Recommendation in §4.
- **Snake_case sub-resources** appear only under `/api/docs/{docId}`:

  `by_find`, `find_and_replace`, `agent_anchors`, `insert_blocks_after`, `rewrite_region`, `delete_blocks_in_range`. Everything else is kebab-case.
- **Two client paths for one act.** Answering a review item goes to a doc

  thread or to a task review item, chosen by `item.kind` in `hub-review-model.ts:747` and `:757`. One canonical shape would let one path serve both.
- **`/widget.js` is a byte alias** of `/widget.esm.js`.
- **Order-sensitive spots** that a route move must preserve:

  `POST /recall/status` above the `/recall/` WebSocket upgrade; `/events/workspace/{id}` above the `/events/` prefix; `/api/docs/{id}/(un)archive` outside the doc block, which 404s without a room; all `/api/docs/{id}/meetings…` above the doc catch-all; `/workspaces/…` matches above the `/review/` compat block.

---

## 3. Counts

|                                                            | Count   |
| ---------------------------------------------------------- | ------- |
| Routes total (distinct path patterns, methods multiplexed) | **184** |
| Already canonical (workspace is the first path variable)   | **35**  |
| Legitimately top-level, never move                         | **52**  |
| Need a move                                                | **97**  |

Breakdown of the 97:

|                                                              | Count |
| ------------------------------------------------------------ | ----- |
| Workspace resolvable by server lookup from a doc, task, goal or set id | 91    |
| Workspace carried in the request **body** (`POST /api/docs`, `POST /api/diffs`) | 2     |
| Workspace carried in the **query string** (`GET /api/docs`, `POST /api/refs/backlinks` by ref) | 2     |
| Workspace in a path segment that is not under `/workspaces` (`/events/workspace/{id}`) | 1     |
| No single workspace at all (`GET /api/reviews/archived`)     | 1     |

The middleware covers none of the 97 today. The 91 become free once the id is in the path. The other six need a decision each, not just a move.

---

## 4. Decisions for the owner

1. **`/workspaces/{id}/attachments` is already taken by attached AGENTS**, so

  the glossary's `/api/reviews` → attachments cannot land as written — I recommend agents move to `/workspaces/{id}/agents` and attachments takes the glossary noun, since "attachment" is the product word and "agents" is the plainer one for the thing being displaced.
2. **`/events/workspace/{id}` and `/api/workspaces/{id}/events` are two

  different things sharing a name** (live SSE stream versus the activity feed) — I recommend the stream becomes `/api/workspaces/{id}/events:stream` or `…/event-stream` and the feed keeps `events`, because the feed is the one the board page and the glossary already call Activity.
3. **A doc-id-only route can find its workspace either by putting it in the

  path or by keeping the server-side lookup** — I recommend the path, because the lookup is the only reason `GET /api/review-items/{id}` exists and the whole point of the move is that one middleware resolves access once.
4. **MCP-backed REST can keep the `/api` prefix or drop it now that pages and

  data share a path shape** — **decided 2026-09-03: drop it.** One path, `/workspaces/{id}/…`, answers HTML by default and JSON with `?format=json`. Security review consequence: `shareScopeAllows` allowlists by path prefix, so the share allowlist is re-derived for the merged shape before the cutover PR opens, and no route is left without a named gate.
5. **Old paths can redirect, 410, or answer forever** — **decided 2026-09-03: no old-path support.** Not

  redirects, not 410s, not the dual-prefix alias: the old paths are deleted in the cutover PR and every caller updates at once (bookmarks and URLs pasted into durable comment bodies will break, accepted). The MCP bundle is rebuilt in the same PR with a plugin version bump, and every attached session restarts after the deploy, because a session on the old bundle calls paths that no longer exist; the existing reviewApi dual-prefix alias goes too.

---

## 5. Suggested PR groups, in order

Runs after the current file-split lanes land, and rides with the naming lane.

1. **Names only, no routes move.** Land the glossary renames that the route

  shape depends on: `review` → `attachment`, `retire` → `archive`, huddle → plan / meeting notes, so the route lane has stable destinations.
2. **Resolve the two collisions.** Move attached agents off `attachments` and

  the SSE stream off `events`, before anything else claims those names.
3. The cutover, one PR. Add one workspace-resolving middleware and

  answer `/workspaces/{id}/<collection>/{id}` for every doc, task, goal and attachment-set route (HTML by default, JSON with `?format=json`); client, widget, MCP source, hooks and skills all emit the new paths; the MCP bundle is rebuilt and committed with a plugin version bump; the old paths are deleted in the same diff. Deploy, then every attached session restarts.
4. Folded into 3. The callers move inside the cutover diff, because nothing

  answers the old paths once it lands.
5. **Move the six that need more than a path change.** Body and query workspace

  ids into the path, `GET /api/reviews/archived` scoped or explicitly declared cross-board, and `/api/review-items/{id}` deleted once nothing needs it.
6. Nothing to retire. The old paths left in 3: no redirect, no 410, and the

  `reviewApi` dual-prefix alias family goes with them.

---

## Appendix: grep commands and hit counts

Run from `/Volumes/Data/Users/bryanchan/dev/claude-live-feedback-plugin/.claude/worktrees/route-inventory`.

| Command                                                      | Hits                                |
| ------------------------------------------------------------ | ----------------------------------- |
| `grep -rhoE "pathname === '[^']+'" packages/server/src \| sort -u` | 44                                  |
| `grep -rhoE "pathname\.startsWith\('[^']+'" packages/server/src \| sort -u` | 16                                  |
| `grep -rhoE "'/[a-zA-Z0-9_.:/?=&{}\$-]*'" packages/server/src \| sort -u` | 92                                  |
| `grep -rn "url\.pathname" packages/server/src`               | 3                                   |
| `grep -nE "pathname\|method ===\|endsWith\|startsWith\|\.match\(" packages/server/src/routes/*.ts` | 23 files, all sub-routes enumerated |
| `grep -nE "pathname === \|pathname\.startsWith\(\|pathname\.match\(\|pathname\.slice\(\|rest === " packages/server/src/server.ts` | 46                                  |
| `grep -rhoE "(rest\|threadRest) === '[^']+'" packages/server/src/routes/docs.ts` | 32                                  |
| `grep -rn "REVIEW_API\|REVIEW_DELETE" packages/server/src`   | 12                                  |
| `grep -rn "fetch(" packages/markdown-app/src packages/widget/src` | 45                                  |
| `grep -rn "/api/" packages/markdown-app/src packages/widget/src` | 135                                 |
| `grep -rn "new EventSource(" packages/markdown-app/src packages/widget/src` | 5                                   |
| `grep -rn "new WebSocket(" packages/markdown-app/src packages/widget/src` | 1                                   |
| `grep -rn "location.href\|location.assign\|pushState\|replaceState" packages/markdown-app/src packages/widget/src` | 36                                  |
| `grep -rcE 'http\(' packages/mcp/src`                        | 115                                 |
| `grep -rcE 'fetch\(' packages/mcp/src`                       | 2                                   |
| `grep -rnE 'fetch\(\|curl\|http://\|BASE_URL' packages/plugin/hooks` | 11                                  |
| `grep -rnE 'curl\|http://\|/api/\|/review/\|/events/' packages/plugin/skills` | 8                                   |
| same over `packages/plugin/commands`                         | 6                                   |

### Hits that are not routes

- `'/Applications/Tailscale.app/…'`, `'/bin/launchctl'`, `'/opt/homebrew/bin/claude'`,

  `'/usr/bin/claude'`, `'/usr/local/bin/tailscale'` — executable paths, not URLs.
- `'/rooms.ts'` — a source filename in a comment.
- `'/v1/bot/'` — a path on the Recall.ai vendor API, outbound not inbound.
- `'/answer'`, `'/comments'`, `'/resolve'`, `'/insert_blocks'`, `'/undo'` and the

  other bare suffixes — template fragments of rows already in §2.4.
- `` `/g `` — a regex flag in `hooks/lib/note-redact.ts:55`.
- `/api/docs//threads`, `/api/docs/undefined/`, `/workspaces/undefined`,

  `/api/workspaces//tasks` — comments describing past empty-id bugs.
- `/Volumes/Data/Users/…` — prose in code comments.
- `'/favicon.ico'` — allowlisted in `middleware/host-guard.ts:478` but has **no

  handler**; it falls through to the catch-all 404.

### Grep caveat worth recording

The character class `[a-zA-Z0-9_./{}$-]` silently drops hyphenated paths, because the trailing `-` reads as a range. Unescaped it hides `/api/agent-notes` and `/api/chat-audit` — including the only route the plugin hooks call. Run it as `[a-zA-Z0-9_./{}$\-]`. The counts above use the escaped form.
