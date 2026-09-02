import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The widget half of the popup-token handshake.
 *
 * The load-bearing behaviors, each pinned both ways:
 *   - the sign-in offer exists on embeds that opted in (`auth-offer`) and on
 *     any embed whose workspace REQUIRES a signed-in writer — and nowhere
 *     else, so a production-site embed against an open workspace never
 *     shows it
 *   - the postMessage listener accepts the token only from the server origin
 *     and only from the popup window it opened
 *   - posts carry the token; a 401 clears it and retries anonymously, so a
 *     revoked session costs the comment its attribution, not its text
 */

interface FetchCall {
  url: string;
  init?: RequestInit;
}

let fetchCalls: FetchCall[];
let fetchResponder: (url: string, init?: RequestInit) => Response;

function stubGlobals() {
  fetchCalls = [];
  fetchResponder = () =>
    new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json' },
    });
  (globalThis as unknown as { fetch: unknown }).fetch = (async (
    url: string,
    init?: RequestInit,
  ) => {
    fetchCalls.push({ url: String(url), init });
    return fetchResponder(String(url), init);
  }) as unknown as typeof fetch;
  class FakeWS {
    static OPEN = 1;
    readyState = 1;
    binaryType = 'arraybuffer';
    addEventListener() {}
    removeEventListener() {}
    send() {}
    close() {}
  }
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWS;
}

async function importWidget() {
  stubGlobals();
  return import('../src/widget.ts');
}

/** The server origin the widget defaults to in these tests (same host). */
function serverOrigin(): string {
  return location.origin;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function authHeaderOf(call: FetchCall): string | null {
  const headers = (call.init?.headers ?? {}) as Record<string, string>;
  const entry = Object.entries(headers).find(([k]) => k.toLowerCase() === 'authorization');
  return entry?.[1] ?? null;
}

beforeEach(() => {
  document.body.innerHTML = '<main><button id="hello">Hello</button></main>';
  document.head.querySelectorAll('style').forEach((s) => s.remove());
  localStorage.clear();
});

afterEach(() => {
  document.querySelectorAll('claude-feedback-widget').forEach((el) => el.remove());
  document.querySelectorAll('.cfw-overlay, #cfw-light-styles').forEach((el) => el.remove());
});

describe('the sign-in offer', () => {
  it('does NOT exist without auth-offer on a workspace that does not require it', async () => {
    const mod = await importWidget();
    const el = mod.FeedbackWidget.init({ docId: 'doc-auth-off' });
    await flush();
    expect(el.shadowRoot!.querySelector('.auth-signin')).toBeNull();
  });

  it('exists on an embed that opted in', async () => {
    const mod = await importWidget();
    const el = mod.FeedbackWidget.init({ docId: 'doc-auth-on', authOffer: true });
    expect(el.shadowRoot!.querySelector('.auth-signin')).toBeTruthy();
  });

  it('reads the auth-offer attribute in the declarative embed', async () => {
    await importWidget();
    const host = document.createElement('claude-feedback-widget');
    host.setAttribute('doc-id', 'doc-auth-attr');
    host.setAttribute('auth-offer', '');
    document.body.appendChild(host);
    expect((host as HTMLElement).shadowRoot!.querySelector('.auth-signin')).toBeTruthy();
  });
});

describe('the popup handshake', () => {
  it('opens the popup on the server origin, naming this page as recipient', async () => {
    const mod = await importWidget();
    const opened: string[] = [];
    (window as unknown as { open: unknown }).open = (url: string) => {
      opened.push(String(url));
      return {} as Window;
    };
    const el = mod.FeedbackWidget.init({ docId: 'doc-auth-popup', authOffer: true });
    (el.shadowRoot!.querySelector('.auth-signin') as HTMLButtonElement).click();
    expect(opened.length).toBe(1);
    const url = new URL(opened[0] as string);
    expect(url.origin).toBe(serverOrigin());
    expect(url.pathname).toBe('/widget-auth');
    expect(url.searchParams.get('origin')).toBe(location.origin);
  });

  it('adopts a token only from the popup it opened, on the server origin', async () => {
    const mod = await importWidget();
    const popup = {} as Window;
    (window as unknown as { open: unknown }).open = () => popup;
    const el = mod.FeedbackWidget.init({ docId: 'doc-auth-msg', authOffer: true });
    (el.shadowRoot!.querySelector('.auth-signin') as HTMLButtonElement).click();

    const user = { id: 'user-abc', name: 'Reviewer', kind: 'known', color: '#2e7dd7' };
    const send = (origin: string, source: unknown, data: unknown) =>
      window.dispatchEvent(new MessageEvent('message', { origin, source: source as Window, data }));

    // Wrong origin: ignored even with the right shape and source.
    send('https://evil.example.com', popup, { type: 'cw-widget-auth', token: 'wt1.x', user });
    expect(localStorage.getItem('cfw:authToken')).toBeNull();

    // Right origin, wrong source (not our popup): ignored.
    send(serverOrigin(), {} as Window, { type: 'cw-widget-auth', token: 'wt1.x', user });
    expect(localStorage.getItem('cfw:authToken')).toBeNull();

    // The real handshake.
    send(serverOrigin(), popup, { type: 'cw-widget-auth', token: 'wt1.real-token', user });
    expect(localStorage.getItem('cfw:authToken')).toBe('wt1.real-token');
    // The offer collapses into the signed-in identity.
    expect(el.shadowRoot!.querySelector('.auth-signin')).toBeNull();
    expect(el.shadowRoot!.querySelector('.me')?.textContent).toContain('Reviewer');
  });
});

describe('posting with a token', () => {
  it('sends the token on thread posts', async () => {
    localStorage.setItem('cfw:authToken', 'wt1.stored-token');
    localStorage.setItem(
      'cfw:authUser',
      JSON.stringify({ id: 'user-abc', name: 'Reviewer', kind: 'known', color: '#2e7dd7' }),
    );
    const mod = await importWidget();
    fetchResponder = (url) =>
      url.includes('/api/auth/widget-session')
        ? new Response(
            JSON.stringify({
              authenticated: true,
              user: { id: 'user-abc', name: 'Reviewer', kind: 'known', color: '#2e7dd7' },
            }),
            { headers: { 'content-type': 'application/json' } },
          )
        : new Response(JSON.stringify({ ok: true }), {
            headers: { 'content-type': 'application/json' },
          });
    const el = mod.FeedbackWidget.init({ docId: 'doc-auth-post', authOffer: true });
    await flush();
    fetchCalls = [];
    // biome-ignore lint/suspicious/noExplicitAny: reaching into a private for the test
    await (el as any).postReply('t-1', 'hello');
    const call = fetchCalls.find((c) => c.url.includes('/threads/'));
    expect(call).toBeTruthy();
    expect(authHeaderOf(call as FetchCall)).toBe('Bearer wt1.stored-token');
  });

  it('a 401 clears the token and retries the post anonymously', async () => {
    localStorage.setItem('cfw:authToken', 'wt1.revoked-token');
    localStorage.setItem(
      'cfw:authUser',
      JSON.stringify({ id: 'user-abc', name: 'Reviewer', kind: 'known', color: '#2e7dd7' }),
    );
    const mod = await importWidget();
    // The stored token is live at load, dead by the time the post lands —
    // the way a logout on the workspace looks from a dev-server tab.
    fetchResponder = (url, init) => {
      if (url.includes('/api/auth/widget-session')) {
        return new Response(
          JSON.stringify({
            authenticated: true,
            user: { id: 'user-abc', name: 'Reviewer', kind: 'known', color: '#2e7dd7' },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const has = Object.keys(headers).some((k) => k.toLowerCase() === 'authorization');
      return has
        ? new Response(JSON.stringify({ error: 'widget_token_invalid' }), { status: 401 })
        : new Response(JSON.stringify({ ok: true }), {
            headers: { 'content-type': 'application/json' },
          });
    };
    const el = mod.FeedbackWidget.init({ docId: 'doc-auth-401', authOffer: true });
    await flush();
    fetchCalls = [];
    // biome-ignore lint/suspicious/noExplicitAny: reaching into a private for the test
    await (el as any).postReply('t-1', 'still lands');
    const posts = fetchCalls.filter((c) => c.url.includes('/threads/'));
    expect(posts.length).toBe(2);
    expect(authHeaderOf(posts[0] as FetchCall)).toBe('Bearer wt1.revoked-token');
    expect(authHeaderOf(posts[1] as FetchCall)).toBeNull();
    // The retry's BODY is rebuilt too: the server trusts a claimed author on
    // the local surface, so re-sending the signed-in identity without its
    // token would let the revoked person keep their name on every comment.
    const authorOf = (c: FetchCall) =>
      (JSON.parse(String(c.init?.body)) as { author: { id: string } }).author.id;
    // biome-ignore lint/suspicious/noExplicitAny: reaching into a private for the test
    const anonId = (el as any).anonUser.id as string;
    expect(anonId).not.toBe('user-abc');
    expect(authorOf(posts[0] as FetchCall)).toBe('user-abc');
    expect(authorOf(posts[1] as FetchCall)).not.toBe('user-abc');
    expect(authorOf(posts[1] as FetchCall)).toBe(anonId);
    // Signed out for real: token gone, offer back.
    expect(localStorage.getItem('cfw:authToken')).toBeNull();
    expect(el.shadowRoot!.querySelector('.auth-signin')).toBeTruthy();
  });
});

describe('a stored token is validated on load', () => {
  it('keeps a live token and shows its user', async () => {
    localStorage.setItem('cfw:authToken', 'wt1.live-token');
    const mod = await importWidget();
    fetchResponder = (url) =>
      url.includes('/api/auth/widget-session')
        ? new Response(
            JSON.stringify({
              authenticated: true,
              user: { id: 'user-abc', name: 'Reviewer', kind: 'known', color: '#2e7dd7' },
            }),
            { headers: { 'content-type': 'application/json' } },
          )
        : new Response(JSON.stringify({ ok: true }), {
            headers: { 'content-type': 'application/json' },
          });
    const el = mod.FeedbackWidget.init({ docId: 'doc-auth-check', authOffer: true });
    await flush();
    const probe = fetchCalls.find((c) => c.url.includes('/api/auth/widget-session'));
    expect(probe).toBeTruthy();
    expect(authHeaderOf(probe as FetchCall)).toBe('Bearer wt1.live-token');
    expect(el.shadowRoot!.querySelector('.me')?.textContent).toContain('Reviewer');
  });

  it('clears a dead token and shows the offer again', async () => {
    localStorage.setItem('cfw:authToken', 'wt1.dead-token');
    const mod = await importWidget();
    fetchResponder = (url) =>
      url.includes('/api/auth/widget-session')
        ? new Response(JSON.stringify({ error: 'widget_token_invalid' }), { status: 401 })
        : new Response(JSON.stringify({ ok: true }), {
            headers: { 'content-type': 'application/json' },
          });
    const el = mod.FeedbackWidget.init({ docId: 'doc-auth-dead', authOffer: true });
    await flush();
    expect(localStorage.getItem('cfw:authToken')).toBeNull();
    expect(el.shadowRoot!.querySelector('.auth-signin')).toBeTruthy();
  });

  it('neither adopts nor probes a stored token on an open workspace, even without auth-offer', async () => {
    // The stored token is what makes this a real test: with nothing stored
    // the probe returns early for every embed, and "no traffic" would pass
    // whether or not the offer gated it. Seeding the same token that the
    // auth-offer test above proves DOES fire the probe makes this the
    // negative half of that pair. The one call a plain embed may make is
    // the session question itself — asked once, answered "not required".
    localStorage.setItem('cfw:authToken', 'wt1.stored-token');
    localStorage.setItem(
      'cfw:authUser',
      JSON.stringify({ id: 'user-abc', name: 'Reviewer', kind: 'known', color: '#2e7dd7' }),
    );
    const mod = await importWidget();
    fetchResponder = (url) =>
      url.includes('/api/auth/session')
        ? new Response(JSON.stringify({ signInToWrite: false, canWrite: true }), {
            headers: { 'content-type': 'application/json' },
          })
        : new Response('{}');
    const el = mod.FeedbackWidget.init({ docId: 'doc-auth-silent' });
    await flush();
    const authCalls = fetchCalls.filter((c) => c.url.includes('/api/auth/'));
    expect(authCalls.map((c) => new URL(c.url).pathname)).toEqual(['/api/auth/session']);
    // And the stored identity is not adopted either: no offer, no sign-in.
    expect(el.shadowRoot!.querySelector('.me')?.textContent).not.toContain('Reviewer');
    expect(el.shadowRoot!.querySelector('.auth-signout')).toBeNull();
    expect(el.shadowRoot!.querySelector('.auth-signin')).toBeNull();
  });
});

describe('a write the workspace refuses for want of a session', () => {
  /** What the server answers an unsigned write with — see
   *  server/src/middleware/write-gate.ts. */
  const refuse = () =>
    new Response(JSON.stringify({ error: 'sign_in_required', signInUrl: '/signin' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });

  it('does NOT retry anonymously — the retry gets the identical refusal', async () => {
    // The dead-token path clears the token and posts again, which is right
    // for a dead token and a loop for this: nothing about being anonymous
    // makes the second attempt acceptable, and every caller ignores the
    // response, so the comment simply vanished.
    const mod = await importWidget();
    fetchResponder = (url) => (url.includes('/threads') ? refuse() : new Response('{}'));
    const el = mod.FeedbackWidget.init({ docId: 'doc-refused' });
    await flush();
    fetchCalls = [];
    // biome-ignore lint/suspicious/noExplicitAny: reaching into a private for the test
    const posted = await (el as any).postReply('t-1', 'hello');
    expect(fetchCalls.filter((c) => c.url.includes('/threads')).length).toBe(1);
    expect(posted).toBe(false);
  });

  it('tells the person, and keeps the way forward clickable rather than opening it', async () => {
    // Popup blockers: this runs after awaiting a failed request and parsing
    // its body, so the submit click's transient activation is long gone and
    // a `window.open` here would be silently refused.
    const mod = await importWidget();
    const opened: string[] = [];
    (window as unknown as { open: unknown }).open = (url: string) => {
      opened.push(String(url));
      return {} as Window;
    };
    fetchResponder = (url) => (url.includes('/threads') ? refuse() : new Response('{}'));
    const el = mod.FeedbackWidget.init({ docId: 'doc-refused-ui', authOffer: true });
    await flush();
    // biome-ignore lint/suspicious/noExplicitAny: reaching into a private for the test
    await (el as any).postReply('t-1', 'hello');
    expect(opened.length).toBe(0);
    const control = el.shadowRoot!.querySelector('.auth-signin') as HTMLElement;
    expect(control).toBeTruthy();
    expect(control.textContent).toContain('Sign in');
    // …and clicking it — which DOES carry an activation — starts the handshake.
    control.click();
    expect(opened.length).toBe(1);
    expect(new URL(opened[0] as string).pathname).toBe('/widget-auth');
  });

  it('offers the popup on an embed with no auth-offer — the refusal is the proof it is needed', async () => {
    // The load-time question may go unanswered (an older server, a route
    // that 500s); the 401 is the backstop, and the offer it raises is the
    // same popup handshake — the workspace sign-in page on its own origin
    // cannot help a page on another origin, because no cookie crosses.
    const mod = await importWidget();
    const opened: string[] = [];
    (window as unknown as { open: unknown }).open = (url: string) => {
      opened.push(String(url));
      return {} as Window;
    };
    fetchResponder = (url) =>
      url.includes('/threads') ? refuse() : new Response('nope', { status: 500 });
    const el = mod.FeedbackWidget.init({ docId: 'doc-refused-link' });
    await flush();
    expect(el.shadowRoot!.querySelector('.auth-signin')).toBeNull();
    // biome-ignore lint/suspicious/noExplicitAny: reaching into a private for the test
    await (el as any).postReply('t-1', 'hello');
    const control = el.shadowRoot!.querySelector('.auth-signin') as HTMLElement;
    expect(control).toBeTruthy();
    control.click();
    expect(new URL(opened[0] as string).pathname).toBe('/widget-auth');
  });

  it('a dead TOKEN still clears and retries — the other 401 is unchanged', async () => {
    // The positive control for the branch above: the same status code, a
    // different body, and the old behaviour has to survive intact.
    localStorage.setItem('cfw:authToken', 'wt1.stored-token');
    localStorage.setItem(
      'cfw:authUser',
      JSON.stringify({ id: 'user-abc', name: 'Reviewer', kind: 'known', color: '#2e7dd7' }),
    );
    const mod = await importWidget();
    let threadPosts = 0;
    fetchResponder = (url) => {
      if (url.includes('/api/auth/widget-session')) {
        return new Response(
          JSON.stringify({
            authenticated: true,
            user: { id: 'user-abc', name: 'Reviewer', kind: 'known', color: '#2e7dd7' },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/threads')) {
        threadPosts += 1;
        return threadPosts === 1
          ? new Response(JSON.stringify({ error: 'widget_token_invalid' }), { status: 401 })
          : new Response(JSON.stringify({ ok: true }), {
              headers: { 'content-type': 'application/json' },
            });
      }
      return new Response('{}');
    };
    const el = mod.FeedbackWidget.init({ docId: 'doc-dead-token', authOffer: true });
    await flush();
    // biome-ignore lint/suspicious/noExplicitAny: reaching into a private for the test
    const posted = await (el as any).postReply('t-1', 'hello');
    expect(threadPosts).toBe(2);
    expect(posted).toBe(true);
    expect(localStorage.getItem('cfw:authToken')).toBeNull();
  });
});

describe('a workspace that requires a signed-in writer', () => {
  const user = { id: 'user-abc', name: 'Reviewer', kind: 'known', color: '#2e7dd7' };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const required = () => json({ signInToWrite: true, canWrite: false });
  const refuse = () => json({ error: 'sign_in_required', signInUrl: '/signin' }, 401);

  /** Arm feedback mode and click the page, the way a person opens the composer. */
  function openComposer(el: HTMLElement): HTMLElement {
    const root = el.shadowRoot!;
    document.elementFromPoint = () => document.getElementById('hello') as HTMLElement;
    (root.querySelector('.fab') as HTMLButtonElement).click();
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: 10, clientY: 10 }));
    return root.querySelector('.composer') as HTMLElement;
  }

  it('asks once on load and offers sign-in without auth-offer', async () => {
    const mod = await importWidget();
    fetchResponder = (url) => (url.includes('/api/auth/session') ? required() : json({}));
    const el = mod.FeedbackWidget.init({ docId: 'doc-req-load' });
    await flush();
    const asks = fetchCalls.filter((c) => c.url.includes('/api/auth/session'));
    expect(asks.length).toBe(1);
    expect(asks[0]?.init?.method ?? 'GET').toBe('GET');
    expect(el.shadowRoot!.querySelector('.auth-signin')).toBeTruthy();
  });

  it('adopts and validates a stored token, so signed-in state survives a reload', async () => {
    localStorage.setItem('cfw:authToken', 'wt1.stored-token');
    localStorage.setItem('cfw:authUser', JSON.stringify(user));
    const mod = await importWidget();
    fetchResponder = (url) => {
      if (url.includes('/api/auth/session')) return required();
      if (url.includes('/api/auth/widget-session')) return json({ authenticated: true, user });
      return json({});
    };
    const el = mod.FeedbackWidget.init({ docId: 'doc-req-stored' });
    await flush();
    const probe = fetchCalls.find((c) => c.url.includes('/api/auth/widget-session'));
    expect(authHeaderOf(probe as FetchCall)).toBe('Bearer wt1.stored-token');
    expect(el.shadowRoot!.querySelector('.me')?.textContent).toContain('Reviewer');
    expect(el.shadowRoot!.querySelector('.auth-signin')).toBeNull();
    expect(el.shadowRoot!.querySelector('.auth-signout')).toBeTruthy();
  });

  it('the composer says why it cannot post, before the first attempt', async () => {
    const mod = await importWidget();
    fetchResponder = (url) => (url.includes('/api/auth/session') ? required() : json({}));
    const el = mod.FeedbackWidget.init({ docId: 'doc-req-composer' });
    await flush();
    const composer = openComposer(el);
    expect(composer.querySelector('.composer-err')?.textContent).toContain('Sign in');
    expect(composer.querySelector('.auth-signin')).toBeTruthy();
    // Reading is untouched: the panel and the pick control are still there.
    expect(el.shadowRoot!.querySelector('.pick-btn')).toBeTruthy();
  });

  it('keeps the draft on refusal and posts it once the person signs in', async () => {
    const mod = await importWidget();
    const popup = {} as Window;
    (window as unknown as { open: unknown }).open = () => popup;
    let posts = 0;
    fetchResponder = (url, init) => {
      if (url.includes('/api/auth/session')) return json({ signInToWrite: false });
      if (url.includes('/threads')) {
        posts += 1;
        const headers = (init?.headers ?? {}) as Record<string, string>;
        return headers.authorization ? json({ ok: true }) : refuse();
      }
      return json({});
    };
    const el = mod.FeedbackWidget.init({ docId: 'doc-req-retry' });
    await flush();
    const composer = openComposer(el);
    // The load-time answer said open; the refusal is what teaches this embed.
    expect(composer.querySelector('.auth-signin')).toBeNull();
    (composer.querySelector('textarea') as HTMLTextAreaElement).value = 'needs work';
    (composer.querySelector('.submit') as HTMLButtonElement).click();
    await flush();
    expect(posts).toBe(1);
    expect(el.shadowRoot!.querySelector('.composer')).toBeTruthy();
    expect((composer.querySelector('textarea') as HTMLTextAreaElement).value).toBe('needs work');
    const control = composer.querySelector('.auth-signin') as HTMLButtonElement;
    expect(control).toBeTruthy();
    expect(composer.querySelector('.composer-err')?.textContent).toContain('Sign in');
    control.click();
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: serverOrigin(),
        source: popup,
        data: { type: 'cw-widget-auth', token: 'wt1.fresh', user },
      }),
    );
    await flush();
    expect(posts).toBe(2);
    const retry = fetchCalls.filter((c) => c.url.includes('/threads'))[1] as FetchCall;
    expect(authHeaderOf(retry)).toBe('Bearer wt1.fresh');
    expect(JSON.parse(String(retry.init?.body)).author.name).toBe('Reviewer');
    expect(el.shadowRoot!.querySelector('.composer')).toBeNull();
  });

  it('a cancelled draft is not posted by a later sign-in', async () => {
    const mod = await importWidget();
    const popup = {} as Window;
    (window as unknown as { open: unknown }).open = () => popup;
    let posts = 0;
    fetchResponder = (url) => {
      if (url.includes('/api/auth/session')) return required();
      if (url.includes('/threads')) {
        posts += 1;
        return refuse();
      }
      return json({});
    };
    const el = mod.FeedbackWidget.init({ docId: 'doc-req-cancel' });
    await flush();
    const composer = openComposer(el);
    (composer.querySelector('textarea') as HTMLTextAreaElement).value = 'second thoughts';
    (composer.querySelector('.submit') as HTMLButtonElement).click();
    await flush();
    expect(posts).toBe(1);
    (composer.querySelector('.auth-signin') as HTMLButtonElement).click();
    (composer.querySelector('.cancel') as HTMLButtonElement).click();
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: serverOrigin(),
        source: popup,
        data: { type: 'cw-widget-auth', token: 'wt1.fresh', user },
      }),
    );
    await flush();
    expect(posts).toBe(1);
  });
});
