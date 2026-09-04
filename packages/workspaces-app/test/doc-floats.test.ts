import type { User } from '@feedback/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { mountDocFloats } from '../src/doc/doc-floats.ts';
import { MountScope } from '../src/mount-scope.ts';

/**
 * The two always-in-view floats a document carries (doc/doc-floats.ts):
 * Approve (the plan gate) and Review.
 *
 * One module because they are one row and one condition: both hang off the
 * same `meta` map for a transition no event stream carries, and the order
 * they mount in IS the order they read in — plan, then review. Split across
 * two call sites, that ordering is an accident waiting to be reversed.
 */

const open: Array<() => void> = [];
afterEach(() => {
  for (const f of open.splice(0).reverse()) f();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

beforeEach(() => {
  document.body.innerHTML = '<main id="editor-pane"><div id="editor"></div></main>';
});

const testUser: User = { id: 'u1', name: 'Alice', kind: 'known', color: '#2e7dd7' };

const floats = () => [...document.querySelectorAll('#editor-pane .plan-float')];

/** Answers every read with a plain markdown doc, and counts the reads. */
function stubFetch() {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(String(url));
      return { ok: true, json: async () => ({ meta: {} }) } as Response;
    }),
  );
  return calls;
}

function mount() {
  const calls = stubFetch();
  const ydoc = new Y.Doc();
  const scope = new MountScope();
  mountDocFloats({
    docId: 'd1',
    root: document.getElementById('editor') as HTMLElement,
    ydoc,
    user: testUser,
    canWrite: true,
    scope,
  });
  open.push(() => {
    scope.dispose();
    ydoc.destroy();
  });
  return { ydoc, scope, calls };
}

describe('the float row', () => {
  it('mounts the plan gate first and the Review float after it', () => {
    mount();
    const row = floats();
    expect(row).toHaveLength(2);
    // Review carries its own face; the plan gate is the bare float.
    expect(row[0]?.classList.contains('review-float')).toBe(false);
    expect(row[1]?.classList.contains('review-float')).toBe(true);
  });

  it('both start hidden — a float appears because something needs doing', () => {
    mount();
    for (const f of floats()) expect((f as HTMLElement).hidden).toBe(true);
  });
});

describe('the metadata watch', () => {
  it('re-reads the doc when its meta map changes', async () => {
    const { ydoc, calls } = mount();
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
    const before = calls.length;
    // `setPlanState` writes into this same map on the server; observing it is
    // how the floats hear that the plan landed — no event stream carries it.
    ydoc.getMap('meta').set('planState', 'approved');
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(before));
  });

  it('stops watching when the mount is torn down', async () => {
    const { ydoc, scope, calls } = mount();
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
    scope.dispose();
    const after = calls.length;
    ydoc.getMap('meta').set('planState', 'approved');
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.length).toBe(after);
  });
});

describe('teardown', () => {
  it('takes both floats off the pane', () => {
    const { scope } = mount();
    expect(floats()).toHaveLength(2);
    scope.dispose();
    expect(floats()).toHaveLength(0);
  });
});
