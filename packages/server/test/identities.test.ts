import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emailIdentityId } from '@feedback/core';
import { Identities, userForIdentity } from '../src/identities.ts';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'identities-test-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('upsertByEmail', () => {
  it('creates a row whose id is the derived one', () => {
    const store = new Identities({ dataDir });
    const rec = store.upsertByEmail('alice@example.com');
    expect(rec.id).toBe(emailIdentityId('alice@example.com'));
    expect(rec.email).toBe('alice@example.com');
    expect(rec.displayName).toBe('Alice');
    expect(rec.status).toBe('active');
    expect(rec.mergedFrom).toEqual([]);
  });

  it('is idempotent — a second login is the same person', () => {
    const store = new Identities({ dataDir });
    const first = store.upsertByEmail('alice@example.com');
    const second = store.upsertByEmail('  ALICE@Example.com ');
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    expect(store.list()).toHaveLength(1);
  });

  it('does not overwrite a chosen display name with a derived one', () => {
    const store = new Identities({ dataDir });
    store.upsertByEmail('alice@example.com');
    store.setDisplayName(emailIdentityId('alice@example.com'), 'Al');
    const again = store.upsertByEmail('alice@example.com');
    expect(again.displayName).toBe('Al');
  });

  it('refuses something that is not an address', () => {
    const store = new Identities({ dataDir });
    expect(() => store.upsertByEmail('alice')).toThrow();
  });

  it('writes nothing when nothing would change', () => {
    // The Access path resolves an identity on every authenticated write, so
    // an unconditional save would rewrite this file once per comment.
    let clock = 1_000;
    const store = new Identities({ dataDir, now: () => clock });
    const first = store.upsertByEmail('alice@example.com');
    const path = join(dataDir, 'identities.json');
    const before = statSync(path).mtimeMs;
    clock = 50_000;
    expect(store.upsertByEmail('alice@example.com').updatedAt).toBe(first.updatedAt);
    expect(statSync(path).mtimeMs).toBe(before);
    // Positive control: a real change still writes, and moves updatedAt.
    expect(store.upsertByEmail('alice@example.com', { displayName: 'Al' }).updatedAt).toBe(50_000);
  });
});

describe('round trip', () => {
  it('reloads what it wrote', () => {
    const store = new Identities({ dataDir });
    const rec = store.upsertByEmail('alice@example.com', { displayName: 'Alice A' });
    store.addMergedFrom(rec.id, 'anon-legacy1');
    const reloaded = new Identities({ dataDir });
    expect(reloaded.loadError).toBeNull();
    const back = reloaded.get(rec.id);
    expect(back?.email).toBe('alice@example.com');
    expect(back?.displayName).toBe('Alice A');
    expect(back?.mergedFrom).toEqual(['anon-legacy1']);
    expect(back?.createdAt).toBe(rec.createdAt);
  });
});

describe('mergedFrom resolution', () => {
  it('answers a legacy id with the identity it was folded into', () => {
    const store = new Identities({ dataDir });
    const rec = store.upsertByEmail('alice@example.com');
    store.addMergedFrom(rec.id, 'anon-a3f9k2');
    expect(store.get('anon-a3f9k2')?.id).toBe(rec.id);
    // Positive control: the canonical id still resolves to the same row.
    expect(store.get(rec.id)?.id).toBe(rec.id);
    // Negative: an id nobody merged is still nobody.
    expect(store.get('anon-unrelated')).toBeNull();
  });

  it('records a legacy id only once', () => {
    const store = new Identities({ dataDir });
    const rec = store.upsertByEmail('alice@example.com');
    store.addMergedFrom(rec.id, 'anon-1');
    store.addMergedFrom(rec.id, 'anon-1');
    expect(store.get(rec.id)?.mergedFrom).toEqual(['anon-1']);
  });
});

describe('archive is soft', () => {
  it('keeps the row readable and reversible', () => {
    const store = new Identities({ dataDir });
    const rec = store.upsertByEmail('alice@example.com');
    const archived = store.archive(rec.id, 'left the project');
    expect(archived?.status).toBe('archived');
    expect(archived?.archivedReason).toBe('left the project');
    // Still there — an archived person still authored things.
    expect(store.get(rec.id)?.displayName).toBe('Alice');
    expect(store.list()).toHaveLength(1);
    const back = store.unarchive(rec.id);
    expect(back?.status).toBe('active');
    expect(back?.archivedReason).toBeUndefined();
  });

  it('ends access as well as hiding the row', () => {
    let clock = 1_000;
    const store = new Identities({ dataDir, now: () => clock });
    const rec = store.upsertByEmail('alice@example.com');
    expect(rec.sessionsValidFrom).toBe(0);
    clock = 5_000;
    expect(store.archive(rec.id)?.sessionsValidFrom).toBe(5_000);
  });
});

describe('revokeSessions', () => {
  it('moves the watermark forward', () => {
    let clock = 1_000;
    const store = new Identities({ dataDir, now: () => clock });
    const rec = store.upsertByEmail('alice@example.com');
    clock = 9_000;
    expect(store.revokeSessions(rec.id)?.sessionsValidFrom).toBe(9_000);
  });

  it('answers null for an identity that does not exist', () => {
    const store = new Identities({ dataDir });
    expect(store.revokeSessions('user-nobody')).toBeNull();
  });
});

describe('a corrupt file', () => {
  it('is moved aside rather than overwritten', () => {
    writeFileSync(join(dataDir, 'identities.json'), '{ not json');
    const store = new Identities({ dataDir });
    expect(store.loadError).toContain('moved to');
    expect(store.list()).toEqual([]);
    // The evidence survives: the aside copy still holds the original bytes.
    const aside = store.loadError?.match(/moved to (.+)\)$/)?.[1];
    expect(aside).toBeTruthy();
    expect(readFileSync(aside as string, 'utf8')).toBe('{ not json');
  });

  it('drops a row with no usable address but keeps the rest', () => {
    writeFileSync(
      join(dataDir, 'identities.json'),
      JSON.stringify({
        version: 1,
        identities: {
          'user-broken': { id: 'user-broken', email: 'not-an-address' },
          [emailIdentityId('alice@example.com')]: {
            id: emailIdentityId('alice@example.com'),
            email: 'alice@example.com',
            displayName: 'Alice',
          },
        },
      }),
    );
    const store = new Identities({ dataDir });
    expect(store.loadError).toBeNull();
    expect(store.list().map((r) => r.email)).toEqual(['alice@example.com']);
  });
});

describe('userForIdentity', () => {
  it('is the author shape the rest of the server speaks', () => {
    const store = new Identities({ dataDir });
    const user = userForIdentity(store.upsertByEmail('alice@example.com'));
    expect(user).toEqual({
      id: emailIdentityId('alice@example.com'),
      name: 'Alice',
      kind: 'known',
      color: expect.stringMatching(/^#[0-9a-f]{6}$/),
    });
  });
});

describe('agent rows — one address book for people and helpers', () => {
  it('upsertAgent writes a row of kind agent that resolveAgentId finds by id', () => {
    const store = new Identities({ dataDir });
    const rec = store.upsertAgent('agent-quick-build', 'Quick Build');
    expect(rec?.kind).toBe('agent');
    expect(rec?.displayName).toBe('Quick Build');
    expect(store.resolveAgentId('agent-quick-build')).toBe('agent-quick-build');
  });

  it('three spellings of one name resolve to the one id the MCP mints', () => {
    // The measured field spellings for one agent: display name, bare slug,
    // and the derived id. All three must land on one row.
    const store = new Identities({ dataDir });
    store.upsertAgent('agent-quick-build', 'Quick Build');
    expect(store.resolveAgentId('Quick Build')).toBe('agent-quick-build');
    expect(store.resolveAgentId('quick-build')).toBe('agent-quick-build');
    expect(store.resolveAgentId('  QUICK build ')).toBe('agent-quick-build');
  });

  it('a merged legacy id resolves to the identity it was folded into', () => {
    const store = new Identities({ dataDir });
    store.upsertAgent('agent-quick-build', 'Quick Build');
    store.addMergedFrom('agent-quick-build', 'qb-agent');
    expect(store.resolveAgentId('qb-agent')).toBe('agent-quick-build');
    expect(store.get('qb-agent')?.id).toBe('agent-quick-build');
  });

  it('POSITIVE CONTROL: an unknown name resolves to nothing, not to a guess', () => {
    const store = new Identities({ dataDir });
    store.upsertAgent('agent-quick-build', 'Quick Build');
    expect(store.resolveAgentId('Slow Build')).toBeNull();
    expect(store.resolveAgentId('')).toBeNull();
  });

  it('never resolves a person row as an agent', () => {
    const store = new Identities({ dataDir });
    store.upsertByEmail('alice@example.com');
    expect(store.resolveAgentId('Alice')).toBeNull();
    expect(store.resolveAgentId(emailIdentityId('alice@example.com'))).toBeNull();
  });

  it('refuses the shared category identity — a category is not somebody', () => {
    const store = new Identities({ dataDir });
    expect(store.upsertAgent('known-agent', 'Agent')).toBeNull();
    expect(store.upsertAgent('agent')).toBeNull();
    expect(store.list()).toHaveLength(0);
  });

  it('keeps a chosen display name across a re-attach that sends none', () => {
    const store = new Identities({ dataDir });
    store.upsertAgent('agent-quick-build', 'Quick Build');
    const again = store.upsertAgent('agent-quick-build');
    expect(again?.displayName).toBe('Quick Build');
    expect(store.list()).toHaveLength(1);
  });

  it('agent rows survive a reload, and person rows written before `kind` load as people', () => {
    writeFileSync(
      join(dataDir, 'identities.json'),
      JSON.stringify({
        version: 1,
        identities: {
          [emailIdentityId('alice@example.com')]: {
            id: emailIdentityId('alice@example.com'),
            email: 'alice@example.com',
            displayName: 'Alice',
          },
          'agent-quick-build': {
            id: 'agent-quick-build',
            kind: 'agent',
            displayName: 'Quick Build',
          },
          // An agent row with no email is NOT the broken-person case above.
          'agent-no-name': { kind: 'agent' },
        },
      }),
    );
    const store = new Identities({ dataDir });
    expect(store.loadError).toBeNull();
    expect(store.get(emailIdentityId('alice@example.com'))?.kind).toBe('person');
    expect(store.get('agent-quick-build')?.kind).toBe('agent');
    expect(store.get('agent-no-name')?.displayName).toBe('agent-no-name');
    expect(store.resolveAgentId('Quick Build')).toBe('agent-quick-build');
  });
});
