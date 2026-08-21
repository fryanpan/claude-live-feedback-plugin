/**
 * The skills are how the fleet learns that declaring once is enough.
 *
 * The tool descriptions changed in the earlier commits of this branch, but a
 * tool description is read at the moment a tool is about to be called — and
 * the whole point of this ticket is that an agent never thinks to call
 * anything, because silence from a subscription it never made is
 * indistinguishable from nobody having commented. The skills are the surface
 * that is read at SESSION START, before the mistake, so they are where the
 * one-declaration instruction has to live.
 *
 * These are content assertions on shipped SKILL.md files, in the spirit of
 * plugin-version-reported.test.ts: the artifact peers install is the file, so
 * the file is what gets pinned. Each assertion names a sentence the incident
 * would have needed; the controls at the bottom pin the guidance that must
 * SURVIVE the edit, because the realistic failure of a doc change is not a
 * missing addition but a rewrite that quietly drops what was already there.
 *
 * SHAPE NOTE (2026-08-21): the lead skill is Bryan-authored and deliberately
 * minimal — four sections, ~45 lines. The operational liveness material
 * (heartbeat, watch_doc-does-not-stand-in, lead-held/takeover, the quiet-board
 * probe) now lives ONLY in the hub skill, so those assertions run on the hub
 * alone. The lead skill states the seat CONTRACT instead: one bare call,
 * covers surfaces created later, and events queue across a disconnect — which
 * is the durable-queue model the server now implements. The negative guards
 * (the old wrong delivery claims) still run against all three files, because
 * a wrong sentence can come back anywhere.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS = join(HERE, '../../plugin/skills');
const HUB = readFileSync(join(SKILLS, 'running-a-workspace-hub/SKILL.md'), 'utf8');
const LEAD = readFileSync(join(SKILLS, 'leading-a-workspace/SKILL.md'), 'utf8');
const GENERAL = readFileSync(join(SKILLS, 'working-in-a-workspace/SKILL.md'), 'utf8');

/**
 * One line, lower-cased. Every assertion below that searches for a PHRASE runs
 * against this rather than the raw file.
 *
 * These SKILL.md files are hard-wrapped at ~76 columns, so a multi-word search
 * only matches when the wrap happens not to have landed inside it — and where
 * the wrap lands is decided by an unrelated edit three sentences earlier. That
 * is survivable for a positive assertion, which goes loudly red. It is not
 * survivable for a `not.toMatch`, which goes quietly GREEN: it reports the
 * banned sentence as absent from the file that contains it.
 *
 * This is not hypothetical. At ecaf378, the last commit before the delivery
 * claim was corrected, both skills carried "Delivery is gated on a heartbeat
 * inside the ~5-minute window" and `not.toMatch(/gated on a heartbeat/)` fired
 * on exactly one of them — the other file's line break fell between `a` and
 * `heartbeat`. Collapsing the whitespace removes the coin flip.
 *
 * Structural assertions (`/^## …$/m`, frontmatter) keep using the raw text —
 * they are ABOUT line boundaries, and flattening would destroy what they check.
 */
const flatten = (s: string): string => s.replace(/\s+/g, ' ').toLowerCase();

const ALL: Array<[string, string, string]> = [
  ['running-a-workspace-hub', HUB, flatten(HUB)],
  ['leading-a-workspace', LEAD, flatten(LEAD)],
  ['working-in-a-workspace', GENERAL, flatten(GENERAL)],
];

describe('the hub skill teaches one declaration per session', () => {
  it('names the bare one-argument declaration', () => {
    // `set_workspace_lead(workspaceId)` with nothing else — the form that
    // attaches, subscribes and drains. An agent that reads the two-arg
    // handover form first will assume it needs an id it does not have.
    expect(HUB).toMatch(/set_workspace_lead\(workspaceId\)/);
  });

  it('says the declaration covers surfaces created later', () => {
    expect(flatten(HUB)).toMatch(/created later/);
  });

  it('says it survives a respawn without being redone', () => {
    expect(flatten(HUB)).toMatch(/respawn|restart/);
    expect(flatten(HUB)).toMatch(/survives|re-?wire|restore|persist/);
  });

  it('demotes watch_doc — it is for docs outside your board, not a stand-in', () => {
    expect(flatten(HUB)).toMatch(/outside|does not stand in/);
    expect(HUB).toMatch(/watch_doc/);
  });

  it('names list_watched_docs as the way to check coverage', () => {
    expect(HUB).toMatch(/list_watched_docs/);
  });

  it('gives the reader a probe for a board that feels quiet', () => {
    // The exact reading the incident needed and nobody had: a peer that
    // believed it was listening had no way to ask.
    expect(HUB).toMatch(/unattachedBoards|coverage/);
    expect(flatten(HUB)).toMatch(/quiet/);
  });

  it('says a declaration does not keep you live, and names OBSERVED WORK as the gate', () => {
    // The gap the skill-split created: one call now covers every surface, so
    // "I declared" reads as "I am covered" — while an attachment lapses
    // unless the server keeps seeing the session.
    //
    // The rule encoded here: HEARTBEAT_FRESH_MS (~5 min) feeds the DISPLAYED
    // away label; delivery rides the observed clock,
    // `max(lastHeartbeat, lastToolCallAt)`. So a ~5-minute claim about
    // display is fine and a heartbeat-window claim about DELIVERY is not,
    // and only the second is banned (in the ALL loop below).
    expect(HUB).toMatch(/heartbeat\(workspaceId\)/);
    // Positive: the delivery gate is named as BOTH signals, not one.
    expect(flatten(HUB)).toMatch(/a heartbeat or a tool call|a tool call or a heartbeat/);
  });

  it('teaches the repair path without leaving the heartbeat behind', () => {
    expect(HUB).toMatch(/attach_agent\(workspaceId\)/);
    expect(HUB).toMatch(/set_workspace_lead\(workspaceId\)/);
    expect(HUB).toMatch(/heartbeat\(workspaceId\)/);
  });

  it('says declaring will not displace a live lead, and names the override', () => {
    expect(HUB).toMatch(/lead-held/);
    expect(HUB).toMatch(/takeover/);
  });
});

describe('the wrong delivery claims cannot come back in any skill', () => {
  for (const [name, , flat] of ALL) {
    it(`${name} does not claim delivery is gated on a heartbeat window`, () => {
      // Reverting any skill to "Delivery is gated on a heartbeat inside the
      // ~5-minute window" goes red here. Runs on `flat` — see the note on
      // `flatten` for why the raw file lets a line wrap hide the sentence.
      expect(flat).not.toMatch(/gated on a heartbeat/);
      // And the hub's old display-vs-delivery fusion ("the hub shows you as
      // **away and triage requests queue**") stays gone. Revert guard, not a
      // live check: deleted in 278de00.
      expect(flat).not.toMatch(/away and triage requests queue/);
    });
  }
});

describe('the lead skill states the seat contract', () => {
  it('names the bare one-argument declaration, and only that form', () => {
    expect(LEAD).toMatch(/set_workspace_lead\(workspaceId\)/);
    expect(flatten(LEAD)).toMatch(/no second argument/);
  });

  it('says the declaration covers surfaces created later', () => {
    expect(flatten(LEAD)).toMatch(/created later/);
  });

  it('says events queue across a disconnect instead of dropping', () => {
    // The durable-queue model: the queue is the record, delivery is the fast
    // path. A lead that reads this knows a gap is a backlog, not a loss.
    expect(flatten(LEAD)).toMatch(/disconnect/);
    expect(flatten(LEAD)).toMatch(/remain queued|queued for when you reconnect/);
  });

  it('requires the general skill as background instead of repeating it', () => {
    expect(LEAD).toMatch(/working-in-a-workspace/);
    expect(flatten(LEAD)).toMatch(/deliberately not repeated/);
  });

  it('claims the task-review ask for the seat', () => {
    expect(LEAD).toMatch(/task-review/);
  });
});

describe('positive controls — guidance that must survive the edit', () => {
  it('the hub skill still requires a heartbeat while attached', () => {
    // A heartbeat is the only signal a session can send when it has nothing
    // else to say. Tool calls refresh the observed clock for free while you
    // work THIS board, so the case that needs the explicit call is the quiet
    // one — a long stretch of thinking, or a board you hold but are not
    // currently touching.
    expect(HUB).toMatch(/heartbeat\(workspaceId\)/);
    expect(flatten(HUB)).toMatch(/stay live/);
  });

  it('the hub skill still documents attach_agent for agents that do not lead', () => {
    expect(HUB).toMatch(/attach_agent\(workspaceId\)/);
  });

  it('the hub skill still keeps handing the seat to someone else a pure handover', () => {
    expect(HUB).toMatch(/set_workspace_lead\(workspaceId, leadAgentId\)/);
  });

  it('the lead skill still leads with priority order and not-stopping', () => {
    expect(LEAD).toMatch(/^## 3\. Work in priority order — including over the primary user$/m);
    expect(flatten(LEAD)).toMatch(/not until the batch drains/);
  });

  it('the general skill still carries the task standard and the review vocabulary', () => {
    expect(GENERAL).toMatch(/<persona> can <do x> so that <goal y>/);
    expect(GENERAL).toContain('add_review_item(taskId, review)');
    expect(GENERAL).toContain('review_type: "decision"');
    expect(GENERAL).toContain('review_type: "question"');
  });

  it('no substantive sentence appears in both halves of the split skill', () => {
    // The split's drift guard, stated mechanically: the lead skill says its
    // shared ground is "deliberately not repeated here", so any long line
    // present verbatim in both files is a copy that will rot in one place.
    const lines = (t: string) =>
      new Set(
        t
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 60 && !l.startsWith('#') && !l.startsWith('---')),
      );
    const g = lines(GENERAL);
    const dup = [...lines(LEAD)].filter((l) => g.has(l));
    expect(dup).toEqual([]);
  });

  it('the hub skill still keeps its work loop and lead-seat sections', () => {
    expect(HUB).toMatch(/^## The work loop$/m);
    expect(HUB).toMatch(/^## Goal edits and the lead-agent seat$/m);
  });

  it('the skills still carry their frontmatter names', () => {
    expect(HUB).toMatch(/^name: running-a-workspace-hub$/m);
    expect(LEAD).toMatch(/^name: leading-a-workspace$/m);
    expect(GENERAL).toMatch(/^name: working-in-a-workspace$/m);
  });
});
