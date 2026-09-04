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

*Enforced by:* `bun run test:audit` (ratcheted, CI), on top of the four gates.

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
