/**
 * What a person sees when the server refuses their write.
 *
 * The server's half is covered in `packages/server/test/auth-write-gate.test.ts`.
 * This file covers the half that decides whether the refusal is USEFUL: a 401
 * the UI swallows is not a gate, it is a comment that vanished.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchWriteAccess,
  installWriteGateNotice,
  isSignInRequired,
  markGestureForTest,
  promptSignIn,
  showSignInBar,
  signInHref,
} from '../src/signin/write-gate.ts';

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

beforeEach(() => {
  document.body.replaceChildren();
  document.querySelector('.identity-prompt')?.remove();
});

describe('recognising the refusal', () => {
  it('matches the body the server actually sends', () => {
    expect(isSignInRequired({ error: 'sign_in_required', signInUrl: '/signin' })).toBe(true);
  });

  it('ignores every other 401 body', () => {
    // A dead widget token and a share that expired are both 401s with their
    // own handling. Raising a sign-in prompt over them would be wrong.
    for (const body of [
      { error: 'widget_token_invalid' },
      { error: 'not_signed_in' },
      { error: 'session_needs_refresh' },
      {},
      null,
      'sign_in_required',
    ]) {
      expect(isSignInRequired(body)).toBe(false);
    }
  });
});

describe('the way back', () => {
  it('sends the person to sign-in and remembers where they were', () => {
    expect(signInHref('/review/doc-1', '?thread=t1')).toBe(
      '/signin?next=%2Freview%2Fdoc-1%3Fthread%3Dt1',
    );
  });
});

describe('asking whether this browser may write', () => {
  it('reads the server answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, { signInToWrite: true, canWrite: false })),
    );
    expect(await fetchWriteAccess()).toEqual({ signInToWrite: true, canWrite: false });
    vi.unstubAllGlobals();
  });

  it('fails OPEN when the session route is unreachable', async () => {
    // A server that cannot answer must never lock somebody out of a surface
    // it would have accepted them on. The gate lives on the server; this is
    // only the client being polite about it.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    expect(await fetchWriteAccess()).toEqual({ signInToWrite: false, canWrite: true });
    vi.unstubAllGlobals();
  });
});

describe('what the person is shown', () => {
  it('raises a prompt carrying the action, not a bare failure', () => {
    promptSignIn('Sign in to comment or edit here.');
    const card = document.querySelector('.signin-required [role="dialog"]');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain('Sign in');
    const go = document.querySelector<HTMLAnchorElement>('.signin-required-go');
    expect(go?.getAttribute('href')).toContain('/signin?next=');
    document.querySelector('.signin-required')?.remove();
  });

  it('renders the server message as TEXT, never as markup', () => {
    promptSignIn('<img src=x onerror=alert(1)>');
    const card = document.querySelector('.signin-required .identity-card');
    expect(card?.querySelector('img')).toBeNull();
    expect(card?.textContent).toContain('<img src=x');
    document.querySelector('.signin-required')?.remove();
  });

  it('shows the standing bar only once', () => {
    showSignInBar();
    showSignInBar();
    expect(document.querySelectorAll('.signin-bar').length).toBe(1);
  });
});

describe('the fetch wrapper', () => {
  // ONE stub for the whole block, installed once. `installWriteGateNotice`
  // wraps whatever `fetch` is at install time and refuses to install twice —
  // so a per-test `vi.unstubAllGlobals()` would restore the raw fetch and
  // silently un-wrap it, and every assertion after the first would be
  // measuring an uninstalled wrapper rather than the behaviour it names.
  let next: Response = jsonResponse(200, { ok: true });
  beforeAll(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => next.clone()),
    );
    installWriteGateNotice();
  });
  afterAll(() => vi.unstubAllGlobals());

  it('raises the prompt on a refused write the person just made, and hands the caller an untouched response', async () => {
    next = jsonResponse(401, { error: 'sign_in_required' });
    markGestureForTest();
    const res = await fetch('/api/docs/d1/threads', { method: 'POST' });

    expect(document.querySelector('.signin-required')).not.toBeNull();
    // The caller's own error handling still runs on a readable body — the
    // wrapper reads a clone, so nothing downstream sees a consumed stream.
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'sign_in_required' });
  });

  it("does NOT interrupt a reader when the refused write was the app's own", async () => {
    // The reading tracker, link titles and the push reconciler all POST on
    // load. Measured on a real gated doc: one of them raised the modal over a
    // document the reader had not touched. They get the standing bar
    // instead — the same answer, without the interruption.
    next = jsonResponse(401, { error: 'sign_in_required' });
    markGestureForTest(0);
    await fetch('/api/docs/d1/reading-time', { method: 'POST' });
    expect(document.querySelector('.signin-required')).toBeNull();
    expect(document.querySelector('.signin-bar')).not.toBeNull();
  });

  it('leaves a successful write completely alone', async () => {
    next = jsonResponse(200, { ok: true });
    markGestureForTest();
    const res = await fetch('/api/docs/d1/threads', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(document.querySelector('.signin-required')).toBeNull();
  });

  it('leaves a 401 that is NOT the write gate alone', async () => {
    next = jsonResponse(401, { error: 'widget_token_invalid' });
    markGestureForTest();
    await fetch('/api/anything', { method: 'POST' });
    expect(document.querySelector('.signin-required')).toBeNull();
  });
});
