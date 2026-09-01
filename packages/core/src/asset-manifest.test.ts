import { describe, expect, it } from 'vitest';
import {
  SHELL_ASSETS,
  assetHref,
  hashedAssetName,
  isContentHashedAsset,
  parseAssetManifest,
  rewriteAssetRefs,
} from './asset-manifest.ts';

describe('hashedAssetName', () => {
  it('gives different bytes a different URL — the whole mechanism', () => {
    // This is the property the fix rests on. A tab reloads, gets the shell,
    // and asks for the URLs the shell names. If a changed bundle could keep
    // its old URL, a cache holding that URL could answer, and the reload
    // lands right back on the build the stale banner is complaining about.
    const before = hashedAssetName('app.js', 'console.log(1)');
    const after = hashedAssetName('app.js', 'console.log(2)');
    expect(after).not.toBe(before);
  });

  it('gives identical bytes the SAME URL, so a no-op deploy costs no re-download', () => {
    // The other half. Prod rebuilds the client on every restart; if the name
    // moved with the clock, every restart would evict a 4 MB bundle from
    // every cache for nothing.
    expect(hashedAssetName('app.js', 'console.log(1)')).toBe(
      hashedAssetName('app.js', 'console.log(1)'),
    );
  });

  it('keeps the extension, because the server picks content-type off it', () => {
    expect(hashedAssetName('styles.css', 'body{}')).toMatch(/^styles-[0-9a-f]{16}\.css$/);
    expect(hashedAssetName('app.js', 'x')).toMatch(/^app-[0-9a-f]{16}\.js$/);
  });

  it('reads the same whether the bytes arrive as a string or a buffer', () => {
    expect(hashedAssetName('app.js', 'hello')).toBe(
      hashedAssetName('app.js', new TextEncoder().encode('hello')),
    );
  });

  it('names every asset a shell references', () => {
    // The list is the contract between the build and the server: an entry
    // missing from it is an entry that keeps its permanent URL, which is the
    // bug. `sw.js` must stay OUT — its URL is its registration identity.
    expect([...SHELL_ASSETS]).toEqual(
      expect.arrayContaining([
        'app.js',
        'hub.js',
        'landing.js',
        'signin.js',
        'sentry.js',
        'styles.css',
        'tokens.css',
      ]),
    );
    expect([...SHELL_ASSETS]).not.toContain('sw.js');
  });
});

describe('isContentHashedAsset', () => {
  it('says yes to a name this build emitted, so it can be served immutable', () => {
    expect(isContentHashedAsset(hashedAssetName('app.js', 'x'))).toBe(true);
    expect(isContentHashedAsset(hashedAssetName('styles.css', 'x'))).toBe(true);
    // The bundler's own lazy chunks, which have been content-addressed all
    // along and were being served `no-cache` anyway.
    expect(isContentHashedAsset('architecture-YZFGNWBL-rfecyfr5.js')).toBe(true);
  });

  it('says no to every fixed name, because immutable on one of those is the old bug', () => {
    // A year of `immutable` on a name whose bytes can change is strictly
    // worse than what shipped before this fix — there would be no
    // revalidation at all. Each of these keeps a fixed URL on purpose.
    for (const name of [
      'app.js',
      'hub.js',
      'styles.css',
      'tokens.css',
      'sw.js',
      'BUILD_INFO.txt',
      'index.html',
      'manifest.webmanifest',
    ]) {
      expect(isContentHashedAsset(name)).toBe(false);
    }
  });

  it('says no to a sourcemap, hashed sibling or not', () => {
    expect(isContentHashedAsset('app-a36ef2b9513b800f.js.map')).toBe(false);
    expect(isContentHashedAsset('app.js.map')).toBe(false);
  });
});

describe('parseAssetManifest', () => {
  it('reads the mapping the build writes', () => {
    expect(parseAssetManifest('{"app.js":"app-abc123def4567890.js"}')).toEqual({
      'app.js': 'app-abc123def4567890.js',
    });
  });

  it('degrades to the plain names rather than throwing', () => {
    // A server pointed at a dist built before hashing landed has no manifest
    // at all, and it must still serve a working page — with the fixed names,
    // which is exactly the behaviour it had.
    for (const bad of ['', 'not json', 'null', '[]', '"a string"', '{"app.js":42}']) {
      expect(parseAssetManifest(bad)).toEqual({});
    }
  });
});

describe('assetHref', () => {
  it('points at the hashed name when there is one', () => {
    expect(assetHref({ 'app.js': 'app-1234567890abcdef.js' }, 'app.js')).toBe(
      '/app/app-1234567890abcdef.js',
    );
  });

  it('falls back to the plain name, which the build still emits', () => {
    expect(assetHref({}, 'hub.js')).toBe('/app/hub.js');
  });
});

describe('rewriteAssetRefs', () => {
  it('rewrites the reference a shell actually contains', () => {
    const out = rewriteAssetRefs('<script type="module" src="/app/app.js"></script>', {
      'app.js': 'app-1234567890abcdef.js',
    });
    expect(out).toContain('src="/app/app-1234567890abcdef.js"');
    expect(out).not.toContain('/app/app.js"');
  });

  it('does not eat the sourcemap URL sitting next to it', () => {
    // `/app/app.js` is a prefix of `/app/app.js.map`. A naive replace rewrites
    // the map to a file that was never emitted, and devtools 404s on it.
    const out = rewriteAssetRefs('//# sourceMappingURL=/app/app.js.map', {
      'app.js': 'app-1234567890abcdef.js',
    });
    expect(out).toBe('//# sourceMappingURL=/app/app.js.map');
  });

  it('leaves a name it has no mapping for alone', () => {
    const out = rewriteAssetRefs('<script src="/app/sw.js"></script>', {
      'app.js': 'app-1234567890abcdef.js',
    });
    expect(out).toBe('<script src="/app/sw.js"></script>');
  });
});
