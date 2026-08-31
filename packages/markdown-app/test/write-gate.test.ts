import { readFileSync } from 'node:fs';
import { join } from 'node:path';
/**
 * What a person sees when the server refuses their write.
 *
 * The server's half is covered in `packages/server/test/auth-write-gate.test.ts`.
 * This file covers the half that decides whether the refusal is USEFUL: a 401
 * the UI swallows is not a gate, it is a comment that vanished.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetReadingCrumbForTest } from '../src/huddle-entry.ts';
import { openCompanionDoc } from '../src/redline/redline-app.ts';
import {
  WRITE_ACCESS_LOOKUP_MS,
  WRITE_CONTROL_ATTR,
  asBackgroundWrite,
  fetchWriteAccess,
  installWriteGateNotice,
  isSignInRequired,
  lockDocToReading,
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
  document.body.className = '';
  document.querySelector('.identity-prompt')?.remove();
});

/** The doc surface's shell: a two-row grid the bar has to become a row of. */
function docShell(): HTMLElement {
  const shell = document.createElement('div');
  shell.id = 'shell';
  const topbar = document.createElement('header');
  topbar.id = 'topbar';
  const main = document.createElement('main');
  shell.append(topbar, main);
  document.body.append(shell);
  return shell;
}

/** The board's shell: ordinary flow, one header, no `#shell` at all. */
function hubShell(): HTMLElement {
  const root = document.createElement('div');
  root.id = 'hub-root';
  const topbar = document.createElement('header');
  topbar.className = 'hub-topbar';
  const main = document.createElement('div');
  main.className = 'hub-main';
  root.append(topbar, main);
  document.body.append(root);
  return root;
}

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
  // The regression that fired with the FLAG OFF, i.e. for everybody.
  //
  // `main()` awaits this before anything renders. The three failure modes it
  // already handled all produce a value — a throw, a !ok, junk JSON — and a
  // route that simply never answers produces none of them, so `await` on it
  // was forever. Measured against an origin/main control with the session
  // route held open: main rendered the document, the branch showed
  // permanently blank chrome at 15s and again at 25s.
  it('gives up on a route that never answers, and reads that as MAY write', async () => {
    vi.useFakeTimers();
    try {
      const never = vi.fn(() => new Promise<Response>(() => {}));
      vi.stubGlobal('fetch', never);
      const asked = fetchWriteAccess();
      let settled = false;
      void asked.then(() => {
        settled = true;
      });

      // The control for the assertion below: BEFORE the bound elapses this
      // really is still waiting, so the timeout is what resolves it and not
      // some path that never waited at all.
      await vi.advanceTimersByTimeAsync(WRITE_ACCESS_LOOKUP_MS - 1);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(2);
      await expect(asked).resolves.toEqual({ signInToWrite: false, canWrite: true });
      expect(never).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  // And the other control: the bound must not be winning every race. A server
  // that answers gets its answer honoured, refusal included.
  it('still takes a real answer that arrives in time', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, { signInToWrite: true, canWrite: false })),
    );
    try {
      await expect(fetchWriteAccess()).resolves.toEqual({
        signInToWrite: true,
        canWrite: false,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

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

  it('dismisses on a click on the scrim, and not on one inside the card', () => {
    promptSignIn('Sign in to comment or edit here.');
    const overlay = document.querySelector<HTMLElement>('.signin-required');
    if (!overlay) throw new Error('no overlay');
    // Inside the card first: closing on this would make the card unusable.
    overlay
      .querySelector('.identity-card')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.querySelector('.signin-required')).not.toBeNull();
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.querySelector('.signin-required')).toBeNull();
  });

  it('renders the server message as TEXT, never as markup', () => {
    promptSignIn('<img src=x onerror=alert(1)>');
    const card = document.querySelector('.signin-required .identity-card');
    expect(card?.querySelector('img')).toBeNull();
    expect(card?.textContent).toContain('<img src=x');
    document.querySelector('.signin-required')?.remove();
  });

  it('shows the standing bar only once', () => {
    docShell();
    showSignInBar();
    showSignInBar();
    expect(document.querySelectorAll('.signin-bar').length).toBe(1);
  });
});

describe('where the standing bar lands', () => {
  // It used to be one fixed overlay offset by the doc topbar's measured
  // height. On the board there is no `#topbar` to measure, so it fell back to
  // a constant and covered the action row — "Start a planning huddle" could
  // not be clicked at all — and at 430px on the doc it covered the H1 and the
  // format bar. These assert it takes SPACE on each surface instead.
  it('becomes a declared row of the doc shell, above the topbar', () => {
    const shell = docShell();
    showSignInBar();
    const bar = document.querySelector('.signin-bar');
    expect(bar?.parentElement).toBe(shell);
    expect(shell.firstElementChild).toBe(bar);
    // The grid has two declared tracks; without this class the bar would be
    // laid into the topbar's 48px and clipped.
    expect(document.body.classList.contains('signin-gated')).toBe(true);
    expect(bar?.classList.contains('signin-bar--floating')).toBe(false);
  });

  it('becomes a row under the board header, where the connection banner sits', () => {
    const root = hubShell();
    showSignInBar();
    const bar = document.querySelector('.signin-bar');
    expect(bar?.parentElement).toBe(root);
    expect(bar?.previousElementSibling?.className).toBe('hub-topbar');
    expect(bar?.classList.contains('signin-bar--floating')).toBe(false);
    // The doc shell's row declaration must not leak onto a surface that has
    // no `#shell` to declare rows on.
    expect(document.body.classList.contains('signin-gated')).toBe(false);
  });

  it('falls back to a floating bar on a surface with no header to sit under', () => {
    // Still says it. There is no layout here to be sure of, so it floats —
    // and docks to the BOTTOM, because the top of an unknown page is the band
    // most likely to already be spoken for.
    showSignInBar();
    const bar = document.querySelector('.signin-bar');
    expect(bar?.parentElement).toBe(document.body);
    expect(bar?.classList.contains('signin-bar--floating')).toBe(true);
  });
});

describe('locking the doc to reading', () => {
  // The bug this exists for: the edit toggle was disabled and Suggesting was
  // not. One click on Suggesting set contenteditable="true", took the
  // reader's typing, said "All changes saved", and lost every word on
  // reload — while the socket was correctly read-only server-side the whole
  // time. A gate that is right on the wire and wrong in the UI still loses
  // the user's words.
  function toggles(): HTMLElement {
    const root = document.createElement('div');
    root.innerHTML = `
      <button id="toggle-edit-mode" ${WRITE_CONTROL_ATTR}></button>
      <button id="toggle-suggest-mode" ${WRITE_CONTROL_ATTR}></button>
      <button id="toggle-format"></button>`;
    document.body.append(root);
    return root;
  }

  it('disables EVERY marked control, not just the one the gate knew about', () => {
    const root = toggles();
    const locked = lockDocToReading({
      stopSuggesting: () => {},
      toViewMode: () => {},
      root,
    });
    expect(locked.map((b) => b.id).sort()).toEqual(['toggle-edit-mode', 'toggle-suggest-mode']);
    for (const b of locked) {
      expect(b.disabled).toBe(true);
      // Says why, and names the fix — a disabled control with no explanation
      // is a dead end.
      expect(b.title).toMatch(/sign in/i);
      expect(b.getAttribute('aria-label')).toMatch(/sign in/i);
    }
  });

  it('leaves an unmarked control alone', () => {
    // The control for the assertion above: if it disabled everything in
    // reach, "both toggles are disabled" would be true of a lock that had
    // also taken out the reader's format bar and their back button.
    const root = toggles();
    lockDocToReading({ stopSuggesting: () => {}, toViewMode: () => {}, root });
    expect(root.querySelector<HTMLButtonElement>('#toggle-format')?.disabled).toBe(false);
  });

  it('turns Suggesting off and returns the surface to view mode', () => {
    const calls: string[] = [];
    lockDocToReading({
      stopSuggesting: () => calls.push('suggest-off'),
      toViewMode: () => calls.push('view'),
      root: toggles(),
    });
    expect(calls).toEqual(['suggest-off', 'view']);
  });

  // The chrome moved INTO the lock because it was at one call site and only
  // one of three surfaces had it: signed out, the redline and code surfaces
  // went on reading "Editing: notes.md" beside "All changes saved" over an
  // editor that would take nothing.
  it('puts the crumb back to Reading and blanks the save-state chip', () => {
    resetReadingCrumbForTest();
    const root = document.createElement('div');
    root.innerHTML = `
      <span class="doc-crumb"><span class="doc-label">Editing:</span></span>
      <span id="save-state" class="save-state save-state--saved">All changes saved</span>`;
    document.body.append(root);
    // The control: the shell really is wearing an editor's chrome first, so
    // the assertions below have something to change.
    expect(root.querySelector('.doc-label')?.textContent).toBe('Editing:');
    expect(root.querySelector('#save-state')?.textContent).toBe('All changes saved');

    lockDocToReading({ root });

    expect(document.querySelector('.doc-label')?.textContent).toBe('Reading:');
    const chip = root.querySelector('#save-state') as HTMLElement;
    expect(chip.textContent).toBe('');
    expect(chip.className).not.toContain('save-state--saved');
    resetReadingCrumbForTest();
  });

  // The redline and code surfaces have neither mode to put back, and a
  // surface with nothing to undo should not have to pass two empty functions
  // to say so.
  it('locks a surface that has no Suggesting and no view/edit mode of its own', () => {
    const root = toggles();
    expect(() => lockDocToReading({ root })).not.toThrow();
    expect(root.querySelector<HTMLButtonElement>('#toggle-edit-mode')?.disabled).toBe(true);
  });

  it('the shipped markup actually carries the marker on both toggles', () => {
    // The lock reads the DOM, so the lock passing its own unit test proves
    // nothing about the real page. This reads the file the server serves.
    const html = readFileSync(join(import.meta.dirname, '..', 'index.html'), 'utf8');
    for (const id of ['toggle-edit-mode', 'toggle-suggest-mode']) {
      const tag = html.slice(html.indexOf(`id="${id}"`));
      expect(tag.slice(0, tag.indexOf('>'))).toContain(WRITE_CONTROL_ATTR);
    }
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
    const res = await fetch('/api/docs/d1/threads', { method: 'POST' });

    expect(document.querySelector('.signin-required')).not.toBeNull();
    // The caller's own error handling still runs on a readable body — the
    // wrapper reads a clone, so nothing downstream sees a consumed stream.
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'sign_in_required' });
  });

  it("does NOT interrupt a reader when the refused write was the app's own", async () => {
    // The reading tracker POSTs on load and on leave. Measured on a real
    // gated doc, it raised the modal over a document the reader had not
    // touched. Marked writes get the standing bar instead — the same answer,
    // without the interruption.
    //
    // The first version of this decided by CLOCK: a modal if any pointerdown
    // had happened in the last five seconds. It was right about most
    // sequences and could not be right about any particular one, because a
    // background POST landing just after an unrelated click inherited that
    // click. The call site says which it is now.
    next = jsonResponse(401, { error: 'sign_in_required' });
    const res = asBackgroundWrite(() => fetch('/api/docs/d1/reading-time', { method: 'POST' }));
    await res;
    expect(document.querySelector('.signin-required')).toBeNull();
    expect(document.querySelector('.signin-bar')).not.toBeNull();
  });

  it('marks only the request inside the callback, not the ones after it', async () => {
    // The positive control for the mechanism: the SAME url and method that
    // just got the quiet treatment must raise the modal once the marker is
    // gone. Without this, a marker stuck permanently on would look identical
    // to a marker working.
    next = jsonResponse(401, { error: 'sign_in_required' });
    await asBackgroundWrite(() => fetch('/api/docs/d1/reading-time', { method: 'POST' }));
    document.querySelector('.signin-bar')?.remove();
    expect(document.querySelector('.signin-required')).toBeNull();

    await fetch('/api/docs/d1/reading-time', { method: 'POST' });
    expect(document.querySelector('.signin-required')).not.toBeNull();
    document.querySelector('.signin-required')?.remove();
  });

  it('restores the marker when the marked call throws', async () => {
    expect(() =>
      asBackgroundWrite(() => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    // A leaked marker would silence every later refusal — the exact failure
    // the modal exists to prevent, arrived at from the other side.
    next = jsonResponse(401, { error: 'sign_in_required' });
    await fetch('/api/docs/d1/threads', { method: 'POST' });
    expect(document.querySelector('.signin-required')).not.toBeNull();
    document.querySelector('.signin-required')?.remove();
  });

  it('leaves a successful write completely alone', async () => {
    next = jsonResponse(200, { ok: true });
    const res = await fetch('/api/docs/d1/threads', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(document.querySelector('.signin-required')).toBeNull();
  });

  it('leaves a 401 that is NOT the write gate alone', async () => {
    next = jsonResponse(401, { error: 'widget_token_invalid' });
    await fetch('/api/anything', { method: 'POST' });
    expect(document.querySelector('.signin-required')).toBeNull();
  });

  it('opens a redline companion quietly — a refusal there is not a write anybody made', async () => {
    // The real call site, not a re-creation of it. Opening the companion is
    // the FIRST thing the redline surface does, before the reader has
    // touched anything; unmarked, a 401 there raised the blocking modal on
    // plain page load. The server no longer refuses this route, so this is
    // the belt to that braces — a 401 arriving for any other reason (an
    // older server, a share that lapsed) must still not interrupt a reader.
    next = jsonResponse(401, { error: 'sign_in_required' });
    const ctx = {
      workspaceId: 'rev-1',
      relPath: 'notes.md',
      scope: { disposed: false },
    } as unknown as Parameters<typeof openCompanionDoc>[0];

    await expect(openCompanionDoc(ctx)).resolves.toBeNull();
    expect(document.querySelector('.signin-required')).toBeNull();
    expect(document.querySelector('.signin-bar')).not.toBeNull();
    document.querySelector('.signin-bar')?.remove();
  });
});
