/**
 * The channel renderer turns a `doc.sync_error` frame into a readable
 * sentence, not the bare-slug fallback.
 *
 * The server broadcasts `doc.sync_error` when a write into a bound doc is
 * lost (conflict reassert, parse failure) — see
 * `packages/server/test/sync-error-event.test.ts` for the end-to-end half.
 * This layer is the last hop: `emitChannelMessage` rebuilds each event's
 * channel line by hand, so an event it has no case for renders as
 * `[doc.sync_error] thread ` — a slug that buries exactly the event whose
 * whole point is being noticed.
 *
 * Source-reading, like tool-wiring.test.ts: mcp.ts is a bundle entry point
 * and exports nothing. The committed bundle is deliberately NOT asserted
 * here — CI's build:mcp diff gate already fails any PR whose bundle does not
 * match a fresh build of this source, so asserting it twice would only make
 * this test red between an src edit and the rebuild.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, '../src/mcp.ts'), 'utf8');

/** emitChannelMessage's body, start to the next top-level function. */
function channelRenderer(): string {
  const start = SRC.indexOf('async function emitChannelMessage(');
  expect(start, 'emitChannelMessage not found').toBeGreaterThan(-1);
  return SRC.slice(start, SRC.indexOf('\nfunction ', start));
}

describe('doc.sync_error renders as a sentence on the channel', () => {
  it('has a dedicated case instead of the bare-slug fallback', () => {
    const renderer = channelRenderer();
    expect(renderer).toContain("event === 'doc.sync_error'");
  });

  it('the rendered line carries the path, the message, and the backup path', () => {
    const renderer = channelRenderer();
    const start = renderer.indexOf("event === 'doc.sync_error'");
    const block = renderer.slice(start, renderer.indexOf('return;', start));
    // The sentence leads with WHERE (the bound file) and says WHAT (the
    // server's own recovery message, which names the clobber backup).
    expect(block).toContain('p.path');
    expect(block).toContain('p.message');
    // The backup path rides the structured meta so an agent can read the
    // overwritten bytes back without parsing prose.
    expect(block).toContain('backup_path');
  });
});
