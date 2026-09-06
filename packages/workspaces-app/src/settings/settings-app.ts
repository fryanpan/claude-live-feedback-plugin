/**
 * The /settings/* entry point.
 *
 * The server-rendered shell provides `#settings-root`; everything else is
 * `mountPromptsPage`, which the tests drive directly. Same shape as
 * `signin/signin-app.ts` next door, and for the same reason: importing the
 * module must not BE running the app.
 */
import { ensureUserIdentity } from '../identity-prompt.ts';
import { createPromptsApi } from './prompts-api.ts';
import { mountPromptsPage, parsePromptsRoute } from './prompts-page.ts';

async function boot(): Promise<void> {
  const root = document.getElementById('settings-root');
  if (!root) return;
  // No name prompt here. This page is the owner's own configuration, and a
  // modal asking who is reading it is a question nobody came here to answer.
  const user = await ensureUserIdentity(
    null,
    {
      get: (k) => localStorage.getItem(k),
      set: (k, v) => localStorage.setItem(k, v),
    },
    { suppressNamePrompt: true },
  );
  const route = parsePromptsRoute(location.pathname, location.search);
  const api = createPromptsApi({
    workspaceId: route.workspaceId,
    author: { id: user.id, name: user.name, ...(user.color ? { color: user.color } : {}) },
    async fetchJson<T>(path: string): Promise<T | null> {
      try {
        const res = await fetch(path);
        if (!res.ok) return null;
        return (await res.json()) as T;
      } catch {
        return null;
      }
    },
    async send(path: string, method: string, body: unknown) {
      try {
        const res = await fetch(path, {
          method,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        let parsed: unknown = null;
        try {
          parsed = await res.json();
        } catch {
          parsed = null;
        }
        return { ok: res.ok, status: res.status, body: parsed };
      } catch {
        return { ok: false, status: 0, body: null };
      }
    },
  });
  const page = mountPromptsPage(root, {
    document,
    location,
    history,
    api,
  });
  window.addEventListener('popstate', () => void page.render());
  await page.render();
}

void boot();
