import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The widget half of the popup-token handshake.
 *
 * The load-bearing behaviors, each pinned both ways:
 *   - the sign-in offer exists ONLY on embeds that opted in (`auth-offer`) —
 *     a production-site embed must never show it
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
  it('does NOT exist without auth-offer — the production default', async () => {
    const mod = await importWidget();
    const el = mod.FeedbackWidget.init({ docId: 'w-auth-off' });
    expect(el.shadowRoot!.querySelector('.auth-signin')).toBeNull();
  });

  it('exists on an embed that opted in', async () => {
    const mod = await importWidget();
    const el = mod.FeedbackWidget.init({ docId: 'w-auth-on', authOffer: true });
    expect(el.shadowRoot!.querySelector('.auth-signin')).toBeTruthy();
  });

  it('reads the auth-offer attribute in the declarative embed', async () => {
    await importWidget();
    const host = document.createElement('claude-feedback-widget');
    host.setAttribute('doc-id', 'w-auth-attr');
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
    const el = mod.FeedbackWidget.init({ docId: 'w-auth-popup', authOffer: true });
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
    const el = mod.FeedbackWidget.init({ docId: 'w-auth-msg', authOffer: true });
    (el.shadowRoot!.querySelector('.auth-signin') as HTMLButtonElement).click();

    const user = { id: 'user-abc', name: 'Reviewer', kind: 'known', color: '#2e7dd7' };
    const send = (origin: string, source: unknown, data: unknown) =>
      window.dispatchEvent(
        new MessageEvent('message', { origin, source: source as Window, data }),
      );

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
    const el = mod.FeedbackWidget.init({ docId: 'w-auth-post', authOffer: true });
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
    const el = mod.FeedbackWidget.init({ docId: 'w-auth-401', authOffer: true });
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
    const el = mod.FeedbackWidget.init({ docId: 'w-auth-check', authOffer: true });
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
    const el = mod.FeedbackWidget.init({ docId: 'w-auth-dead', authOffer: true });
    await flush();
    expect(localStorage.getItem('cfw:authToken')).toBeNull();
    expect(el.shadowRoot!.querySelector('.auth-signin')).toBeTruthy();
  });

  it('never probes on a prod embed, even with a token in storage', async () => {
    // The stored token is what makes this a real test: with nothing stored
    // the probe returns early for every embed, and "no traffic" would pass
    // on a production embed whether or not the offer gated it. Seeding the
    // same token that the auth-offer test above proves DOES fire the probe
    // makes this the negative half of that pair.
    localStorage.setItem('cfw:authToken', 'wt1.stored-token');
    localStorage.setItem(
      'cfw:authUser',
      JSON.stringify({ id: 'user-abc', name: 'Reviewer', kind: 'known', color: '#2e7dd7' }),
    );
    const mod = await importWidget();
    const el = mod.FeedbackWidget.init({ docId: 'w-auth-silent' });
    await flush();
    expect(fetchCalls.filter((c) => c.url.includes('/api/auth/')).length).toBe(0);
    // And the stored identity is not adopted either: no offer, no sign-in.
    expect(el.shadowRoot!.querySelector('.me')?.textContent).not.toContain('Reviewer');
    expect(el.shadowRoot!.querySelector('.auth-signout')).toBeNull();
  });
});
