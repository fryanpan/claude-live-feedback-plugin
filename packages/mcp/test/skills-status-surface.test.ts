/**
 * Status lives on the task's Activity tab; comments are for asks and replies.
 *
 * The owner's call (2026-08-29): "let's get status updates off the comment
 * feed and into the activity tab instead — there's too much crap in the
 * comments." Turn notes already reach the tab by themselves from the Stop
 * hook, and `post_status` carries a named milestone there. What had kept
 * status IN the comments was the skills: three passages told an agent to
 * post progress, milestones and the final report as task comments, and
 * agents did exactly that.
 *
 * Content assertions on the shipped SKILL.md files, in the style of
 * skills-declare-once.test.ts: peers install the FILE, so the file is what
 * gets pinned. Negative guards run over every shipped skill so the old
 * sentence cannot come back in a new one.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS = join(HERE, '../../plugin/skills');
const GENERAL = readFileSync(join(SKILLS, 'working-in-a-workspace/SKILL.md'), 'utf8');
const LEAD = readFileSync(join(SKILLS, 'leading-a-workspace/SKILL.md'), 'utf8');
const BUNDLE = readFileSync(join(HERE, '../../plugin/mcp/index.js'), 'utf8');

const SHIPPED: Array<[string, string]> = readdirSync(SKILLS, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(SKILLS, d.name, 'SKILL.md')))
  .map((d) => [d.name, readFileSync(join(SKILLS, d.name, 'SKILL.md'), 'utf8')]);

/** One line, lower-cased — the files are hard-wrapped, and a `not.toMatch`
 *  over raw text goes quietly green when the wrap lands inside the phrase
 *  (the story is in skills-declare-once.test.ts). */
const flatten = (s: string): string => s.replace(/\s+/g, ' ').toLowerCase();

describe('the general skill sends status to the Activity tab', () => {
  it('names post_status as the status verb and the Activity tab as where it lands', () => {
    expect(GENERAL).toContain('post_status');
    expect(flatten(GENERAL)).toMatch(/activity tab/);
  });

  it('says the end-of-turn message reaches the tab by itself', () => {
    // An agent that does not know the hook posts its final message will
    // paste it somewhere a second time.
    expect(flatten(GENERAL)).toMatch(/end-of-turn|end of turn/);
  });

  it('keeps comments for asks, decisions and replies to a person', () => {
    // The verbs that make a comment stay taught — a skill that only says
    // "not comments" leaves the agent with no way to ask.
    expect(GENERAL).toContain('add_review_item(taskId, review)');
    expect(GENERAL).toContain('post_reply');
    expect(flatten(GENERAL)).toMatch(/comments? (is|are) for/);
  });

  it('the final-message rule points at the task, not at a comment threadUrl', () => {
    expect(flatten(GENERAL)).toMatch(/final message is a pointer/);
    expect(flatten(GENERAL)).not.toMatch(/full report as a task comment/);
  });
});

describe('the lead skill dispatches with the same contract', () => {
  it('the dispatch prompt names post_status and never a report comment', () => {
    expect(LEAD).toContain('post_status');
    expect(flatten(LEAD)).not.toMatch(/report as a task comment/);
  });
});

describe('no shipped skill still teaches progress as comments', () => {
  /** Each guard paired with the sentence it bans, so the guard is proven
   *  against its own target below — a gap of 40 once sat between "share
   *  progress" and "using comments" in a sentence whose middle was 53
   *  characters, and the guard was green for a sentence it could not match. */
  const BANNED: Array<[RegExp, string]> = [
    [
      /share progress .{0,80}using comments/,
      'Share progress in the workspace on the most appropriate task or doc using comments',
    ],
    [
      /share progress on a task by writing brief comments/,
      'Share progress on a task by writing brief comments in the task at each milestone',
    ],
    [
      /post the full report as a task comment/,
      'Post the full report as a task comment FIRST, then hand over the link',
    ],
    [
      /posts its full report as a task comment/,
      'the agent posts its full report as a task comment first',
    ],
    [/the board comment is the copy that survives/, 'The board comment is the copy that survives.'],
  ];
  it.each(SHIPPED)('%s', (_name, raw) => {
    const flat = flatten(raw);
    for (const [re] of BANNED) expect(flat).not.toMatch(re);
  });

  it.each(BANNED)('guard %s matches the sentence it bans', (re, sentence) => {
    expect(flatten(sentence)).toMatch(re);
  });

  it('reads a non-empty set of shipped skills', () => {
    expect(SHIPPED.length).toBeGreaterThan(1);
  });

  // POSITIVE CONTROL for the guard above: the same probe finds the sentence
  // that replaced the banned ones, so green means "absent" and not "the
  // pattern never matches this file's wrapping".
  it('the same probe finds the replacement sentence', () => {
    expect(flatten(GENERAL)).toMatch(/post_status/);
  });
});

describe('the shipped bundle carries the verb the skills name', () => {
  // Peers load packages/plugin/mcp/index.js and never the source: a skill
  // naming a tool that the installed bundle does not declare tells the agent
  // to call something that does not exist.
  it('declares post_status', () => {
    expect(BUNDLE).toContain('name: "post_status"');
    expect(BUNDLE).toContain('/notes');
  });
  it('post_reply no longer offers itself for status notes', () => {
    expect(BUNDLE).not.toContain('is right for status notes');
    // POSITIVE CONTROL: the description that replaced it is in the bundle.
    expect(BUNDLE).toContain('where the work stands goes through post_status');
  });
});
