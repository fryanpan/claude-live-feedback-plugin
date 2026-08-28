import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CODE_LENGTH,
  RESEND_COOLDOWN_S,
  errorMessage,
  expiresCopy,
  mountSignin,
  safeNextPath,
} from '../src/signin/signin-page.ts';

function mockStorage() {
  const m = new Map<string, string>();
  return {
    get: (k: string) => m.get(k) ?? null,
    set: (k: string, v: string) => void m.set(k, v),
    map: m,
  };
}

/** A fetch mock that answers by path and records every call. */
function mockFetch(answers: Record<string, () => { status: number; body: unknown }>) {
  const calls: Array<{ path: string; body: unknown }> = [];
  const fn = vi.fn(async (path: string, init?: RequestInit) => {
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const answer = answers[path];
    if (!answer) throw new Error(`unexpected fetch: ${path}`);
    const { status, body } = answer();
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

/** Walk email → code entry with one address; leaves the page on the code step. */
async function toCodeStep(root: HTMLElement, email = 'casey@example.com'): Promise<void> {
  const input = root.querySelector<HTMLInputElement>('#signin-email');
  if (!input) throw new Error('no email input');
  input.value = email;
  root.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
  await vi.waitFor(() => {
    expect(root.querySelector('.signin-code')).not.toBeNull();
  });
}

function typeCode(root: HTMLElement, code: string): void {
  const boxes = [...root.querySelectorAll<HTMLInputElement>('.signin-code input')];
  boxes.forEach((b, i) => {
    b.value = code[i] ?? '';
  });
}

let root: HTMLElement;
let dispose: (() => void) | null = null;

beforeEach(() => {
  root = document.createElement('div');
  document.body.appendChild(root);
});

afterEach(() => {
  dispose?.();
  dispose = null;
  root.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('safeNextPath', () => {
  it('accepts a same-origin path and rejects everything else', () => {
    expect(safeNextPath('/workspaces/w-1/home')).toBe('/workspaces/w-1/home');
    expect(safeNextPath(null)).toBe('/');
    expect(safeNextPath('')).toBe('/');
    expect(safeNextPath('https://evil.example.com/')).toBe('/');
    expect(safeNextPath('//evil.example.com')).toBe('/');
    // Browsers treat backslashes as forward slashes when parsing
    // special-scheme URLs, so /\evil.com resolves to http://evil.com/.
    expect(safeNextPath('/\\evil.example.com')).toBe('/');
    expect(safeNextPath('javascript:alert(1)')).toBe('/');
  });
});

describe('expiresCopy', () => {
  it('speaks the server TTL in minutes and never says zero', () => {
    expect(expiresCopy(600)).toBe('It expires in 10 minutes.');
    expect(expiresCopy(60)).toBe('It expires in 1 minute.');
    expect(expiresCopy(20)).toBe('It expires in 1 minute.');
  });
});

describe('errorMessage', () => {
  it('names the wait for a rate limit and the tries left for a miss', () => {
    expect(errorMessage(429, { error: 'rate_limited', retryAfterSeconds: 45 })).toContain(
      '45 seconds',
    );
    expect(errorMessage(429, { error: 'rate_limited', retryAfterSeconds: 300 })).toContain(
      '5 minutes',
    );
    expect(errorMessage(401, { error: 'invalid_code', attemptsLeft: 3 })).toContain('3 tries left');
    expect(errorMessage(401, { error: 'invalid_code', attemptsLeft: 1 })).toContain('1 try left');
    expect(errorMessage(401, { error: 'no_challenge' })).toContain('expired');
  });
});

describe('email entry', () => {
  it('renders the approved copy', () => {
    mockFetch({});
    dispose = mountSignin(root, { storage: mockStorage(), navigate: () => {}, next: '/' });
    expect(root.querySelector('.signin-wordmark')?.textContent).toBe('Fryanpan Workspaces');
    expect(root.querySelector('h1')?.textContent).toBe('Sign in');
    expect(root.querySelector('.signin-sub')?.textContent).toContain(
      'send you a code. No password needed.',
    );
    expect(root.querySelector('.signin-btn')?.textContent).toBe('Email me a code');
    expect(root.querySelector('#signin-email')?.getAttribute('autocomplete')).toBe('email');
  });

  it('starts a code and advances to the code step with the address bolded and the real TTL', async () => {
    const calls = mockFetch({
      '/api/auth/start': () => ({
        status: 200,
        body: { ok: true, email: 'casey@example.com', expiresInSeconds: 600 },
      }),
    });
    dispose = mountSignin(root, { storage: mockStorage(), navigate: () => {}, next: '/' });
    await toCodeStep(root);
    expect(calls[0]).toEqual({
      path: '/api/auth/start',
      body: { email: 'casey@example.com' },
    });
    expect(root.querySelector('h1')?.textContent).toBe('Check your email');
    expect(root.querySelector('.signin-sub strong')?.textContent).toBe('casey@example.com');
    expect(root.querySelector('.signin-sub')?.textContent).toContain('It expires in 10 minutes.');
    const boxes = root.querySelectorAll('.signin-code input');
    expect(boxes.length).toBe(CODE_LENGTH);
    expect(boxes[0]?.getAttribute('autocomplete')).toBe('one-time-code');
    expect(boxes[0]?.getAttribute('inputmode')).toBe('numeric');
    expect(root.querySelector('.signin-note')?.textContent).toContain(
      `every ${RESEND_COOLDOWN_S} seconds`,
    );
  });

  it('shows the rate-limit wait instead of advancing', async () => {
    mockFetch({
      '/api/auth/start': () => ({
        status: 429,
        body: { error: 'rate_limited', retryAfterSeconds: 90 },
      }),
    });
    dispose = mountSignin(root, { storage: mockStorage(), navigate: () => {}, next: '/' });
    const input = root.querySelector<HTMLInputElement>('#signin-email');
    if (!input) throw new Error('no email input');
    input.value = 'casey@example.com';
    root.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => {
      expect(root.querySelector('.signin-error')?.textContent).toContain('Too many attempts');
    });
    expect(root.querySelector('.signin-code')).toBeNull();
  });
});

describe('code entry', () => {
  it('advances focus as digits are typed and retreats on backspace', async () => {
    mockFetch({
      '/api/auth/start': () => ({
        status: 200,
        body: { ok: true, email: 'casey@example.com', expiresInSeconds: 600 },
      }),
    });
    dispose = mountSignin(root, { storage: mockStorage(), navigate: () => {}, next: '/' });
    await toCodeStep(root);
    const boxes = [...root.querySelectorAll<HTMLInputElement>('.signin-code input')];
    boxes[0]!.value = '4';
    boxes[0]!.dispatchEvent(new Event('input', { bubbles: true }));
    expect(document.activeElement).toBe(boxes[1]);
    boxes[1]!.value = '';
    boxes[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
    expect(document.activeElement).toBe(boxes[0]);
  });

  it('spreads a pasted code across all six boxes', async () => {
    mockFetch({
      '/api/auth/start': () => ({
        status: 200,
        body: { ok: true, email: 'casey@example.com', expiresInSeconds: 600 },
      }),
    });
    dispose = mountSignin(root, { storage: mockStorage(), navigate: () => {}, next: '/' });
    await toCodeStep(root);
    const boxes = [...root.querySelectorAll<HTMLInputElement>('.signin-code input')];
    // happy-dom has no ClipboardEvent constructor with data; fake the shape.
    const paste = new Event('paste', { bubbles: true, cancelable: true }) as Event & {
      clipboardData: { getData: (t: string) => string };
    };
    paste.clipboardData = { getData: () => '493 021' };
    boxes[0]!.dispatchEvent(paste);
    expect(boxes.map((b) => b.value).join('')).toBe('493021');
  });

  it('refuses to submit a partial code without calling the server', async () => {
    const calls = mockFetch({
      '/api/auth/start': () => ({
        status: 200,
        body: { ok: true, email: 'casey@example.com', expiresInSeconds: 600 },
      }),
    });
    dispose = mountSignin(root, { storage: mockStorage(), navigate: () => {}, next: '/' });
    await toCodeStep(root);
    typeCode(root, '123');
    root.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(root.querySelector('.signin-error')?.textContent).toBe('Enter all six digits.');
    expect(calls.filter((c) => c.path === '/api/auth/verify').length).toBe(0);
  });

  it('signs a returning person in: stores the confirmed name and navigates to next', async () => {
    const storage = mockStorage();
    const navigate = vi.fn();
    const calls = mockFetch({
      '/api/auth/start': () => ({
        status: 200,
        body: { ok: true, email: 'casey@example.com', expiresInSeconds: 600 },
      }),
      '/api/auth/verify': () => ({
        status: 200,
        body: { ok: true, user: { id: 'user-x', name: 'Casey' }, firstSignIn: false },
      }),
    });
    dispose = mountSignin(root, { storage, navigate, next: '/workspaces/w-1/home' });
    await toCodeStep(root);
    typeCode(root, '493021');
    root.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => {
      expect(navigate).toHaveBeenCalledWith('/workspaces/w-1/home');
    });
    expect(calls.find((c) => c.path === '/api/auth/verify')?.body).toEqual({
      email: 'casey@example.com',
      code: '493021',
    });
    expect(storage.get('feedback-user-name')).toBe('Casey');
    expect(root.querySelector('h1')?.textContent).not.toBe('What should we call you?');
  });

  it('shows the tries left on a wrong code and clears the boxes', async () => {
    mockFetch({
      '/api/auth/start': () => ({
        status: 200,
        body: { ok: true, email: 'casey@example.com', expiresInSeconds: 600 },
      }),
      '/api/auth/verify': () => ({
        status: 401,
        body: { error: 'invalid_code', attemptsLeft: 4 },
      }),
    });
    dispose = mountSignin(root, { storage: mockStorage(), navigate: () => {}, next: '/' });
    await toCodeStep(root);
    typeCode(root, '000000');
    root.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => {
      expect(root.querySelector('.signin-error')?.textContent).toContain('4 tries left');
    });
    const boxes = [...root.querySelectorAll<HTMLInputElement>('.signin-code input')];
    expect(boxes.map((b) => b.value).join('')).toBe('');
  });

  it('cools the resend link down for 60 seconds, then sends again', async () => {
    vi.useFakeTimers();
    const calls = mockFetch({
      '/api/auth/start': () => ({
        status: 200,
        body: { ok: true, email: 'casey@example.com', expiresInSeconds: 600 },
      }),
    });
    dispose = mountSignin(root, { storage: mockStorage(), navigate: () => {}, next: '/' });
    const input = root.querySelector<HTMLInputElement>('#signin-email');
    if (!input) throw new Error('no email input');
    input.value = 'casey@example.com';
    root.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    // Fake timers hold the microtask-driven waitFor hostage; flush manually.
    await vi.runOnlyPendingTimersAsync();
    const resend = root.querySelector<HTMLButtonElement>('.signin-resend');
    if (!resend) throw new Error('no resend link');
    expect(resend.disabled).toBe(true);
    expect(resend.textContent).toContain('Send a new code (');
    await vi.advanceTimersByTimeAsync(RESEND_COOLDOWN_S * 1000);
    expect(resend.disabled).toBe(false);
    expect(resend.textContent).toBe('Send a new code');
    resend.click();
    await vi.runOnlyPendingTimersAsync();
    expect(calls.filter((c) => c.path === '/api/auth/start').length).toBe(2);
    // Clicking re-armed the cooldown.
    expect(resend.disabled).toBe(true);
  });

  it('returns to the email step, prefilled, on "Use a different email"', async () => {
    mockFetch({
      '/api/auth/start': () => ({
        status: 200,
        body: { ok: true, email: 'casey@example.com', expiresInSeconds: 600 },
      }),
    });
    dispose = mountSignin(root, { storage: mockStorage(), navigate: () => {}, next: '/' });
    await toCodeStep(root);
    root.querySelector<HTMLButtonElement>('.signin-switch-email')?.click();
    const email = root.querySelector<HTMLInputElement>('#signin-email');
    expect(email).not.toBeNull();
    expect(email?.value).toBe('casey@example.com');
  });
});

describe('display name (first sign-in only)', () => {
  async function toNameStep(
    storage: ReturnType<typeof mockStorage>,
    navigate: (p: string) => void,
  ) {
    const calls = mockFetch({
      '/api/auth/start': () => ({
        status: 200,
        body: { ok: true, email: 'casey@example.com', expiresInSeconds: 600 },
      }),
      '/api/auth/verify': () => ({
        status: 200,
        body: { ok: true, user: { id: 'user-x', name: 'Casey' }, firstSignIn: true },
      }),
      '/api/auth/profile': () => ({
        status: 200,
        body: { ok: true, user: { id: 'user-x', name: 'Case E. Jones' } },
      }),
    });
    dispose = mountSignin(root, { storage, navigate, next: '/' });
    await toCodeStep(root);
    typeCode(root, '493021');
    root.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => {
      expect(root.querySelector('h1')?.textContent).toBe('What should we call you?');
    });
    return calls;
  }

  it('renders the approved copy prefilled with the server-derived name', async () => {
    await toNameStep(mockStorage(), () => {});
    expect(root.querySelector<HTMLInputElement>('#signin-name')?.value).toBe('Casey');
    expect(root.querySelector('.signin-btn')?.textContent).toBe('Start working');
    expect(root.querySelector('.signin-attribution')?.textContent).toContain('commented just now');
    expect(root.querySelector('.signin-attribution b')?.textContent).toBe('Casey');
    expect(root.querySelector('.signin-quiet')?.textContent).toBe(
      'You can change this later from the board.',
    );
  });

  it('previews the typed name in the attribution line', async () => {
    await toNameStep(mockStorage(), () => {});
    const input = root.querySelector<HTMLInputElement>('#signin-name');
    if (!input) throw new Error('no name input');
    input.value = 'Case E. Jones';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(root.querySelector('.signin-attribution b')?.textContent).toBe('Case E. Jones');
  });

  it('saves the name, stores the server-confirmed value, and navigates', async () => {
    const storage = mockStorage();
    const navigate = vi.fn();
    const calls = await toNameStep(storage, navigate);
    const input = root.querySelector<HTMLInputElement>('#signin-name');
    if (!input) throw new Error('no name input');
    input.value = '  Case E. Jones ';
    root.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => {
      expect(navigate).toHaveBeenCalledWith('/');
    });
    expect(calls.find((c) => c.path === '/api/auth/profile')?.body).toEqual({
      displayName: 'Case E. Jones',
    });
    expect(storage.get('feedback-user-name')).toBe('Case E. Jones');
  });
});
