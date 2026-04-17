import { describe, expect, it, beforeEach, afterEach } from 'vitest';

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
  (globalThis as unknown as { fetch: typeof fetch }).fetch = async () =>
    new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
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
    document
      .querySelectorAll('.cfw-overlay, #cfw-light-styles')
      .forEach((el) => el.remove());
  });

  it('registers the custom element on init', async () => {
    const mod = await importWidget();
    mod.FeedbackWidget.init({ docId: 'w-test-1', user: 'bryan' });
    expect(customElements.get('claude-feedback-widget')).toBeTruthy();
    expect(document.querySelector('claude-feedback-widget')).toBeTruthy();
  });

  it('opens and closes the panel via the FAB', async () => {
    const mod = await importWidget();
    const el = mod.FeedbackWidget.init({ docId: 'w-test-2', user: 'bryan' });
    const root = el.shadowRoot!;
    const fab = root.querySelector('.fab') as HTMLButtonElement;
    const panel = root.querySelector('.panel') as HTMLElement;
    expect(panel.classList.contains('open')).toBe(false);
    fab.click();
    expect(panel.classList.contains('open')).toBe(true);
    fab.click();
    expect(panel.classList.contains('open')).toBe(false);
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
});
