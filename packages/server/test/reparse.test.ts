import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import { getProseFragment, headingLevelOf } from '../../core/src/prose.ts';
import { Rooms } from '../src/rooms.ts';
import { SseHub } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';

function makeRooms(dataDir: string): Rooms {
  return new Rooms({
    dataDir,
    sse: new SseHub(),
    webhooks: createWebhookDispatcher({ onLog: () => {} }),
    decorateDocMeta: (m) => ({ ...m, reviewUrl: `http://test/review/${m.docId}` }),
  });
}

const AUTHOR = { id: 'u1', kind: 'known' as const, name: 'Reviewer', color: '#000' };

const DOC = `# Title

Intro paragraph.

## Section one

Keep this sentence intact.

## Section two

Old body text.
`;

describe('reparseFromDisk (markdown)', () => {
  let dataDir: string;
  let path: string;
  let rooms: Rooms;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'lf-reparse-'));
    path = join(dataDir, 'doc.md');
    writeFileSync(path, DOC);
    rooms = makeRooms(dataDir);
    rooms.getOrCreate('d1', { type: 'markdown', sourceUrl: path });
    expect(rooms.attachFile('d1', path).ok).toBe(true);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('stores heading levels as numbers so the editor renders h1/h2 distinctly', () => {
    const fragment = getProseFragment(rooms.get('d1')!.ydoc);
    const headings = (fragment.toArray() as Y.XmlElement[]).filter((b) => b.nodeName === 'heading');
    expect(headings.map(headingLevelOf)).toEqual([1, 2, 2]);
    // The number is what makes Tiptap emit <h1>/<h2>; a string renders all-<h1>.
    for (const h of headings) expect(typeof h.getAttribute('level')).toBe('number');
  });

  it('repairs a legacy string heading level even when the markdown is identical', () => {
    // Regress a heading to the pre-fix form, the way an existing .ydoc has it.
    const ydoc = rooms.get('d1')!.ydoc;
    const heading = getProseFragment(ydoc).get(0) as Y.XmlElement;
    heading.setAttribute('level', '1');
    expect(typeof heading.getAttribute('level')).toBe('string');

    // The block diff correctly sees this block as unchanged (a string '1' and
    // a number 1 both serialize to `# Title`), so reparse must repair the
    // attribute itself — otherwise force-pulling a legacy doc leaves it broken.
    expect(rooms.reparseFromDisk('d1').ok).toBe(true);
    expect(heading.getAttribute('level')).toBe(1 as unknown as string);
  });

  it('keeps a thread anchored to an untouched block alive across a reparse', async () => {
    const created = await rooms.createThreadByFind(
      'd1',
      { find: 'Keep this sentence intact.' },
      AUTHOR,
      'Nice.',
    );
    expect(created.ok).toBe(true);

    // An agent rewrites a different part of the file, then force-pulls it.
    writeFileSync(path, DOC.replace('Old body text.', 'Rewritten body text, much longer now.'));
    expect(rooms.reparseFromDisk('d1').ok).toBe(true);

    const thread = rooms.listThreads('d1')[0];
    expect(thread?.anchor.kind).toBe('text-range');
    const anchor = thread?.anchor as { startRel: Uint8Array; endRel: Uint8Array };
    const ydoc = rooms.get('d1')!.ydoc;
    for (const rel of [anchor.startRel, anchor.endRel]) {
      const abs = Y.createAbsolutePositionFromRelativePosition(
        Y.decodeRelativePosition(new Uint8Array(rel)),
        ydoc,
      );
      expect(abs).not.toBeNull();
    }
  });

  it('picks up new content and heading levels from disk', () => {
    writeFileSync(path, `${DOC}\n### Added later\n\nMore text.\n`);
    expect(rooms.reparseFromDisk('d1').ok).toBe(true);

    const fragment = getProseFragment(rooms.get('d1')!.ydoc);
    const headings = (fragment.toArray() as Y.XmlElement[]).filter((b) => b.nodeName === 'heading');
    expect(headings.map(headingLevelOf)).toEqual([1, 2, 2, 3]);
    expect(rooms.getDoc('d1')?.plainText).toContain('More text.');
  });
});
