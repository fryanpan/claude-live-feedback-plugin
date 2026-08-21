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
 * on exactly one of them:
 *
 *   running-a-workspace-hub   "gated on a heartbeat inside the"   -> caught
 *   working-a-workspace-board "...is gated on a" / "heartbeat..." -> MISSED
 *
 * Same assertion, same loop, same wrong sentence; the only difference is that
 * one file's line break fell between `a` and `heartbeat`. Collapsing the
 * whitespace removes the coin flip.
 *
 * Structural assertions (`/^## …$/m`, frontmatter) keep using the raw text —
 * they are ABOUT line boundaries, and flattening would destroy what they check.
 */
const flatten = (s: string): string => s.replace(/\s+/g, ' ').toLowerCase();

const both: Array<[string, string, string]> = [
  ['running-a-workspace-hub', HUB, flatten(HUB)],
  ['leading-a-workspace', LEAD, flatten(LEAD)],
];

describe('the skills teach one declaration per session', () => {
  for (const [name, text, flat] of both) {
    describe(name, () => {
      it('names the bare one-argument declaration', () => {
        // `set_workspace_lead(workspaceId)` with nothing else — the form that
        // attaches, subscribes and drains. An agent that reads the two-arg
        // handover form first will assume it needs an id it does not have.
        expect(text).toMatch(/set_workspace_lead\(workspaceId\)/);
      });

      it('says the declaration covers surfaces created later', () => {
        expect(flat).toMatch(/created later/);
      });

      it('says it survives a respawn without being redone', () => {
        expect(flat).toMatch(/respawn|restart/);
        expect(flat).toMatch(/survives|re-?wire|restore|persist/);
      });

      it('demotes watch_doc — it is for docs outside your board, not a stand-in', () => {
        expect(flat).toMatch(/outside|does not stand in/);
        expect(text).toMatch(/watch_doc/);
      });

      it('names list_watched_docs as the way to check coverage', () => {
        expect(text).toMatch(/list_watched_docs/);
      });

      it('gives the reader a probe for a board that feels quiet', () => {
        // The exact reading the incident needed and nobody had: a peer that
        // believed it was listening had no way to ask. The hub names
        // unattachedBoards; the lead skill routes the same doubt through
        // list_watched_docs coverage. Either way, quiet gets a probe.
        expect(text).toMatch(/unattachedBoards|coverage/);
        expect(flat).toMatch(/quiet/);
      });
    });
  }
});

describe('the skills teach what declaring does NOT do', () => {
  for (const [name, text, flat] of both) {
    describe(name, () => {
      it('says a declaration does not keep you live, and names OBSERVED WORK as the gate', () => {
        // The gap this branch created: one call now covers every surface, so
        // "I declared" reads as "I am covered" — while an attachment lapses
        // unless the server keeps seeing the session. A skill that teaches
        // the one call without this teaches a session to go silently away.
        //
        // WHAT THIS ASSERTION IS FOR, since the previous one taught the wrong
        // rule while looking like it guarded this exact sentence. It was
        // `/5[- ]minute|five minutes|goes quiet|stay live/` — an alternation
        // broad enough to pass on the WRONG text, on the corrected text, and
        // again if anyone reinstated the error. It pinned nothing and read as
        // coverage, which is why the mistake survived four green CI runs.
        //
        // The rule it should have encoded: HEARTBEAT_FRESH_MS (~5 min) feeds
        // the DISPLAYED away label; delivery rides the observed clock,
        // `max(lastHeartbeat, lastToolCallAt)`. So a ~5-minute claim about
        // display is fine and a heartbeat-window claim about DELIVERY is not,
        // and only the second is asserted here.
        //
        // All three phrase searches below run on `flat`, not on `text`. See
        // the note on `flatten` for the measurement: on the raw file this
        // first negative caught the hub and MISSED the board, at a commit
        // where both files carried the sentence word for word.
        expect(text).toMatch(/heartbeat\(workspaceId\)/);
        // Positive: the delivery gate is named as BOTH signals, not one.
        expect(flat).toMatch(/a heartbeat or a tool call|a tool call or a heartbeat/);
        // Negative: and the old claim cannot come back unnoticed. Reverting
        // either skill to "Delivery is gated on a heartbeat inside the
        // ~5-minute window" fails on both halves at once.
        expect(flat).not.toMatch(/gated on a heartbeat/);
        // The second negative bans the hub's old display-vs-delivery fusion,
        // "the hub shows you as **away and triage requests queue**". Two
        // things about it are worth knowing rather than rediscovering. It is
        // a revert guard, not a live check: the sentence was deleted in
        // 278de00 and the phrase is now absent from both files. And it has
        // only ever been able to fire on the hub: sweeping every reachable
        // revision of the two files finds the phrase in 37 of the hub's 39
        // and in 0 of the board's 50. Its silence on the board is absence of
        // the subject, not evidence of coverage. Flattening still matters —
        // it is what stops the guard from depending on where the wrap lands
        // if anyone reinstates the wording.
        expect(flat).not.toMatch(/away and triage requests queue/);
      });

      it('teaches the repair path without leaving the heartbeat behind', () => {
        // The hub names three distinct remedies; the lead skill teaches that
        // set_workspace_lead attaches first and so repairs every seat state
        // by itself ("that one call is also the repair"). Both must still
        // name the heartbeat, because the one thing the repair call does NOT
        // fix is a session going quietly unobserved.
        expect(text).toMatch(/attach_agent\(workspaceId\)|one call is also the repair/i);
        expect(text).toMatch(/set_workspace_lead\(workspaceId\)/);
        expect(text).toMatch(/heartbeat\(workspaceId\)/);
      });

      it('says declaring will not displace a live lead, and names the override', () => {
        expect(text).toMatch(/lead-held/);
        expect(text).toMatch(/takeover/);
      });
    });
  }
});

describe('positive controls — guidance that must survive the edit', () => {
  it('the hub skill still requires a heartbeat while attached', () => {
    // Declaring once does NOT retire the heartbeat. The old comment here
    // justified that with "delivery still asks whether the lead's heartbeat is
    // fresh" — which this commit's own code falsifies, and which is the same
    // wrong claim the assertion above now guards against. The reason survives
    // the correction, but it is a different reason: a heartbeat is the only
    // signal a session can send when it has nothing else to say. Tool calls
    // refresh the observed clock for free while you work THIS board, so the
    // case that needs the explicit call is the quiet one — a long stretch of
    // thinking, or a board you hold but are not currently touching.
    //
    // This assertion is a positive control and its job is unchanged: it pins
    // "stay live" and the `heartbeat(workspaceId)` call surviving the edit.
    // The realistic failure of a doc change is not a missing addition but a
    // rewrite that quietly drops what was already there — and a correction
    // that deleted the heartbeat instruction along with the wrong sentence
    // about it would be exactly that.
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
