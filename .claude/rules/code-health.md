# Code health

The bars this repo holds without being asked, and the command that enforces
each. Nothing here is advice: every line is either a gate that fails, or a
named gap.

## File size: 500 lines

Every `.ts` / `.css` file over 500 lines is split, or has a row in
[docs/architecture/exceptions.md](../../docs/architecture/exceptions.md)
naming a verdict and a reason. A `Split` row is queued work and still passes —
the gate exists so a **new** god file cannot appear with nobody having written
down why.

*Enforced by:* `bun run loc:audit` (CI).

## Tests assert behaviour

Behaviour not source shape, poll-until not fixed sleeps, no wall-clock
assertions, a unit test with every new server module, headless browsers only.
The bars and the check behind each are
[.claude/rules/testing-standards.md](testing-standards.md) — read them there;
they are not restated here.

*Enforced by:* `bun run test:audit` (ratcheted, CI) — one member of
`bun run verify`, which runs it alongside every other gate CI runs.

## A route lives in `routes/`

**A module belongs under `packages/server/src/routes/` when it decides which
URL paths it answers.** It reads a pathname, claims some set of paths, and
returns a `Response` for a path it claims — or `null` / `undefined` to decline
so the caller's chain continues. If it names a URL path, that is where it
goes, whatever it does with the path afterwards: `routes/upgrade-stream.ts`
takes the connection over rather than answering it, and is still a route,
because a new websocket path is chosen there and nowhere else.

**A module stays directly under `packages/server/src/` when it runs for a
request whatever path it named** — admission, attribution, compression, the
socket lifecycle — **or when it never sees a `Request` at all**: HTML
renderers, model builders, stores, adapters. None of those can be sorted into
a route family, because they are not about one.

Two consequences, and they are the ones that were being got wrong:

- **`server.ts` matches no route itself.** It composes and delegates. A family
  matched inline there is a family living in the second home this rule exists
  to close; extract it, called from the position its block held so nothing
  overtakes anything, and say in the PR body where order was load-bearing.
- **Imports point one way: `server.ts` → `routes/` → everything else.** No
  module under `routes/` imports `server.ts` (`ServerOptions` is in
  `server-options.ts` for exactly this reason), and no module outside
  `routes/` imports out of it — `server.ts` is the single exception, because
  it is the router. A shared name that both a route and a service need lives
  with the service, and the route's context module re-exports it:
  `review-gate-types.ts` holds the two gate verdicts for that reason.

Inside `routes/`, one family per file, and the shared vocabulary of a family —
its context interface, its per-request shape, the parsers more than one of its
modules calls — lives in a `*-routes-context.ts` beside them, never in the
entry point that calls them. `task-routes-context.ts` and
`docs-routes-context.ts` are the two to copy.

*Enforced by:* `bun run check:imports` (CI) for the import direction; the rest
is read by the reviewer.

## The architecture map is current

A PR that adds, removes or moves a **top-level module** — a file or a
directory sitting directly in `packages/<pkg>/src/` — updates
[docs/architecture/overview.md](../../docs/architecture/overview.md) in the
same PR. A file added *inside* a directory the diagram already draws is not
one: the overview draws `routes/`, not its handlers.

The gate checks that the doc changed, not that it names the module — the
overview groups modules into subsystems and uses globs, so a name-matching
check would demand a shape the doc deliberately does not have. If the module
genuinely does not change the picture, say so in a line of the subsystem it
joined, so the next reader knows it was considered rather than missed.

*Enforced by:* `bun run check:architecture` (CI).

## Strict types

`tsconfig.base.json` is `strict`, plus `noUnusedLocals`, `noUnusedParameters`,
`noImplicitReturns`, `noFallthroughCasesInSwitch` and `noImplicitOverride`
(a method that overrides says `override`). `any` is a lint
**error**, not a warning, and so is an unused import — the repo sits at zero
of both, so a new one is yours. A cast you genuinely cannot avoid takes
`// biome-ignore lint/suspicious/noExplicitAny: <reason>`; the reason is the
point of the escape hatch.

**Not enforced:** `noUncheckedIndexedAccess` (556 errors today) and
`exactOptionalPropertyTypes` (306) are off. Indexing an array or a record
still hands you a value the compiler swears is defined. Check it yourself.

*Enforced by:* `bun run typecheck`, `bun run lint`.

## Security review

A diff that adds or changes a route, a token or signing scheme, a share
surface, a webhook, or an auth default answers the seven-heading checklist in
[.claude/rules/security-review.md](security-review.md) **in the PR body**,
before the PR opens. An unanswered heading blocks the merge.

*Enforced by:* the merging lead reading the PR body; `ship-it` derives the
trigger from the changed-file list.
