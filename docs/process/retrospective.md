# Retrospective Log

Per-session retros. Format:

```
## YYYY-MM-DD - Topic
**What worked:** ...
**What didn't:** ...
**Action:** ...
```

(empty — populate as we go)

## 2026-08-04 - Identity + redline balloons (Phase 1) + suggested edits (Phase 2)

### Time Breakdown
| Started | Phase | 👤 Hands-On Time | 🤖 Agent Time | Problems |
|---------|-------|-----------------|---------------|----------|
| Aug 3 6:23pm | Ship wrap-up: merges #75-77, deploys, balloon plan iterations | ██ 20m | ███ 30m | |
| Aug 3 9:48pm | Plans + identity feature (TDD, 2 reviews, PR #78) | ██ 22m | █████ 50m | ⚠ 1 blocking finding (?as= rebrand) |
| Aug 3 10:08pm | Phase 1 balloons workflow (9 agents) ∥ identity ship/deploy | █ 12m | ███████▌ 74m | ⚠ 2 workflow blockers + 1 Codex P1, fixed |
| Aug 3 11:44pm | Phase 1 verify → main merge → PR #79 → deploy | █ 8m | ███ 30m | ⚠ styles.css EOF-append conflict |
| Aug 4 12:51am | Phase 2 suggestions workflow (9 agents) + tunnel investigation | █ 10m | ███████████ 110m | ⚠ 3 workflow blockers + 2 Codex findings, fixed |
| Aug 4 5:30am | Phase 2 ship/deploy, fleet coordination, suggest-mode norm | █ 12m | ██ 20m | ⚠ announcement framing → peer planned suggest-by-default |

### Metrics
| Metric | Duration |
|--------|----------|
| Total wall-clock | ~11.6 h |
| Hands-on | ~1.4 h (12%) |
| Automated agent time | ~5.2 h (45%) |
| Idle/testing/away | ~5 h (43%) |
| Retro analysis time | ~10 min |

### Key Observations
- The workflow recipe (sequential TDD commits → 3-lens review → external Codex → orchestrator re-verification) caught 8 real bugs pre-merge across two features; review layers disagreed in useful ways — redundancy is the feature.
- Both avoidable frictions were orchestrator-side: announcement framing that read as "suggest-mode is the new default", and planning against a peer's stale summary as if it were live status.
- Third re-explanation of the bound-doc sync contract to a peer → promoted to learnings as the canonical answer.

### Feedback
**What worked:** "Build went well with minimal spec and hands-on time."
**What didn't:** Result quality not yet assessed — Bryan will send feedback after hands-on review (real-browser Suggesting mode + 430px checks still pending).

### Actions Taken
| Issue | Action Type | Change |
|-------|-------------|--------|
| Bound-doc sync semantics re-explained 3× | Doc | learnings.md: "Bound-doc sync contract" entry |
| Workflow recipe worth reusing; styles.css append conflict | Doc | learnings.md: "Multi-agent workflow implementation" entry |
| gh pr merge --delete-branch silently switches branch | Doc | learnings.md: entry |
| Lost disk writes only discoverable by polling syncError | Ticket (deferred) | Backlog noted in learnings — syncError event on watch channel; no Linear access this session |
| Peers treated suggest-mode as new default | No repo action | Corrected in-channel; saved to agent memory; rules edit left to Bryan (user-edited only) |
