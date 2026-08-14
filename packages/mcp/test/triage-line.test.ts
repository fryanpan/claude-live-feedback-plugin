import { describe, expect, it } from 'vitest';
import { triageRequestLine } from '../src/triage-line.ts';

const RETRIAGE = {
  kind: 'goal-retriage',
  taskIds: ['t-a', 't-b', 't-c'],
  batchId: 'b-1',
};

describe('triageRequestLine', () => {
  it('asks the lead agent to act, in the imperative', () => {
    const line = triageRequestLine({ ...RETRIAGE, leadAgentId: 'agent-lead' }, 'agent-lead');
    expect(line).toContain('re-triage 3 open task(s) with set_task_goal');
    expect(line).toContain('batchId "b-1"');
    expect(line).not.toContain('Act only if');
  });

  it('tells a NON-lead who the request is addressed to instead of ordering them to act', () => {
    const line = triageRequestLine({ ...RETRIAGE, leadAgentId: 'agent-lead' }, 'agent-bystander');
    expect(line).toContain('agent-lead');
    expect(line).toContain('Act only if that is you');
  });

  // Positive control for the test above: the SAME payload renders the plain
  // imperative when the reader is the addressee, so the assertion there is
  // about the addressing and not about something inert in the payload.
  it('renders the imperative for that same payload when the reader IS the lead', () => {
    const line = triageRequestLine(
      { ...RETRIAGE, leadAgentId: 'agent-bystander' },
      'agent-bystander',
    );
    expect(line).toContain('re-triage 3 open task(s) with set_task_goal');
    expect(line).not.toContain('Act only if');
  });

  // One-directional by design: an unknown addressee may over-ask, never
  // under-ask. Silence is the failure mode with no recovery.
  it('keeps the imperative when the payload names no lead at all', () => {
    const line = triageRequestLine(RETRIAGE, 'agent-whoever');
    expect(line).toContain('re-triage 3 open task(s) with set_task_goal');
    expect(line).not.toContain('Act only if');
  });

  it('keeps the batchId in the FYI, so a wrongly-detected non-lead can still act', () => {
    const line = triageRequestLine({ ...RETRIAGE, leadAgentId: 'agent-lead' }, 'agent-bystander');
    expect(line).toContain('batchId "b-1"');
  });

  it('leaves single-task placement alone — it is addressed to whoever is attached', () => {
    const line = triageRequestLine(
      { kind: 'task', taskId: 't-z', leadAgentId: 'agent-lead' },
      'agent-bystander',
    );
    expect(line).toBe('[triage.requested] place task t-z against the goal (set_task_goal)');
  });

  it('says "?" rather than a wrong count when taskIds is missing', () => {
    const line = triageRequestLine({ kind: 'goal-retriage', batchId: 'b-2' }, 'agent-whoever');
    expect(line).toContain('re-triage ? open task(s)');
  });
});
