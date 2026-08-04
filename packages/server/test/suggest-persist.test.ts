import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import { getProseFragment, serializeFragmentToMarkdown } from '../../core/src/prose.ts';
import {
  SUGGEST_DELETE_MARK,
  SUGGEST_INSERT_MARK,
  type SuggestionAttrs,
  readSuggestionAttrs,
} from '../../core/src/suggest.ts';
import { Rooms } from '../src/rooms.ts';
import { SseHub } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';

/**
 * Proposal isolation, end to end through the real write-back: a suggestion
 * written into a bound doc's Yjs state must NEVER reach the .md on disk,
 * while accepted edits keep flowing; and the marks must survive the .ydoc
 * persist → hydrate cycle a server restart runs (proposals live only in the
 * CRDT — disk has no suggestion syntax).
 */

function makeRooms(dataDir: string): Rooms {
  return new Rooms({
    dataDir,
    sse: new SseHub(),
    webhooks: createWebhookDispatcher({ onLog: () => {} }),
    decorateDocMeta: (m) => ({ ...m, reviewUrl: `http://test/review/${m.docId}` }),
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const sattrs = (sid: string): SuggestionAttrs => ({
  sid,
  authorId: 'agent-1',
  authorName: 'Docs Agent',
  authorColor: '#7c5cff',
  ts: 1754200000000,
});

const MD = '# Title\n\nAlpha beta gamma.\n';

function paragraphText(ydoc: Y.Doc): Y.XmlText {
  const fragment = getProseFragment(ydoc);
  const para = fragment.get(1) as Y.XmlElement; // [heading, paragraph]
  return para.toArray()[0] as Y.XmlText;
}

describe('suggestions vs disk and hydration', () => {
  let dataDir: string;
  let path: string;
  let rooms: Rooms;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'lf-suggest-'));
    path = join(dataDir, 'doc.md');
    writeFileSync(path, MD);
    rooms = makeRooms(dataDir);
    rooms.getOrCreate('s1', { type: 'markdown', sourceUrl: path });
    expect(rooms.attachFile('s1', path).ok).toBe(true);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('a suggestion never reaches disk; accepted edits still flow; hydrate keeps the marks', async () => {
    const ydoc = rooms.get('s1')!.ydoc;
    ydoc.transact(() => {
      const t = paragraphText(ydoc);
      // Replace proposal under one sid: delete 'beta', insert 'delta' after it.
      t.format('Alpha '.length, 'beta'.length, { [SUGGEST_DELETE_MARK]: sattrs('rp') });
      t.insert('Alpha beta'.length, ' delta', { [SUGGEST_INSERT_MARK]: sattrs('rp') });
    }, 'agent');
    // An accepted edit alongside, so the write-back definitely fires.
    expect(rooms.findAndReplace('s1', { find: 'gamma', replace: 'omega' }).ok).toBe(true);
    await sleep(1300); // debounced writer (~1s)

    const onDisk = readFileSync(path, 'utf8');
    expect(onDisk).toContain('omega'); // accepted edit landed
    expect(onDisk).not.toContain('delta'); // proposal did not
    expect(onDisk).toContain('beta'); // proposed deletion still on disk
    expect(onDisk).toBe('# Title\n\nAlpha beta omega.\n');

    // Restart: a fresh Rooms over the same dataDir hydrates from .ydoc.
    const rooms2 = makeRooms(dataDir);
    const ydoc2 = rooms2.get('s1')?.ydoc;
    expect(ydoc2).toBeDefined();
    const delta = paragraphText(ydoc2!).toDelta() as Array<{
      insert?: string;
      attributes?: Record<string, unknown>;
    }>;
    const ins = delta.find((op) => op.attributes?.[SUGGEST_INSERT_MARK] != null);
    const del = delta.find((op) => op.attributes?.[SUGGEST_DELETE_MARK] != null);
    expect(ins?.insert).toBe(' delta');
    expect(del?.insert).toBe('beta');
    const insAttrs = readSuggestionAttrs(ins?.attributes?.[SUGGEST_INSERT_MARK]);
    expect(insAttrs?.sid).toBe('rp');
    expect(typeof (ins?.attributes?.[SUGGEST_INSERT_MARK] as SuggestionAttrs).ts).toBe('number');
    // And the hydrated doc still serializes to the accepted state.
    expect(serializeFragmentToMarkdown(getProseFragment(ydoc2!))).toBe(
      '# Title\n\nAlpha beta omega.\n',
    );
  });
});
