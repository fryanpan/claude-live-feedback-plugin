# Local Workflow Facts

How to work in general — autonomy and the decision framework, planning,
implementation, verification, batching inbound PR feedback, hive etiquette,
security posture, public-content scrubbing, capturing learnings — comes from the
`team-lead-fleet` rules that are injected into every session on this machine.
This repo used to keep its own forks of five of those; they had all drifted into
stale paraphrases, so four were deleted (`security-posture.md` still sits beside
this file only because tooling would not let it be removed). What follows is the
residue that is true of THIS repo and nowhere else.

- **This project's ship skill is `ship-it`**, not the fleet default `ship-auto`.
  It runs the code review, opens the PR, and follows CI and Copilot. Invoke it
  once implementation is done and the four gates in `CLAUDE.md` pass, before
  handing control back.
- **The multi-agent recipe that actually worked here is written down.** Grep
  `docs/process/learnings.md` for "Multi-agent workflow implementation" before
  fanning a plan out with the `Workflow` tool. It carries the shape that shipped
  two features (one persistent worktree, sequential TDD implement-agents chained
  by structured results, parallel review lenses tailored to the feature's risks,
  a verify-then-fix agent) and the finding that an independent `codex review`
  afterwards still caught bugs every lens had passed.
- **Board work has its own two rules files.** How to run a task, keep rows
  current and ask for review is in `workspace-board.md`; which surface a doc or
  dev server gets bound to is in `workspaces-default.md`. Neither has a fleet
  twin.
