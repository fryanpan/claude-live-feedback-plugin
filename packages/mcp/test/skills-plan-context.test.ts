/**
 * The lead skill tells a planner to read the board before writing a plan.
 *
 * Content assertions on the shipped SKILL.md, in the style of
 * skills-declare-once.test.ts and for the same reason: peers install the FILE,
 * and a step that exists only in a tool description is read at the moment the
 * tool is about to be called — which is exactly the moment that never arrives
 * when an agent does not know the step exists. The skill is the surface read at
 * SESSION START, before the mistake.
 *
 * What is pinned is the shape the 2026-09-02 huddle asked for, and nothing
 * else: the verb is called first, an answer that is not empty produces ONE
 * decision item and a wait, an empty answer means plan from scratch, and the
 * goal that comes out of either branch carries a description and a link. A
 * reword is fine; losing a branch is not.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS = join(HERE, '../../plugin/skills');
const LEAD = readFileSync(join(SKILLS, 'leading-a-workspace/SKILL.md'), 'utf8');

/** One line, lower-cased. These files are hard-wrapped at ~76 columns, so a
 *  multi-word phrase only matches once the wrapping is flattened away — the
 *  same reason the sibling skill suites do this. */
const flatten = (s: string): string => s.replace(/\s+/g, ' ').toLowerCase();

/** Just the planning section, so a phrase that also occurs elsewhere in the
 *  file cannot make an assertion pass with the section deleted. */
const planningSection = (): string => {
  const body = LEAD.split(/^### Before you plan, ask the board what it already covers$/m)[1] ?? '';
  return flatten(body.split(/^## /m)[0] ?? '');
};

describe('the lead skill carries the look-before-you-plan step', () => {
  it('has the section, with a body (the control for every read below)', () => {
    expect(LEAD).toMatch(/^### Before you plan, ask the board what it already covers$/m);
    // Without this, an emptied section would satisfy the slicer and leave the
    // assertions below reading an empty string.
    expect(planningSection().length).toBeGreaterThan(400);
  });

  it('names the verb and says it runs before anything is written', () => {
    const s = planningSection();
    expect(s).toContain('find_related_work');
    expect(s).toMatch(/before writing any plan, goal or task/);
  });

  it('states the branch for an answer that is not empty: one decision, then wait', () => {
    const s = planningSection();
    expect(s).toContain('review_type: "decision"');
    // The count is the point. Ten matches are not ten questions.
    expect(s).toMatch(/one review item/);
    expect(s).toMatch(/one item, not one per match/);
    expect(s).toMatch(/wait for the answer/);
  });

  it('offers the three ways forward the reader has to choose between', () => {
    const s = planningSection();
    expect(s).toContain('extend that plan');
    expect(s).toContain('replace it');
    expect(s).toContain('new plan');
  });

  it('states the branch for an empty answer', () => {
    expect(planningSection()).toMatch(/nothing came back.*plan from scratch/);
  });

  it('requires a description and a link on the goal, whichever branch ran', () => {
    const s = planningSection();
    expect(s).toMatch(/either way/);
    expect(s).toContain('a **description**');
    expect(s).toContain('link_refs');
  });
});
