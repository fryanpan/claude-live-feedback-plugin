import { describe, expect, it } from 'vitest';
import {
  GOAL_SUMMARY_MAX_WORDS,
  type StoredGoalSummary,
  clipGoal,
  goalDisplay,
  goalTextHash,
  wordCount,
} from '../src/goal-summary.ts';

const LONG = [
  'First goal is to make task management smoother and easier for me and agents on the team.',
  'Secondly, I want goals to work, starting from the top level goal and then the task-level goals.',
  'And then finally collaboration and other work surface functionality, but maybe that can wait.',
].join('\n\n');

const stored = (text: string, forGoal: string): StoredGoalSummary => ({
  text,
  goalHash: goalTextHash(forGoal),
  ts: 1,
});

describe('clipGoal', () => {
  it('returns a short goal unchanged', () => {
    expect(clipGoal('Ship the board by Thursday.')).toBe('Ship the board by Thursday.');
  });

  it('clips a long goal to the first N of its OWN words', () => {
    const clip = clipGoal(LONG);
    expect(wordCount(clip)).toBeLessThanOrEqual(GOAL_SUMMARY_MAX_WORDS);
    // The words are the goal's own opening — nothing invented, nothing reordered.
    expect(LONG.replace(/\s+/g, ' ')).toContain(clip.replace(/…$/, '').trim());
  });

  it('ends at a sentence boundary when the first sentence fits', () => {
    expect(clipGoal(LONG)).toBe(
      'First goal is to make task management smoother and easier for me and agents on the team.',
    );
  });

  it('marks a mid-sentence cut with an ellipsis', () => {
    const runOn = `${'word '.repeat(40).trim()} and then some more prose`;
    const clip = clipGoal(runOn);
    expect(wordCount(clip)).toBe(GOAL_SUMMARY_MAX_WORDS);
    expect(clip.endsWith('…')).toBe(true);
  });

  it('collapses paragraphs and newlines into one line', () => {
    expect(clipGoal('one\n\ntwo\nthree')).toBe('one two three');
  });

  it('stops at the first sentence rather than mid-clause when the goal overruns', () => {
    const g = `Make feedback fast. ${'Then make it deliverable to a whole fleet of peers. '.repeat(3)}`;
    expect(clipGoal(g)).toBe('Make feedback fast.');
  });

  it('reads as text, not markdown source', () => {
    const g = '# The goal\n\n- Make **feedback** as fast as `pointing` and [saying](http://x) this';
    const clip = clipGoal(g);
    expect(clip).not.toContain('#');
    expect(clip).not.toContain('**');
    expect(clip).not.toContain('`');
    expect(clip).not.toContain('](');
    expect(clip).toContain('feedback');
    expect(clip).toContain('saying');
  });

  it('is empty for an empty or whitespace-only goal', () => {
    expect(clipGoal('')).toBe('');
    expect(clipGoal('   \n\n  ')).toBe('');
  });
});

describe('goalDisplay', () => {
  it('renders the deterministic clip when nothing is stored', () => {
    const d = goalDisplay(LONG);
    expect(d.source).toBe('clip');
    expect(d.summary).toBe(clipGoal(LONG));
    expect(d.truncated).toBe(true);
    expect(d.full).toBe(LONG);
  });

  it('offers no expansion when the whole goal already fits', () => {
    const d = goalDisplay('Ship the board by Thursday.');
    expect(d.truncated).toBe(false);
    expect(d.summary).toBe('Ship the board by Thursday.');
  });

  it('prefers a stored summary written against THIS goal, and drops a stale one', () => {
    // Positive control first: a summary whose hash matches IS shown.
    const fresh = goalDisplay(
      LONG,
      stored('Task management, then goals, then collaboration.', LONG),
    );
    expect(fresh.source).toBe('stored');
    expect(fresh.summary).toBe('Task management, then goals, then collaboration.');

    // Same summary text, but the goal has since been replaced: it now
    // describes something that is no longer the goal, so it must not render.
    const changed = `${LONG}\n\nActually: drop everything and fix the tunnel.`;
    const stale = goalDisplay(
      changed,
      stored('Task management, then goals, then collaboration.', LONG),
    );
    expect(stale.source).toBe('clip');
    expect(stale.summary).toBe(clipGoal(changed));
  });

  it('never lets a stored summary exceed the budget', () => {
    const overlong = `${LONG} ${LONG}`;
    const d = goalDisplay(LONG, stored(overlong, LONG));
    expect(wordCount(d.summary)).toBeLessThanOrEqual(GOAL_SUMMARY_MAX_WORDS);
  });

  it('treats an empty stored summary as absent rather than as a compliant one', () => {
    const d = goalDisplay(LONG, stored('   ', LONG));
    expect(d.source).toBe('clip');
    expect(d.summary).toBe(clipGoal(LONG));
  });

  it('says truncated when a stored summary hides part of the goal', () => {
    const d = goalDisplay(LONG, stored('Task management, then goals.', LONG));
    expect(d.truncated).toBe(true);
  });

  it('is empty and untruncated for an empty goal', () => {
    const d = goalDisplay('');
    expect(d.summary).toBe('');
    expect(d.truncated).toBe(false);
    expect(d.source).toBe('empty');
  });

  it('hashes on the goal text only — whitespace-identical goals agree', () => {
    expect(goalTextHash('a b')).toBe(goalTextHash('a b'));
    expect(goalTextHash('a b')).not.toBe(goalTextHash('a c'));
  });
});
