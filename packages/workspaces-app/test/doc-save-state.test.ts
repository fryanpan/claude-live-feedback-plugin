import type { FeedbackClient } from '@feedback/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { mountDocSaveState } from '../src/doc/doc-save-state.ts';
import { MountScope } from '../src/mount-scope.ts';

/**
 * The `#save-state` chip (doc/doc-save-state.ts).
 *
 * Two facts drive it and they are deliberately not one: the raw socket
 * decides whether an edit may be CALLED saved, and the graced view decides
 * what the chip SAYS. The tests below drive both independently, because the
 * bug this module exists to prevent is a second writer reporting one from
 * the other — "All changes saved" over a socket that is not there.
 *
 * The teardown is load-bearing too: `#save-state` is shared chrome, so a
 * debounce armed by THIS mount must not rewrite it over the next document.
 */

const open: Array<() => void> = [];
afterEach(() => {
  for (const f of open.splice(0).reverse()) f();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="save-state"></div>';
});

const chip = () => document.getElementById('save-state') as HTMLElement;

/** A client whose socket status and ready callbacks the test drives by hand. */
function fakeClient() {
  const statusCbs: Array<(s: string) => void> = [];
  const ws = { fake: true };
  const client = {
    ws,
    onStatus: (cb: (s: string) => void) => statusCbs.push(cb),
    onReady: () => {},
  } as unknown as FeedbackClient;
  return {
    client,
    ws,
    status: (s: 'open' | 'closed') => {
      for (const cb of [...statusCbs]) cb(s);
    },
  };
}

function mount(canWrite = true) {
  const { client, ws, status } = fakeClient();
  const ydoc = new Y.Doc();
  const scope = new MountScope();
  mountDocSaveState({ client, ydoc, canWrite, scope });
  open.push(() => {
    scope.dispose();
    ydoc.destroy();
  });
  return { ydoc, scope, status, ws };
}

/** A local edit — anything whose origin is not the server's socket. */
function typeSomething(ydoc: Y.Doc, text = 'hello'): void {
  ydoc.getText('t').insert(0, text);
}

describe('the save-state chip', () => {
  it('starts by saying the document is saved', () => {
    mount();
    expect(chip().textContent).toBe('All changes saved');
    expect(chip().classList.contains('save-state--saved')).toBe(true);
  });

  it('says a local edit is unsaved the moment it is made', () => {
    const { ydoc } = mount();
    typeSomething(ydoc);
    expect(chip().textContent).toBe('Unsaved changes');
    expect(chip().classList.contains('save-state--dirty')).toBe(true);
  });

  it('calls the edit saved once typing stops — but only with a socket up', () => {
    const { ydoc, status } = mount();
    typeSomething(ydoc);
    // Typing stopped with nothing listening: still unsaved, however long we
    // wait. This is the whole reason the raw socket is tracked separately.
    vi.advanceTimersByTime(1000);
    expect(chip().textContent).toBe('Unsaved changes');

    // The socket comes back and the edit settles without another keystroke.
    status('open');
    vi.advanceTimersByTime(600);
    expect(chip().textContent).toBe('All changes saved');
  });

  it('ignores an update that came FROM the server', () => {
    const { ydoc, ws } = mount();
    Y.transact(ydoc, () => ydoc.getText('t').insert(0, 'remote'), ws);
    expect(chip().textContent).toBe('All changes saved');
  });

  it('says reconnecting once a drop has outlasted the grace window', () => {
    const { status } = mount();
    status('closed');
    // Inside the grace window a blip must not repaint the chip.
    expect(chip().textContent).toBe('All changes saved');
    vi.advanceTimersByTime(10_000);
    expect(chip().textContent).toBe('Reconnecting…');
    expect(chip().classList.contains('save-state--offline')).toBe(true);
    // And it clears itself when the socket returns — no reload.
    status('open');
    expect(chip().textContent).toBe('All changes saved');
  });

  it('says nothing at all on a surface that cannot save', () => {
    const { ydoc } = mount(false);
    expect(chip().textContent).toBe('');
    typeSomething(ydoc);
    expect(chip().textContent).toBe('');
  });

  it('blanks the shared chip on teardown, and no armed debounce rewrites it', () => {
    const { ydoc, scope, status } = mount();
    status('open');
    typeSomething(ydoc);
    expect(chip().textContent).toBe('Unsaved changes');

    scope.dispose();
    expect(chip().textContent).toBe('');
    expect(chip().classList.contains('save-state--dirty')).toBe(false);

    // The next document owns the chip now. The debounce this mount armed
    // must not come back and write over it.
    chip().textContent = 'the next document';
    vi.advanceTimersByTime(2000);
    expect(chip().textContent).toBe('the next document');
  });
});
