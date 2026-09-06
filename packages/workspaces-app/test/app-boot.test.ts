/**
 * The document editor's boot sequence, driven.
 *
 * `bootApp` used to be `main()` running on import, which is why nothing in this
 * suite could load `app.ts` at all and its wiring was pinned by reading its own
 * source text. It takes its environment now, so these drive the real sequence
 * against the app's REAL shell (`index.html`, read as the fixture it is — the
 * boot's element lookups are only meaningful against the markup they were
 * written for) and assert what the boot did: what it asked the server, what
 * identity it resolved, which surface it mounted for the address, and the one
 * socket it opened.
 *
 * All fixtures synthetic apart from the shell itself.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AppBootEnv, bootApp } from '../src/app.ts';
import { SIGN_IN_REQUIRED } from '../src/signin/write-gate.ts';
import {
  type FakeServer,
  type FakeSockets,
  type FakeStorage,
  fakeLocation,
  fakeSockets,
  fakeStorage,
  firstAt,
  installFakeBeacon,
  installFakeEventSource,
  installFakeServer,
  settle,
} from './boot-harness.ts';

const server: FakeServer = installFakeServer();
installFakeEventSource();
installFakeBeacon();

const NAME_KEY = 'feedback-user-name';

/**
 * The shipped shell, so the boot's `getElementById` calls mean what they mean
 * in a browser. A hand-written subset would drift out from under them.
 *
 * `<script>` tags are cut: the shell ends with `<script src="/app/app.js">`,
 * and this suite IS that bundle's entry — leaving it in makes the test document
 * try to fetch the built app off a dev server that is not running.
 */
const SHELL = (() => {
  const html = readFileSync(resolve(import.meta.dirname, '..', 'index.html'), 'utf8');
  const open = html.indexOf('<body');
  const start = html.indexOf('>', open) + 1;
  return html.slice(start, html.indexOf('</body>')).replace(/<script\b[\s\S]*?<\/script>/g, '');
})();

interface Booted {
  sockets: FakeSockets;
  storage: FakeStorage;
  location: ReturnType<typeof fakeLocation>;
}

/**
 * Every boot this file starts, so `afterEach` can stop it. Emptying
 * `document.body` is not an end: the router's mount is still live, and a live
 * markdown mount holds a 100ms relayout debounce that the boot's own opening
 * transaction armed. Land that after vitest has torn the environment down and
 * `markup-margin`'s `toggleClearanceY` reads a `document` that no longer
 * exists — an unhandled `ReferenceError` that fails a run in which every test
 * passed, charged to whichever file the worker happened to be on.
 */
const booted: Array<() => void> = [];

/** Run the boot, and register its teardown for `afterEach`. */
async function start(env: AppBootEnv): Promise<void> {
  booted.push(await bootApp(env));
}

async function boot(url: string, seed: Record<string, string> = {}): Promise<Booted> {
  const parsed = new URL(url);
  document.body.innerHTML = SHELL;
  // The router reads the ambient path — it is the shell's own module, not part
  // of the boot's injected environment. Put the browser where the test says.
  history.replaceState(null, '', parsed.pathname + parsed.search);
  const sockets = fakeSockets();
  const storage = fakeStorage({ [NAME_KEY]: 'Ada', ...seed });
  const location = fakeLocation(url);
  const env: AppBootEnv = {
    document,
    location,
    localStorage: storage,
    window: new EventTarget(),
    connect: sockets.connect,
  };
  await start(env);
  await settle();
  return { sockets, storage, location };
}

beforeEach(() => {
  server.reset();
  server.on('/api/auth/session', { authenticated: false, canWrite: true });
  server.on('/api/docs/', { meta: { type: 'markdown', relPath: 'notes.md' } });
});

afterEach(() => {
  // Before the markup goes: stopping the router disposes the live mount, and
  // that is what clears its debounced timers (see `booted` above).
  for (const stop of booted.splice(0)) stop();
  document.body.innerHTML = '';
  // The boot writes its mode onto the body itself (`code-mode`, `has-set`, …),
  // and one document serves every test in the file. Emptying the markup leaves
  // those behind, so the next boot would start on the last one's page state.
  document.body.className = '';
  history.replaceState(null, '', '/');
});

describe('the editor boots against the doc the address names', () => {
  it('asks the server for that doc, and opens one socket for it', async () => {
    const { sockets } = await boot('https://docs.test/review/d-notes');
    expect(server.calls.some((c) => c.url === '/api/docs/d-notes')).toBe(true);
    expect(sockets.opened).toHaveLength(1);
    expect(sockets.first().url).toBe('wss://docs.test/y/d-notes?type=markdown');
  });

  it('uses a plain ws socket on an http page', async () => {
    const { sockets } = await boot('http://localhost:8787/review/d-notes');
    expect(sockets.first().url).toBe('ws://localhost:8787/y/d-notes?type=markdown');
  });

  it('reads the doc id out of a workspace path too', async () => {
    const { sockets } = await boot('https://docs.test/workspaces/w-1/docs/d-notes');
    expect(sockets.first().url).toContain('/y/d-notes?');
  });

  it('mounts the `default` doc when the path names none', async () => {
    // Inherited and deliberate (`docIdFromPath`): a path addressing no doc is
    // the widget's unbound surface, not an error — so the boot opens `default`
    // rather than refusing and leaving a blank shell.
    const { sockets } = await boot('https://docs.test/');
    expect(sockets.opened).toHaveLength(1);
    expect(sockets.first().url).toBe('wss://docs.test/y/default?type=markdown');
  });

  it('percent-decodes a doc id with a colon in it', async () => {
    const { sockets } = await boot('https://docs.test/review/rev-1%3Asrc~app.ts');
    expect(sockets.first().url).toBe(
      `wss://docs.test/y/${encodeURIComponent('rev-1:src~app.ts')}?type=markdown`,
    );
  });
});

/**
 * The two lists the review sidebar asks for once a doc belongs to a workspace.
 *
 * A one-file review is enough for every assertion here — the surface that
 * mounts is what these tests are about — but the routes have to EXIST: the nav
 * render reads `groups` straight off the body, so an unrouted request answers
 * `{}` and throws inside a render nothing awaits.
 */
function reviewOf(workspaceId: string, relPath: string): void {
  server.on(`/api/reviews/${workspaceId}/grouped`, { groups: [] });
  server.on(`/api/reviews/${workspaceId}/files`, {
    files: [{ docId: `${workspaceId}:${relPath}`, relPath, status: 'modified' }],
  });
}

describe('the surface that mounts matches what the doc IS', () => {
  it('a markdown doc mounts the prose editor', async () => {
    await boot('https://docs.test/review/d-notes');
    expect(document.querySelector('#editor .ProseMirror')).not.toBeNull();
    expect(document.body.classList.contains('code-mode')).toBe(false);
  });

  it('a code doc mounts the source surface instead', async () => {
    server.on('/api/docs/', { meta: { type: 'code', relPath: 'server.ts' } });
    await boot('https://docs.test/review/d-code');
    expect(document.body.classList.contains('code-mode')).toBe(true);
    expect(document.querySelector('#editor .ProseMirror')).toBeNull();
  });

  it('a MARKDOWN file inside a diff review reads as prose, not as source', async () => {
    server.on('/api/docs/', {
      meta: { type: 'diff', relPath: 'README.md', workspaceId: 'rev-1' },
    });
    reviewOf('rev-1', 'README.md');
    server.on(`/api/docs/${encodeURIComponent('rev-1:README.md')}/diff`, {
      baseText: '# Title\n\nOne line before.\n',
      status: 'modified',
    });
    await boot('https://docs.test/review/rev-1%3AREADME.md');
    // The redline surface is the prose one; the point of the branch is that a
    // `.md` in a diff is NOT sent to the code surface.
    expect(document.body.classList.contains('redline-mode')).toBe(true);
    expect(document.body.classList.contains('code-mode')).toBe(false);
  });

  it('a markdown diff whose base text is gone falls back to the source view', async () => {
    server.on('/api/docs/', {
      meta: { type: 'diff', relPath: 'README.md', workspaceId: 'rev-1' },
    });
    reviewOf('rev-1', 'README.md');
    server.on(`/api/docs/${encodeURIComponent('rev-1:README.md')}/diff`, { baseText: null });
    await boot('https://docs.test/review/rev-1%3AREADME.md');
    expect(document.body.classList.contains('redline-mode')).toBe(false);
    expect(document.body.classList.contains('code-mode')).toBe(true);
  });

  it('a non-markdown file inside a diff review goes to the source surface', async () => {
    server.on('/api/docs/', {
      meta: { type: 'diff', relPath: 'src/server.ts', workspaceId: 'rev-1' },
    });
    reviewOf('rev-1', 'src/server.ts');
    await boot('https://docs.test/review/rev-1%3Asrc~server.ts');
    expect(document.body.classList.contains('code-mode')).toBe(true);
  });

  it('falls back to prose when the meta read fails outright', async () => {
    server.on('/api/docs/', {}, 500);
    await boot('https://docs.test/review/d-notes');
    expect(document.querySelector('#editor .ProseMirror')).not.toBeNull();
    expect(document.body.classList.contains('code-mode')).toBe(false);
  });
});

describe('the shell the boot wires once', () => {
  it('leaves the doc switcher shut, and opens it on a click once there is a set', async () => {
    await boot('https://docs.test/review/d-notes');
    const menu = document.getElementById('doc-menu') as HTMLElement;
    const button = document.getElementById('doc-switcher') as HTMLButtonElement;
    expect(menu.classList.contains('hidden')).toBe(true);
    // No set: the switcher is inert, which is what stops an empty panel opening.
    button.click();
    expect(menu.classList.contains('hidden')).toBe(true);
    document.body.classList.add('has-set');
    button.click();
    expect(menu.classList.contains('hidden')).toBe(false);
    expect(button.getAttribute('aria-expanded')).toBe('true');
  });

  it('Escape shuts an open switcher', async () => {
    await boot('https://docs.test/review/d-notes');
    const menu = document.getElementById('doc-menu') as HTMLElement;
    document.body.classList.add('has-set');
    (document.getElementById('doc-switcher') as HTMLButtonElement).click();
    expect(menu.classList.contains('hidden')).toBe(false);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(menu.classList.contains('hidden')).toBe(true);
  });
});

describe('identity and the write gate are settled before anything connects', () => {
  it('takes the stored name rather than prompting, and stamps it on awareness', async () => {
    const { sockets } = await boot('https://docs.test/review/d-notes');
    expect(document.querySelector('.identity-prompt')).toBeNull();
    const state = sockets.first().awareness.getLocalState() as { user?: { name?: string } } | null;
    expect(state?.user?.name).toBe('Ada');
  });

  it('does not let a ?as= in a shared link rebrand someone already named', async () => {
    // Review URLs get pasted around and the server emits `?as=` links; the
    // stored name is this browser's own answer and outranks both.
    const { sockets } = await boot('https://docs.test/review/d-notes?as=Grace');
    const state = sockets.first().awareness.getLocalState() as { user?: { name?: string } } | null;
    expect(state?.user?.name).toBe('Ada');
  });

  it('stays anonymous, without prompting, when nothing is stored and writes are refused', async () => {
    server.on('/api/auth/session', { authenticated: false, canWrite: false });
    document.body.innerHTML = SHELL;
    history.replaceState(null, '', '/review/d-notes');
    const sockets = fakeSockets();
    await start({
      document,
      location: fakeLocation('https://docs.test/review/d-notes'),
      localStorage: fakeStorage(),
      window: new EventTarget(),
      connect: sockets.connect,
    });
    await settle();
    // A name prompt here collects an answer the server will refuse anyway.
    expect(document.querySelector('.identity-prompt')).toBeNull();
    const state = sockets.first().awareness.getLocalState() as { user?: { name?: string } } | null;
    expect(state?.user?.name).toBeTypeOf('string');
  });

  it('has the write answer IN HAND before it opens the socket', async () => {
    server.on('/api/auth/session', { authenticated: false, canWrite: false });
    document.body.innerHTML = SHELL;
    history.replaceState(null, '', '/review/d-notes');
    const sockets = fakeSockets();
    // Read at the moment the doc opens. Ordering in the request log alone
    // cannot carry this claim: `ensureUserIdentity` asks the SAME endpoint,
    // so a boot that opened its socket without ever awaiting the write
    // answer still shows a session request sitting before the socket.
    let barUpWhenSocketOpened = false;
    await start({
      document,
      location: fakeLocation('https://docs.test/review/d-notes'),
      localStorage: fakeStorage({ [NAME_KEY]: 'Ada' }),
      window: new EventTarget(),
      connect: (url) => {
        barUpWhenSocketOpened = document.querySelector('.signin-bar') !== null;
        return sockets.connect(url);
      },
    });
    await settle();
    expect(sockets.opened).toHaveLength(1);
    expect(barUpWhenSocketOpened).toBe(true);
    // And the request itself precedes the doc, on one ordered log.
    const session = firstAt('/api/auth/session');
    const socket = firstAt('socket ');
    expect(session).toBeGreaterThanOrEqual(0);
    expect(session).toBeLessThan(socket);
  });

  it('wraps fetch for the sign-in notice before it opens the socket', async () => {
    // A FRESH module registry. `installWriteGateNotice` installs once per
    // process and returns early ever after, so a boot later in this file
    // would find the wrapper already there and pass without having asked for
    // it — the test would hold on a boot that never made the call.
    vi.resetModules();
    const { bootApp: freshBoot } = await import('../src/app.ts');
    const beforeBoot = globalThis.fetch;
    const sockets = fakeSockets();
    let wrappedWhenSocketOpened = false;
    document.body.innerHTML = SHELL;
    history.replaceState(null, '', '/review/d-notes');
    booted.push(
      await freshBoot({
        document,
        location: fakeLocation('https://docs.test/review/d-notes'),
        localStorage: fakeStorage({ [NAME_KEY]: 'Ada' }),
        window: new EventTarget(),
        connect: (url) => {
          wrappedWhenSocketOpened = globalThis.fetch !== beforeBoot;
          return sockets.connect(url);
        },
      }),
    );
    await settle();
    expect(sockets.opened).toHaveLength(1);
    expect(wrappedWhenSocketOpened).toBe(true);

    // And it is the write gate's wrapper, not merely something new on the
    // global: a refused write now raises the prompt on its own, which is the
    // whole point of installing it before anything can write.
    server.on('/api/probe-write', { error: SIGN_IN_REQUIRED }, 401);
    await fetch('/api/probe-write', { method: 'POST' });
    await settle();
    expect(document.querySelector('.signin-required')).not.toBeNull();
  });

  it('raises the sign-in bar and locks the doc when the server refuses writes', async () => {
    server.on('/api/auth/session', { authenticated: false, canWrite: false });
    await boot('https://docs.test/review/d-notes');
    expect(document.querySelector('.signin-bar')).not.toBeNull();
    const toggle = document.getElementById('toggle-edit-mode') as HTMLButtonElement;
    expect(toggle.classList.contains('hidden') || toggle.disabled).toBe(true);
  });

  it('shows no bar when writes are allowed', async () => {
    await boot('https://docs.test/review/d-notes');
    expect(document.querySelector('.signin-bar')).toBeNull();
  });
});

describe('the boot hands back an end for what it started', () => {
  /**
   * A mount left running keeps its debounced timers armed, and the margin's
   * relayout debounce reads `document` when it lands (`markup-margin`'s
   * `toggleClearanceY`, the `#view-toggle` lookup). In a browser that is
   * harmless — the reader navigated away. In the suite, "gone" can mean the
   * environment itself: the read throws `ReferenceError: document is not
   * defined` inside a timer no test is awaiting, so vitest reports every test
   * passing and exits 1, blaming whichever file the worker happened to be on.
   *
   * The mount has always cancelled that timer on `scope.dispose()`. What was
   * missing was anything to CALL dispose: `bootApp` returned `void`, so a
   * caller that is not a page had no end to invoke, and every boot in this
   * file left one running. The control is the first half — the same read,
   * from a boot that was not stopped.
   */
  const READ = 'view-toggle';
  const past = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('hands back a teardown, and a stopped mount stops reading `document` on a timer', async () => {
    const spy = vi.spyOn(document, 'getElementById');
    try {
      // Control: left running, the debounce lands and makes the read.
      await boot('https://docs.test/review/d-notes');
      spy.mockClear();
      await past(250);
      expect(spy.mock.calls.flat()).toContain(READ);

      // The same boot, ended: the debounce never lands.
      await boot('https://docs.test/review/d-notes');
      for (const stop of booted.splice(0)) stop();
      spy.mockClear();
      await past(250);
      expect(spy.mock.calls.flat()).not.toContain(READ);
    } finally {
      spy.mockRestore();
    }
  });
});
