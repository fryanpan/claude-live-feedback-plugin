import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { injectWidget } from '../src/mockup-widget.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

describe('injectWidget', () => {
  it('adds the embed before the closing body tag', () => {
    const out = injectWidget('<!doctype html><html><body><h1>Report</h1></body></html>', 'doc-1');
    expect(out).toContain('<claude-feedback-widget doc-id="doc-1">');
    expect(out).toContain('src="/widget.iife.js"');
    expect(out.indexOf('claude-feedback-widget')).toBeLessThan(out.indexOf('</body>'));
  });

  it('never writes a reviewer name into the markup', () => {
    // The widget resolves identity from the browser. A `user=` in the page
    // re-brands whoever opens it — which is the leak this whole path exists
    // to make unnecessary.
    expect(injectWidget('<html><body>x</body></html>', 'doc-1')).not.toContain('user=');
  });

  it('leaves a page that already embeds the widget alone', () => {
    const own =
      '<html><body><claude-feedback-widget doc-id="mine" view="tab=a"></claude-feedback-widget><script src="http://elsewhere/widget.iife.js"></script></body></html>';
    expect(injectWidget(own, 'doc-1')).toBe(own);
    const programmatic =
      '<html><body><script>FeedbackWidget.init({docId: "mine"})</script></body></html>';
    expect(injectWidget(programmatic, 'doc-1')).toBe(programmatic);
  });

  it('appends when the page has no closing body tag', () => {
    const out = injectWidget('<h1>fragment</h1>', 'doc-1');
    expect(out.startsWith('<h1>fragment</h1>')).toBe(true);
    expect(out).toContain('claude-feedback-widget');
  });

  it('escapes the docId into the attribute', () => {
    const out = injectWidget('<body></body>', 'a"><script>bad()</script>');
    expect(out).not.toContain('"><script>bad()');
    expect(out).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('inserts at the LAST closing body tag, not one quoted earlier in the page', () => {
    const out = injectWidget(
      '<html><body><pre>&lt;/body&gt;</pre><code></body></code></body></html>',
      'doc-1',
    );
    expect(out.indexOf('claude-feedback-widget')).toBeGreaterThan(out.indexOf('<code>'));
  });
});

describe('a bound mockup is served with the widget already in it', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'feedback-mockwidget-test-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('serves a widget-free source file with the embed attached', async () => {
    const file = join(dataDir, 'report.html');
    // Exactly what a generator writes: no review scaffolding anywhere in it.
    const source = '<!doctype html><html><body><h1>Benchmark Run</h1></body></html>';
    writeFileSync(file, source);
    expect(source).not.toContain('claude-feedback-widget');

    const res = await fetch(`${base}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'mock-widget-1', type: 'mockup', sourceUrl: file }),
    });
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);

    const served = await fetch(`${base}/mockup/mock-widget-1`);
    expect(served.status).toBe(200);
    const html = await served.text();
    expect(html).toContain('Benchmark Run');
    expect(html).toContain('claude-feedback-widget');
    expect(html).toContain('/widget.iife.js');
    // …and the file on disk is untouched — the reason this is worth doing.
    expect(Bun.file(file).text()).resolves.toBe(source);
  });
});
