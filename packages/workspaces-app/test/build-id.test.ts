import { describe, expect, it } from 'vitest';
import { computeBuildId } from '../src/build-id.ts';

describe('computeBuildId', () => {
  it('is the same id for the same bytes — the whole point', () => {
    // Prod rebuilds the client on every restart. If a rebuild of unchanged
    // source produced a new id, every restart would tell every open tab that
    // a new version is available, which is the nag the notice exists to avoid.
    const a = computeBuildId([
      { name: 'app.js', bytes: 'console.log(1)' },
      { name: 'styles.css', bytes: 'body{}' },
    ]);
    const b = computeBuildId([
      { name: 'app.js', bytes: 'console.log(1)' },
      { name: 'styles.css', bytes: 'body{}' },
    ]);
    expect(a).toBe(b);
  });

  it('does not depend on the order the assets are handed over', () => {
    const a = computeBuildId([
      { name: 'app.js', bytes: 'x' },
      { name: 'hub.js', bytes: 'y' },
    ]);
    const b = computeBuildId([
      { name: 'hub.js', bytes: 'y' },
      { name: 'app.js', bytes: 'x' },
    ]);
    expect(a).toBe(b);
  });

  it('moves when any served asset moves, stylesheet included', () => {
    const base = [
      { name: 'app.js', bytes: 'console.log(1)' },
      { name: 'styles.css', bytes: 'body{}' },
    ];
    const jsChanged = [
      { name: 'app.js', bytes: 'console.log(2)' },
      { name: 'styles.css', bytes: 'body{}' },
    ];
    // A CSS-only change is a real change to what the person sees, and it is
    // the one a JS-only hash would miss.
    const cssChanged = [
      { name: 'app.js', bytes: 'console.log(1)' },
      { name: 'styles.css', bytes: 'body{color:red}' },
    ];
    expect(computeBuildId(jsChanged)).not.toBe(computeBuildId(base));
    expect(computeBuildId(cssChanged)).not.toBe(computeBuildId(base));
  });

  it('cannot be fooled by moving bytes across the boundary between assets', () => {
    // Concatenating without a length prefix would make these two identical.
    const split = [
      { name: 'a.js', bytes: 'ab' },
      { name: 'b.js', bytes: 'c' },
    ];
    const moved = [
      { name: 'a.js', bytes: 'a' },
      { name: 'b.js', bytes: 'bc' },
    ];
    expect(computeBuildId(split)).not.toBe(computeBuildId(moved));
  });

  it('reads the same whether the bytes arrive as a string or a buffer', () => {
    const asText = computeBuildId([{ name: 'app.js', bytes: 'hello' }]);
    const asBytes = computeBuildId([{ name: 'app.js', bytes: new TextEncoder().encode('hello') }]);
    expect(asText).toBe(asBytes);
  });
});
