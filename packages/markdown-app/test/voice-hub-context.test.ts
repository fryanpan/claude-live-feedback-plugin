/**
 * What the hub tells the server the speaker is LOOKING AT.
 *
 * The board's own affordance for "a ticket is in view" is the keyboard row
 * cursor — `j`/`k` focus a `.hub-task-row` — and the detail panel is the other
 * one. The first cut of voice actions keyed only on the detail panel, so the
 * ticket's own flow ("with a ticket highlighted, say mark this done") sent
 * `{surface:'hub'}` and the utterance went to the agent: no resource in view,
 * so the guardrail correctly refused, and the highlighted row never moved.
 */
import { describe, expect, it } from 'vitest';
import { voiceHubContext } from '../src/hub/hub-model.ts';

describe('voiceHubContext', () => {
  it('reports the open detail panel’s task', () => {
    expect(voiceHubContext('t-detail', null)).toEqual({ surface: 'task', taskId: 't-detail' });
  });

  it('reports the HIGHLIGHTED row when no detail panel is open', () => {
    expect(voiceHubContext(null, 't-row')).toEqual({ surface: 'task', taskId: 't-row' });
  });

  it('prefers the detail panel when both are present — it is the narrower thing in view', () => {
    expect(voiceHubContext('t-detail', 't-row')).toEqual({
      surface: 'task',
      taskId: 't-detail',
    });
  });

  it('falls back to the board itself when nothing is in view', () => {
    expect(voiceHubContext(null, null)).toEqual({ surface: 'hub' });
    // A blank dataset value is nothing in view, not a task called "".
    expect(voiceHubContext(null, '')).toEqual({ surface: 'hub' });
  });
});

describe('voiceHubContext — the review item the speaker is IN', () => {
  it('carries the open thread when the detail panel is aimed at one', () => {
    // Bryan, 2026-08-29: "If I'm in a review item, I should be able to reply
    // by voice." With several items open on one ticket, the thread is what
    // makes "pick the second one" unambiguous.
    expect(voiceHubContext('t-detail', null, 'th-9')).toEqual({
      surface: 'task',
      taskId: 't-detail',
      threadId: 'th-9',
    });
  });

  it('never attaches a thread to a highlighted ROW — a row has no open thread', () => {
    expect(voiceHubContext(null, 't-row', 'th-9')).toEqual({ surface: 'task', taskId: 't-row' });
  });

  it('a blank thread is no thread', () => {
    expect(voiceHubContext('t-detail', null, '')).toEqual({ surface: 'task', taskId: 't-detail' });
    expect(voiceHubContext('t-detail', null, null)).toEqual({
      surface: 'task',
      taskId: 't-detail',
    });
  });
});
