/**
 * The mount-time edit-mode decision — the one that decides whether a document
 * is typeable in its first frame.
 *
 * This is a regression suite for a measured bug. The mount used to read the
 * stored preference, call `setEditable(true)`, and only then ask
 * `/api/auth/session`; the document was live for exactly one session round
 * trip, which measured 0ms on loopback, 197ms with 200ms of injected latency
 * and 594ms with 600ms — and this product's stated deployment is a Cloudflare
 * Tunnel, where that range is ordinary. Text typed in the window appeared,
 * said "Unsaved changes", reverted with no modal and no toast when the answer
 * landed, and was gone on reload: never in the ydoc (the socket is read-only
 * server-side) and never on disk. Prose rides the yjs socket, so no HTTP 401
 * exists to catch it afterwards.
 *
 * The precondition is ordinary rather than exotic: `lf:edit-mode` is global,
 * cross-doc and permanent, written on every press of the pencil and never
 * cleared. Anyone who has once edited any doc in this browser is armed for
 * every doc after.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  EDIT_MODE_KEY,
  defaultEditMode,
  initialEditMode,
  readEditModePref,
  writeEditModePref,
} from '../src/edit-mode.ts';

beforeEach(() => {
  localStorage.removeItem(EDIT_MODE_KEY);
});

describe('the stored preference', () => {
  it('defaults to view, and reads back what was written', () => {
    expect(readEditModePref()).toBe('view');
    writeEditModePref('edit');
    expect(readEditModePref()).toBe('edit');
    writeEditModePref('view');
    expect(readEditModePref()).toBe('view');
  });

  it('ignores a value it did not write', () => {
    localStorage.setItem(EDIT_MODE_KEY, 'suggesting');
    expect(readEditModePref()).toBe(defaultEditMode());
  });
});

describe('the mode a doc may MOUNT in', () => {
  // The bug, stated as a test: this is the exact state the reviewer
  // reproduced — `edit` stored from some earlier doc, and a server that will
  // not take this browser's writes.
  it('is view when the server refuses this browser, whatever the preference says', () => {
    writeEditModePref('edit');
    expect(initialEditMode(false)).toBe('view');
  });

  // The other half, and the reason this cannot be "always view": a browser
  // that may write still gets the mode its owner chose, in the first frame.
  it('is the stored preference when the server accepts this browser', () => {
    writeEditModePref('edit');
    expect(initialEditMode(true)).toBe('edit');
    writeEditModePref('view');
    expect(initialEditMode(true)).toBe('view');
  });

  // A refusal is a lock, not a reset. This browser may be signed in again in
  // a minute, and the preference is still what this person likes — clearing
  // it would silently change their setting on the way past.
  it('does not clear the preference it is overriding', () => {
    writeEditModePref('edit');
    initialEditMode(false);
    expect(localStorage.getItem(EDIT_MODE_KEY)).toBe('edit');
    expect(initialEditMode(true)).toBe('edit');
  });
});
