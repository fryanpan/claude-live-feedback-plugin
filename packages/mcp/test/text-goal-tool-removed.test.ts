/**
 * `set_workspace_goal` is gone from the tool surface, and from the artifact
 * peers actually load.
 *
 * The workspace-level TEXT goal was removed; a board's goals are the ordered
 * goal LIST. Source alone is not the deliverable here: peers run the
 * committed `packages/plugin/mcp/index.js`, and a tool that survives only in
 * the bundle is a tool agents keep calling — against a route that now refuses
 * it. So both are read, and every absence is paired with a presence, or a
 * file that failed to load would satisfy the whole file by being empty.
 *
 * The REST route is deliberately NOT removed and is not asserted absent
 * anywhere: an old bundle still calls it, and it answers 410 with the
 * replacement named. That half is pinned in
 * `packages/server/test/text-goal-removed.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, '../src/mcp.ts'), 'utf8');
const BUNDLE = readFileSync(join(HERE, '../../plugin/mcp/index.js'), 'utf8');

describe('the text-goal tool is off the surface', () => {
  it('neither the source nor the bundle still declares it', () => {
    // Positive controls first, on both files: the surviving goal verbs are
    // present, so the absences below are removals rather than a read that
    // returned nothing useful.
    for (const [name, text] of [
      ['source', SRC],
      ['bundle', BUNDLE],
    ] as const) {
      expect(text, `${name}: lost set_goal_list`).toContain('set_goal_list');
      expect(text, `${name}: lost set_task_goal`).toContain('set_task_goal');
      expect(text, `${name}: still declares set_workspace_goal`).not.toContain(
        'set_workspace_goal',
      );
    }
  });

  it('nothing left behind still speaks of the north star or its re-triage', () => {
    for (const [name, text] of [
      ['source', SRC],
      ['bundle', BUNDLE],
    ] as const) {
      expect(text, `${name}: goal_updated`).not.toContain('workspace.goal_updated');
      expect(text, `${name}: retriaged`).not.toContain('workspace.retriaged');
      expect(text, `${name}: pendingRetriage`).not.toContain('pendingRetriage');
      expect(text, `${name}: goal-retriage`).not.toContain('goal-retriage');
      // …while what DID survive is still carried, so an agent that stops
      // hearing about re-triage has not stopped hearing about the board.
      expect(text, `${name}: lost queuedVoice`).toContain('queuedVoice');
      expect(text, `${name}: lost untriaged`).toContain('untriaged');
    }
  });

  it('create_workspace no longer takes a goal', () => {
    const start = SRC.indexOf("name: 'create_workspace',");
    expect(start, 'no create_workspace declaration').toBeGreaterThan(-1);
    const decl = SRC.slice(start, SRC.indexOf('},\n    {', start));
    // The SCHEMA is what an old caller's payload is matched against — the
    // description still says the word "goal", and has to: it names where a
    // board's aims live now.
    const schema = decl.slice(decl.indexOf('inputSchema:'));
    // Positive control: the schema slice really is in view.
    expect(schema).toContain("required: ['name']");
    expect(schema).not.toMatch(/goal/);
  });
});
