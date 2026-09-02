/**
 * `publicAttachment` is the projection a share or collab visitor's
 * `GET <ws>/attachments` returns, and it must be an ALLOWLIST.
 *
 * It used to destructure `endpoint` out and spread the rest, which means a
 * field added to `AgentAttachment` later shipped to visitors by default and
 * stayed there until somebody noticed. Every neighbouring visitor projection
 * — `redactMetaForVisitor`, `redactHubWorkspaceForVisitor` — was rewritten to
 * the opposite rule after a leak, each with a header saying why; this was the
 * last one still built the old way.
 *
 * The test that matters is the one a denylist cannot pass: a field the
 * projection was never told about must not survive. It is expressed by
 * handing the function a record carrying an extra key, which is exactly the
 * shape the NEXT `AgentAttachment` field will have before anyone updates this
 * file.
 *
 * Fixtures are synthetic. Nothing here is a real endpoint or host.
 */
import { describe, expect, it } from 'bun:test';
import { type AgentAttachment, publicAttachment } from '../src/tasks.ts';

const NOW = 1_700_000_000_000;

const attachment = (extra: Record<string, unknown> = {}): AgentAttachment =>
  ({
    workspaceId: 'w-fixture',
    agentId: 'agent-fixture',
    runtime: 'claude-code-local',
    endpoint: 'http://host.invalid:9999',
    lastHeartbeat: NOW - 1_000,
    lastToolCallAt: NOW - 1_000,
    capabilities: ['tasks.write'],
    pluginVersion: '0.1.99',
    processId: 'proc-fixture',
    ...extra,
  }) as AgentAttachment;

describe('publicAttachment is an allowlist', () => {
  it('CONTROL: the fields a visitor is meant to get all survive', () => {
    // Without this, "the extra field is gone" below would pass on a function
    // that returned an empty object.
    const out = publicAttachment(attachment(), NOW);
    expect(out.workspaceId).toBe('w-fixture');
    expect(out.agentId).toBe('agent-fixture');
    expect(out.runtime).toBe('claude-code-local');
    expect(out.lastHeartbeat).toBe(NOW - 1_000);
    expect(out.lastToolCallAt).toBe(NOW - 1_000);
    expect(out.capabilities).toEqual(['tasks.write']);
    expect(out.pluginVersion).toBe('0.1.99');
    expect(out.processId).toBe('proc-fixture');
    // Derived, and the reason this projection exists at all.
    expect(out.state).toBe('active');
    expect(out.stateLabel).toBe('active');
  });

  it('drops `endpoint` — the host-machine fact this projection was built for', () => {
    expect('endpoint' in publicAttachment(attachment(), NOW)).toBe(false);
  });

  it('drops a field it was never told about — what a denylist cannot do', () => {
    const out = publicAttachment(
      attachment({
        // Stand-ins for the next host-describing field somebody adds without
        // reading this file. A spread-and-omit projection ships both.
        hostWorkingDir: '/fixture/path/on/the/box',
        internalSocketPath: '/fixture/socket',
      }),
      NOW,
    );
    expect('hostWorkingDir' in out).toBe(false);
    expect('internalSocketPath' in out).toBe(false);
    // The keys are exactly the allowlist, in whatever order.
    expect(Object.keys(out).sort()).toEqual(
      [
        'agentId',
        'capabilities',
        'lastHeartbeat',
        'lastToolCallAt',
        'pluginVersion',
        'processId',
        'runtime',
        'state',
        'stateLabel',
        'workspaceId',
      ].sort(),
    );
  });

  it('an absent optional stays ABSENT rather than becoming an explicit undefined', () => {
    // `pluginVersion` silence is read as "older than the release that added
    // it", so the wire shape has to keep saying nothing rather than null.
    const bare = attachment();
    bare.pluginVersion = undefined;
    bare.processId = undefined;
    const out = publicAttachment(bare, NOW);
    expect('pluginVersion' in out).toBe(false);
    expect('processId' in out).toBe(false);
    // Control: the required fields are still there on the same call.
    expect(out.agentId).toBe('agent-fixture');
  });

  it('still derives the state it is asked for — away, not just active', () => {
    const stale = attachment();
    stale.lastHeartbeat = NOW - 60 * 60_000;
    expect(publicAttachment(stale, NOW).state).toBe('away');
  });
});
