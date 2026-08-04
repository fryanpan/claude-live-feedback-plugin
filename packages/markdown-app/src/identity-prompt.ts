import {
  type User,
  dismissNamePrompt,
  needsNamePrompt,
  resolveUser,
  storeUserName,
} from '@feedback/core';

type IdentityStorage = { get(k: string): string | null; set(k: string, v: string): void };

/**
 * Resolve the reviewer's identity, showing the first-arrival name prompt when
 * nothing is stored yet. Resolves once the user submits a name (persisted to
 * storage) or skips (stays anonymous; the skip is remembered so this browser
 * is never asked again). When identity is already determined — stored name,
 * known `?as=` param, or a prior skip — no UI is shown.
 */
export function ensureUserIdentity(
  asParam: string | null | undefined,
  storage: IdentityStorage | null,
): Promise<User> {
  if (!needsNamePrompt(asParam, storage)) {
    return Promise.resolve(resolveUser(asParam, storage));
  }
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'identity-prompt';
    overlay.innerHTML = `
      <form class="identity-card">
        <h2>Who's reviewing?</h2>
        <p>Your name labels your comments and edits for everyone else on this doc.</p>
        <input type="text" name="name" autocomplete="name" placeholder="Your name" maxlength="40" />
        <div class="identity-actions">
          <button type="button" class="identity-skip">Stay anonymous</button>
          <button type="submit">Continue</button>
        </div>
      </form>`;
    const form = overlay.querySelector('form');
    const input = overlay.querySelector('input');
    const skip = overlay.querySelector('.identity-skip');
    const finish = (user: User) => {
      overlay.remove();
      resolve(user);
    };
    form?.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = input?.value.trim() ?? '';
      if (!name) {
        input?.focus();
        return;
      }
      storeUserName(storage, name);
      finish(resolveUser(null, storage));
    });
    skip?.addEventListener('click', () => {
      dismissNamePrompt(storage);
      finish(resolveUser(null, storage));
    });
    document.body.appendChild(overlay);
    input?.focus();
  });
}
