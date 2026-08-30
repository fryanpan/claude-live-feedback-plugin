import { describe, expect, it } from 'bun:test';
import { injectSentryHead, sentryHeadTags } from '../src/browser-sentry.ts';

/**
 * Where the tags go in a document this server did not template — the built
 * `index.html`, and a mockup, which is somebody's own hand-written file and
 * may have no `<head>` at all.
 *
 * Every DSN here is fictional.
 */
const cfg = { dsn: 'https://examplekey@o0.ingest.sentry.io/0', release: 'v9.9.9-1-gfeedface' };

describe('the Sentry head tags', () => {
  it('are nothing at all when unconfigured', () => {
    expect(sentryHeadTags(null, 'doc')).toBe('');
    expect(injectSentryHead('<html><head></head></html>', null, 'doc')).toBe(
      '<html><head></head></html>',
    );
  });

  it('escape a DSN that would otherwise close the attribute', () => {
    // A DSN is config, not user input — but config with a quote in it must
    // not be able to write markup.
    const tags = sentryHeadTags({ dsn: 'https://a"><script>x</script>@o0/0' }, 'doc');
    expect(tags).not.toContain('<script>x');
    expect(tags).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('omit the release when there is none to name', () => {
    expect(sentryHeadTags({ dsn: cfg.dsn, release: null }, 'doc')).not.toContain('sentry-release');
    expect(sentryHeadTags({ dsn: cfg.dsn, release: '  ' }, 'doc')).not.toContain('sentry-release');
  });
});

describe('where the tags land', () => {
  const has = (html: string) => html.includes('sentry-dsn') && html.includes('/app/sentry.js');

  it('go before </head> when there is one', () => {
    const out = injectSentryHead(
      '<!doctype html><html><head><title>t</title></head><body>b</body></html>',
      cfg,
      'doc',
    );
    expect(has(out)).toBe(true);
    expect(out.indexOf('sentry-dsn')).toBeLessThan(out.indexOf('</head>'));
    expect(out).toContain('<body>b</body>');
  });

  it('go after <head …> when the close tag is missing', () => {
    const out = injectSentryHead('<html><head><title>t</title><body>b', cfg, 'mockup');
    expect(has(out)).toBe(true);
    expect(out.indexOf('<head>')).toBeLessThan(out.indexOf('sentry-dsn'));
  });

  it('go after the doctype when a hand-written mockup has no head at all', () => {
    // Prepending BEFORE a doctype puts the browser in quirks mode, which
    // would change how the page somebody is reviewing renders.
    const out = injectSentryHead('<!doctype html>\n<p>bare mockup', cfg, 'mockup');
    expect(out.startsWith('<!doctype html>')).toBe(true);
    expect(has(out)).toBe(true);
    expect(out).toContain('<p>bare mockup');
  });

  it('go at the front of a fragment with neither', () => {
    const out = injectSentryHead('<p>fragment', cfg, 'mockup');
    expect(has(out)).toBe(true);
    expect(out).toContain('<p>fragment');
  });

  it('name the page type they were asked for', () => {
    for (const pageType of ['board', 'doc', 'mockup', 'landing', 'signin'] as const) {
      expect(injectSentryHead('<html><head></head>', cfg, pageType)).toContain(
        `<meta name="sentry-page-type" content="${pageType}" />`,
      );
    }
  });
});
