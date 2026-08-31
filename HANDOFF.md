# HANDOFF — PR #490 `auth-write-gate`, round-2 fixes

Written mid-flight because the session is being restarted. Everything below
is either done and verified, or named as the exact next step.

**Commit `64fe422d` holds all the round-2 code and tests.** Nothing is
half-applied. This file is committed separately and **must be deleted before
the PR is finished** — `git rm HANDOFF.md`.

## State: DONE and verified

All three ordered items from the round-3 review are fixed, and the two
"your judgement" ones are decided.

1. **Boot hang (flag-independent).** `fetchWriteAccess` now races a
   `WRITE_ACCESS_LOOKUP_MS = 4000` timeout and fails open, matching
   `identity-prompt.ts`'s `SESSION_LOOKUP_MS`.
2. **Companion never opened for a signed-out reader.** Server exempts
   `POST /api/(reviews|workspaces)/<id>/(editable-file|context-file)` under
   its own predicate `OPEN_FOR_READING_POST` (NOT added to
   `READ_SHAPED_POSTS` — different contract). The wrong code comment on
   `editable: ctx.canWrite` is rewritten.
3. **Blocking modal on plain load.** The companion POST is wrapped in
   `asBackgroundWrite`. Fixing 2 alone would NOT have fixed this — checked,
   not assumed: the marker is still what keeps any other 401 (older server,
   lapsed share) from interrupting a reader.
4. **(judgement: FIXED)** `lockDocToReading` now owns the Reading crumb and
   the blanked `#save-state` too, and the redline + code surfaces call it.
5. **(judgement: FILED, not fixed)** 430px board task-detail panel covers the
   viewport so the sign-in bar is off-screen. It is a mobile-layout
   interaction outside the gate, and the board's refused writes already fail
   visibly via `revertToServerTruth`. Reasoning belongs in the report.

## Gates — three of four green, on commit `64fe422d`

- `bun run typecheck` — clean.
- `bun run lint` — clean (2 pre-existing `noExplicitAny` warnings only).
- `bunx vitest run` — 236 files / 3504 tests pass.
- `bun test packages/server/test` — **3605 pass / 0 fail** on the third run.
  Run 1 had 1 fail; run 2 and run 3 were clean. The known flakes on this repo
  are `doc-eviction` and `dispatch-registry`; both pass in isolation. Treat a
  single red as flake ONLY after re-running it alone.

## Still to do — the exact next steps, in order

1. `bun run check:widget-size` — not yet run. Report bytes and headroom
   against 40,960 B. (The diff touches no widget source, so it should be
   unchanged, but it has not been measured.)
2. `codex review --base origin/main` — **not run**. Address real findings.
   Known from round 1 and deliberately NOT fixed: a codex P1 about websocket
   write authorization being fixed at handshake — file it, do not fix it.
3. `python3 scripts/scrub-selftest.py` FIRST (the control that the scanner can
   see), then `python3 scripts/scrub-check.py --diff-range origin/main...HEAD`.
   Run with `set -o pipefail` and read the SCANNER's exit code, not `tail`'s.
   Never bypass the leak gate.
4. `git rm HANDOFF.md` and amend/commit.
5. Push to `auth-write-gate`. **Do not merge.** Do not bump any version — the
   diff touches neither `packages/plugin/**` nor `packages/mcp/src/**`.
6. Write the full report to the scratchpad dir; final message is a file path
   and a byte count only.

## Ruled out — do not spend time rediscovering these

- **`READ_SHAPED_POSTS` is the wrong home for the exemption.** Its documented
  contract is "confirmed to mutate nothing"; `editable-file` creates a room.
  A separate regex predicate with its own justification is deliberate.
- **An `AbortController` on the session lookup is wrong.** Aborting makes the
  answer unavailable to everything else that awaits it. `Promise.race` with a
  non-rejecting lookup is why the race itself cannot reject.
- **`GET /api/auth/session` answers `canWrite: true` to `curl`.** That is
  correct — it mirrors `isBrowserRequest`, so agents stay outside the gate. A
  reviewer curling it will misread the gate as off. Use a real browser.
- **The rig's doc surface will not mount unless localStorage has
  `feedback-user-name`.** The identity prompt blocks the mount on EVERY build,
  `origin/main` included. Two hours were nearly lost to reading this as a
  code regression. Seed
  `localStorage.setItem('feedback-user-name', 'Rig Reader')` via
  `Page.addScriptToEvaluateOnNewDocument` before any app script.
- **zsh applies history modifiers inside `"$VAR:edit"`.** `$RID:edit` becomes
  `${RID:e}` + `dit` and silently produces a wrong docId. Always brace it:
  `"${RID}:edit:notes.md"`.
- **`bun run staging` accepts `--port` and `--data-dir`**, so several branches
  can run side by side from separate worktrees. Prod on :8787 must never be
  touched and no pattern kills — kill by the PID you started.

## The measurements already taken (do not redo)

Headless Chrome over CDP, throwaway profile, never Bryan's browser. Rigs live
in the session scratchpad under `rig/` (`hang.ts`, `probe.ts`, `type.ts`,
`net.ts`) — they are gone with the scratchpad if it is cleaned.

**Item 1, paired, `/api/auth/session` intercepted and never continued
(`paused` is asserted non-zero, so the interception is proven to have caught
the route):**

| build | normal load | session route hung |
|---|---|---|
| pre-fix `22333c77` (:8791) | 2 `.ProseMirror` | **0 at 15 s AND at 25 s** |
| `origin/main` (:8790) | 2 | 2 |
| this branch (:8788) | 2 | **2 — recovered** |

Same result at 430px: pre-fix 0, branch 2. Flag OFF on all three, which is
the point — the hang was never about the gate.

**Items 2 / 2c / 3, gate ON (:8789), signed-out vs a genuinely signed-in
control (real `/api/auth/start` → code from the log → `/api/auth/verify`):**

Redline surface, `notes.md` diff member, 1180x820 and 430px:
signed-out gets `.markup-margin` present, `contenteditable="false"`,
`threadIds: ["033ytwd6gwzb"]` — the **companion's** thread, the identical id
the signed-in control sees, and NOT the member's thread. Crumb reads
"Reading:", `#save-state` empty, both toggles disabled, sign-in bar present,
**no modal**. Signed-in on the same URL: `contenteditable="true"`, crumb
"Editing:", "All changes saved", toggles live, no bar.

The `.md` File view (seed `lf-view-mode:<memberDocId>` = `file`) and the code
member `calc.ts` behave the same way in both directions.

**No over-gating:** signed-in typing reached
`/private/tmp/cw-r2-repo-a/notes.md` on disk (`ZZSIGNEDINTYPED`); the
signed-out attempt never entered the DOM and never reached disk
(`XXSHOULDNOTSTICK`, count 0).

**Both new tests were mutation-tested and both bite:** removing
`OPEN_FOR_READING_POST` from `isReadShapedPost` turns the new over-the-wire
test's 200 into a 401; removing `asBackgroundWrite` from `openCompanionDoc`
makes the new client test see the modal.

## Environment left behind

Four staging servers were started for this and are being killed by PID now;
prod on :8787 is untouched and answering. Two throwaway control worktrees
exist at `/private/tmp/cw-ctl-main` (origin/main) and `/private/tmp/cw-ctl-pre`
(`22333c77`), plus a fixture git repo at `/private/tmp/cw-r2-repo-a`. Remove
them with `git worktree remove --force` when the verification is no longer
needed.

## One residual check I would run first

The pre-fix control server was started on **:8791, which an unrelated local
`receiver.ts` (PID 1321, started 08:49) also listens on** — it binds
`127.0.0.1:8791` while staging binds `0.0.0.0:8791`, so both coexisted and I
did not notice until shutdown. I did **not** kill 1321; it is not mine.

The measurement almost certainly stands: on that same port the *open* run
rendered the document with 2 `.ProseMirror` and the crumb showing my own
`hang.md` path, so both runs were served by the claude-workspaces staging
build, and only the hang flipped the result. But a positive control on a
contended port is worth ten minutes: re-run the pre-fix pair on a port
nothing else holds (check `lsof -nP -iTCP:<port> -sTCP:LISTEN` first) and
confirm hung → 0 `.ProseMirror`, open → 2. If it does not reproduce, the
whole item-1 claim needs redoing before the PR goes out.
