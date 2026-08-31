import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Vitest (happy-dom) tests for the widget. These don't spin up a real
 * server — they verify:
 *   - the custom element registers
 *   - init creates a <claude-feedback-widget> in the body
 *   - clicking the FAB opens/closes the panel
 *   - the picker highlights the hovered element and cleans up
 *
 * Networked behavior (Yjs sync) is covered by the E2E playwright suite.
 */

async function importWidget() {
  // Route fetch + WebSocket to silence connection errors — we only exercise DOM here
  (globalThis as unknown as { fetch: unknown }).fetch = (async () =>
    new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
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

  return import('../src/widget.ts');
}

describe('widget', () => {
  beforeEach(() => {
    document.body.innerHTML = '<main><button id="hello">Hello</button></main>';
    document.head.querySelectorAll('style').forEach((s) => s.remove());
  });

  afterEach(() => {
    // Proactively remove any widget host to avoid happy-dom teardown races
    document.querySelectorAll('claude-feedback-widget').forEach((el) => el.remove());
    document.querySelectorAll('.cfw-overlay, #cfw-light-styles').forEach((el) => el.remove());
  });

  it('registers the custom element on init', async () => {
    const mod = await importWidget();
    mod.FeedbackWidget.init({ docId: 'w-test-1', user: 'bryan' });
    expect(customElements.get('claude-feedback-widget')).toBeTruthy();
    expect(document.querySelector('claude-feedback-widget')).toBeTruthy();
  });

  it('FAB toggles feedback mode — no popover, cursor class on the body', async () => {
    const mod = await importWidget();
    const el = mod.FeedbackWidget.init({ docId: 'w-test-2', user: 'bryan' });
    const root = el.shadowRoot!;
    const fab = root.querySelector('.fab') as HTMLButtonElement;
    const panel = root.querySelector('.panel') as HTMLElement;
    fab.click();
    // Mode on: the body carries the cursor class, and NO panel popped up.
    expect(document.body.classList.contains('cfw-feedback-mode')).toBe(true);
    expect(panel.classList.contains('open')).toBe(false);
    expect(fab.getAttribute('aria-pressed')).toBe('true');
    fab.click();
    expect(document.body.classList.contains('cfw-feedback-mode')).toBe(false);
    expect(fab.getAttribute('aria-pressed')).toBe('false');
  });

  it('Escape exits feedback mode', async () => {
    const mod = await importWidget();
    const el = mod.FeedbackWidget.init({ docId: 'w-test-esc', user: 'bryan' });
    const fab = el.shadowRoot!.querySelector('.fab') as HTMLButtonElement;
    fab.click();
    expect(document.body.classList.contains('cfw-feedback-mode')).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.body.classList.contains('cfw-feedback-mode')).toBe(false);
  });

  it('opens and closes the panel via the threads button', async () => {
    const mod = await importWidget();
    const el = mod.FeedbackWidget.init({ docId: 't-panel', user: 'bryan' });
    const root = el.shadowRoot!;
    const listBtn = root.querySelector('.fab-list') as HTMLButtonElement;
    const panel = root.querySelector('.panel') as HTMLElement;
    expect(panel.classList.contains('open')).toBe(false);
    listBtn.click();
    expect(panel.classList.contains('open')).toBe(true);
    listBtn.click();
    expect(panel.classList.contains('open')).toBe(false);
    // Opening the panel never enters feedback mode.
    expect(document.body.classList.contains('cfw-feedback-mode')).toBe(false);
  });

  /**
   * The point of a MODE over a one-shot picker: several comments in a row
   * without re-arming. A tap opens the composer immediately; cancelling (or
   * posting) leaves the mode armed for the next tap.
   */
  it('a click in feedback mode opens the composer and the mode survives it', async () => {
    const mod = await importWidget();
    const el = mod.FeedbackWidget.init({ docId: 't-multi', user: 'bryan' });
    const root = el.shadowRoot!;
    const target = document.getElementById('hello') as HTMLElement;
    // happy-dom has no layout, so hit-testing by coordinates needs a stub.
    document.elementFromPoint = () => target;
    (root.querySelector('.fab') as HTMLButtonElement).click();
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: 10, clientY: 10 }));
    const composer = root.querySelector('.composer') as HTMLElement;
    expect(composer).toBeTruthy();
    expect(composer.querySelector('.composer-snippet')?.textContent).toContain('Hello');
    // Cancel the comment — the mode stays armed for the next click.
    (composer.querySelector('.cancel') as HTMLButtonElement).click();
    expect(root.querySelector('.composer')).toBeNull();
    expect(document.body.classList.contains('cfw-feedback-mode')).toBe(true);
    // A second tap composes again without touching the FAB.
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: 10, clientY: 10 }));
    expect(root.querySelector('.composer')).toBeTruthy();
    // Escape with a composer open dismisses the composer, not the mode …
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(root.querySelector('.composer')).toBeNull();
    expect(document.body.classList.contains('cfw-feedback-mode')).toBe(true);
    // … and the next Escape exits the mode.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.body.classList.contains('cfw-feedback-mode')).toBe(false);
  });

  it('a refused post keeps the composer, the text, and says what happened', async () => {
    const mod = await importWidget();
    (globalThis as unknown as { fetch: unknown }).fetch = async () =>
      new Response('{}', { status: 500 });
    const el = mod.FeedbackWidget.init({ docId: 'w-test-fail', user: 'bryan' });
    const root = el.shadowRoot!;
    document.elementFromPoint = () => document.getElementById('hello') as HTMLElement;
    (root.querySelector('.fab') as HTMLButtonElement).click();
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: 10, clientY: 10 }));
    const composer = root.querySelector('.composer') as HTMLElement;
    (composer.querySelector('textarea') as HTMLTextAreaElement).value = 'needs work';
    (composer.querySelector('.submit') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 20));
    // The typed comment is not the failure's to discard.
    expect(root.querySelector('.composer')).toBeTruthy();
    expect((root.querySelector('.composer textarea') as HTMLTextAreaElement).value).toBe(
      'needs work',
    );
    expect(root.querySelector('.composer-err')?.textContent).toContain('try again');
    expect((root.querySelector('.composer .submit') as HTMLButtonElement).disabled).toBe(false);
  });

  it('an unreachable server does not strand the button at Posting…', async () => {
    const mod = await importWidget();
    (globalThis as unknown as { fetch: unknown }).fetch = async () => {
      throw new Error('net down');
    };
    const el = mod.FeedbackWidget.init({ docId: 'w-test-net', user: 'bryan' });
    const root = el.shadowRoot!;
    document.elementFromPoint = () => document.getElementById('hello') as HTMLElement;
    (root.querySelector('.fab') as HTMLButtonElement).click();
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: 10, clientY: 10 }));
    const composer = root.querySelector('.composer') as HTMLElement;
    (composer.querySelector('textarea') as HTMLTextAreaElement).value = 'hello?';
    (composer.querySelector('.submit') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 20));
    const submit = root.querySelector('.composer .submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    expect(submit.textContent).toBe('Post');
    expect(root.querySelector('.composer-err')).toBeTruthy();
  });

  it('a click on the widget host in feedback mode is left alone', async () => {
    const mod = await importWidget();
    const el = mod.FeedbackWidget.init({ docId: 't-chrome', user: 'bryan' });
    const root = el.shadowRoot!;
    // Shadow-DOM chrome (composer, FAB) resolves to the host element.
    document.elementFromPoint = () => el as unknown as HTMLElement;
    (root.querySelector('.fab') as HTMLButtonElement).click();
    const ev = new PointerEvent('pointerup', { clientX: 10, clientY: 10, cancelable: true });
    window.dispatchEvent(ev);
    expect(root.querySelector('.composer')).toBeNull();
    expect(ev.defaultPrevented).toBe(false);
  });

  it('init is idempotent — repeat calls return the same element', async () => {
    const mod = await importWidget();
    const a = mod.FeedbackWidget.init({ docId: 'w-test-3', user: 'agent' });
    const b = mod.FeedbackWidget.init({ docId: 'w-test-3', user: 'agent' });
    expect(a).toBe(b);
    expect(document.querySelectorAll('claude-feedback-widget').length).toBe(1);
  });

  it('ignores elements inside its own chrome when picking', async () => {
    const mod = await importWidget();
    const el = mod.FeedbackWidget.init({ docId: 'w-test-4', user: 'bryan' });
    const root = el.shadowRoot!;
    // the overlay lives in light DOM with the data-feedback-widget attr
    const overlay = document.querySelector('[data-feedback-widget]');
    expect(overlay).toBeTruthy();
    // the FAB lives in shadow DOM; neither should be a valid pick target.
    // We approximate by asserting the hit-test would ignore them: the ignored
    // attribute is present on overlay and the <claude-feedback-widget> tag itself.
    const widgetHost = document.querySelector('claude-feedback-widget');
    expect(widgetHost?.hasAttribute('data-feedback-widget')).toBe(true);
    root;
  });

  /**
   * A thread with no anchor is about the PAGE. `create_thread` without a
   * `find` now produces one on any doc, so a mockup can carry one — and the
   * panel is the only place it could ever appear, since there is nothing on
   * the page to pin it to. Dropping it would be the store-has-it /
   * surface-can't-show-it failure, on the surface whose whole job is
   * showing threads.
   */
  it('lists a thread that is about the page itself', async () => {
    const mod = await importWidget();
    const core = await import('@feedback/core');
    const el = mod.FeedbackWidget.init({ docId: 't-subject', user: 'bryan' });
    const inner = el as unknown as {
      client: { ydoc: import('yjs').Doc } | null;
      renderThreads: () => void;
    };
    const ydoc = inner.client?.ydoc;
    expect(ydoc).toBeTruthy();
    if (!ydoc) return;
    const author = { id: 'known-jordan', name: 'Jordan', kind: 'known' as const, color: '#2e7dd7' };
    core.createThread(ydoc, {
      threadId: 'th-subject',
      anchor: { kind: 'subject' },
      createdBy: author,
      firstComment: { id: 'c-1', text: 'This whole screen assumes a signed-in user.' },
    });
    // Positive control: an element-anchored thread on the same doc, so a
    // panel that listed nothing at all could not pass this test.
    core.createThread(ydoc, {
      threadId: 'th-element',
      anchor: {
        kind: 'element',
        fingerprint: {
          id: 'hello',
          tag: 'BUTTON',
          stableAttrs: {},
          classes: [],
          text: 'Hello',
          path: 'BUTTON[0] > MAIN[0]',
          dataAttrs: {},
        },
        snippet: { text: 'Hello' },
      } as never,
      createdBy: author,
      firstComment: { id: 'c-2', text: 'And this button is mislabelled.' },
    });
    inner.renderThreads();
    const rows = [...el.shadowRoot!.querySelectorAll('.panel-threads .thread')];
    const texts = rows.map((r) => r.textContent ?? '');
    expect(texts.some((t) => t.includes('mislabelled'))).toBe(true);
    expect(texts.some((t) => t.includes('signed-in user'))).toBe(true);
  });

  /**
   * On a third-party page the widget is a guest and must keep its identity in
   * its own `cfw:` namespace. On OUR hub the page has already asked the reader
   * their name — two namespaces there means the presence strip greets the
   * reader by that name while every comment the widget posts is signed
   * "Anonymous <animal>". Observed on a live hub before this was fixed.
   */
  describe('identity scope', () => {
    beforeEach(() => localStorage.clear());
    afterEach(() => localStorage.clear());

    it('ignores the host page name by default, and adopts it under scope=host', async () => {
      // Imported for the side effect only: this test drives the element
      // declaratively, so all it needs is `customElements.define` to have run.
      await importWidget();
      // The name the HOST page stored (unprefixed — what ensureUserIdentity writes).
      localStorage.setItem('feedback-user-name', 'Dana Reviewer');

      // Default scope: the guest namespace is empty, so the widget is anonymous.
      const guest = document.createElement('claude-feedback-widget');
      guest.setAttribute('doc-id', 'scope-default');
      document.body.appendChild(guest);
      const guestName = (guest as unknown as { user: { name: string } }).user.name;
      expect(guestName).toMatch(/^Anonymous /);

      // scope=host: the SAME stored name is now the widget's identity.
      const hosted = document.createElement('claude-feedback-widget');
      hosted.setAttribute('doc-id', 'scope-host');
      hosted.setAttribute('identity-scope', 'host');
      document.body.appendChild(hosted);
      expect((hosted as unknown as { user: { name: string } }).user.name).toBe('Dana Reviewer');

      // The pair is the point: same storage, same markup but for one attribute,
      // two different answers. Neither half proves anything alone.
      expect(guestName).not.toBe('Dana Reviewer');
      // And the widget's own UI preference stays namespaced in both scopes, so
      // `identity-scope` cannot make the widget collide with a host key.
      expect(localStorage.getItem('showResolved')).toBeNull();
      // Nothing wrote the host name into the guest namespace either.
      expect(localStorage.getItem('cfw:feedback-user-name')).toBeNull();
    });

    it('via FeedbackWidget.init as well as the attribute', async () => {
      const mod = await importWidget();
      localStorage.setItem('feedback-user-name', 'Reviewer');
      const el = mod.FeedbackWidget.init({ docId: 'scope-init', identityScope: 'host' });
      expect((el as unknown as { user: { name: string } }).user.name).toBe('Reviewer');
    });
  });
});
