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
const BOARD = readFileSync(join(SKILLS, 'working-a-workspace-board/SKILL.md'), 'utf8');

const both: Array<[string, string]> = [
  ['running-a-workspace-hub', HUB],
  ['working-a-workspace-board', BOARD],
];

describe('the skills teach one declaration per session', () => {
  for (const [name, text] of both) {
    describe(name, () => {
      it('names the bare one-argument declaration', () => {
        // `set_workspace_lead(workspaceId)` with nothing else — the form that
        // attaches, subscribes and drains. An agent that reads the two-arg
        // handover form first will assume it needs an id it does not have.
        expect(text).toMatch(/set_workspace_lead\(workspaceId\)/);
      });

      it('says the declaration covers surfaces created later', () => {
        expect(text.toLowerCase()).toMatch(/created later/);
      });

      it('says it survives a respawn without being redone', () => {
        expect(text.toLowerCase()).toMatch(/respawn|restart/);
        expect(text.toLowerCase()).toMatch(/re-?wire|restore|persist/);
      });

      it('demotes watch_doc to docs OUTSIDE your board', () => {
        expect(text.toLowerCase()).toMatch(/outside/);
        expect(text).toMatch(/watch_doc/);
      });

      it('names list_watched_docs as the way to check coverage', () => {
        expect(text).toMatch(/list_watched_docs/);
      });

      it('tells the reader to read unattachedBoards when it feels quiet', () => {
        // The exact reading the incident needed and nobody had: a peer that
        // believed it was listening had no way to ask.
        expect(text).toMatch(/unattachedBoards/);
        expect(text.toLowerCase()).toMatch(/quiet/);
      });
    });
  }
});

describe('the skills teach what declaring does NOT do', () => {
  for (const [name, text] of both) {
    describe(name, () => {
      it('says a declaration does not keep you live — the heartbeat window still gates delivery', () => {
        // The gap this branch created: one call now covers every surface, so
        // "I declared" reads as "I am covered" — while an attachment expires
        // ~5 minutes after its last heartbeat and every lead-addressed
        // delivery asks for a fresh one. A skill that teaches the one call
        // without this teaches a session to go silently away.
        expect(text).toMatch(/heartbeat\(workspaceId\)/);
        expect(text.toLowerCase()).toMatch(/5[- ]minute|five minutes|goes quiet|stay live/);
      });

      it('names the THREE different remedies, not one blanket fix', () => {
        // A single "declare yourself" recommendation is wrong in two
        // directions: it evicts a live peer, and it does not fix a lapsed
        // heartbeat on a seat you already hold.
        expect(text).toMatch(/attach_agent\(workspaceId\)/);
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
    // Declaring once does NOT retire the heartbeat: delivery still asks
    // whether the lead's heartbeat is fresh, so an agent that reads "one call
    // and you are done" as "and nothing after" goes away without knowing it.
    expect(HUB).toMatch(/heartbeat\(workspaceId\)/);
    expect(HUB.toLowerCase()).toMatch(/stay live/);
  });

  it('the hub skill still documents attach_agent for agents that do not lead', () => {
    expect(HUB).toMatch(/attach_agent\(workspaceId\)/);
  });

  it('the hub skill still keeps handing the seat to someone else a pure handover', () => {
    expect(HUB).toMatch(/set_workspace_lead\(workspaceId, leadAgentId\)/);
  });

  it('the board skill still leads with priority order and not-stopping', () => {
    expect(BOARD).toMatch(/^## Always work in priority order$/m);
    expect(BOARD).toMatch(/^## Finishing a task is not a reason to stop$/m);
  });

  it('the hub skill still keeps its work loop and lead-seat sections', () => {
    expect(HUB).toMatch(/^## The work loop$/m);
    expect(HUB).toMatch(/^## Goal edits and the lead-agent seat$/m);
  });

  it('both skills still carry their frontmatter name', () => {
    expect(HUB).toMatch(/^name: running-a-workspace-hub$/m);
    expect(BOARD).toMatch(/^name: working-a-workspace-board$/m);
  });
});
