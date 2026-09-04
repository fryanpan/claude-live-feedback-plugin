/**
 * The notes ledger's on-disk half, driven directly.
 *
 * Everything here is about the file surviving what a data dir does to files:
 * a first write into a folder nobody made, a reader arriving before any write,
 * a record torn by a crash mid-append, a record so old it belongs to another
 * meeting. Each of those has one right answer and none of them is a throw — a
 * meeting must never lose its notes to the file that only keeps them together.
 *
 * All fixtures are synthetic. The repo is public.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { meetingDirPath } from '../src/meetings.ts';
import {
  NOTES_LEDGER_CONTINUATION_MS,
  NOTES_LEDGER_FILENAME,
  NOTES_LEDGER_MAX_ITEMS,
  cappedItems,
  continuesSitting,
  createNotesLedgerStore,
  notesLedgerPath,
} from '../src/notes-ledger-store.ts';

const DOC_ID = 'd-huddle';

describe('createNotesLedgerStore', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'notes-ledger-store-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('writes a record into the doc’s own meetings folder and reads it back', () => {
    const store = createNotesLedgerStore(dataDir);
    expect(store.read(DOC_ID)).toBeNull();

    store.write(DOC_ID, {
      meetingId: 'm-1',
      writtenAt: 1_700_000_000_000,
      items: ['we should measure first', 'Devi owns the rollout'],
    });

    expect(existsSync(notesLedgerPath(dataDir, DOC_ID))).toBe(true);
    expect(notesLedgerPath(dataDir, DOC_ID)).toBe(
      join(meetingDirPath(dataDir, DOC_ID), NOTES_LEDGER_FILENAME),
    );
    expect(store.read(DOC_ID)).toEqual({
      meetingId: 'm-1',
      writtenAt: 1_700_000_000_000,
      items: ['we should measure first', 'Devi owns the rollout'],
    });
  });

  it('a second write replaces the first — the record is a snapshot, not a log', () => {
    const store = createNotesLedgerStore(dataDir);
    store.write(DOC_ID, { meetingId: 'm-1', writtenAt: 1, items: ['first'] });
    store.write(DOC_ID, { meetingId: 'm-2', writtenAt: 2, items: ['first', 'second'] });
    expect(store.read(DOC_ID)?.items).toEqual(['first', 'second']);
    expect(store.read(DOC_ID)?.meetingId).toBe('m-2');
  });

  it('two docs keep separate claims', () => {
    const store = createNotesLedgerStore(dataDir);
    store.write('d-one', { meetingId: 'm-1', writtenAt: 1, items: ['one’s note'] });
    store.write('d-two', { meetingId: 'm-2', writtenAt: 1, items: ['two’s note'] });
    expect(store.read('d-one')?.items).toEqual(['one’s note']);
    expect(store.read('d-two')?.items).toEqual(['two’s note']);
  });

  it('a torn or foreign file reads as no claim rather than throwing', () => {
    const store = createNotesLedgerStore(dataDir);
    store.write(DOC_ID, { meetingId: 'm-1', writtenAt: 1, items: ['a note'] });
    const path = notesLedgerPath(dataDir, DOC_ID);

    writeFileSync(path, '{"meetingId":"m-1","writtenAt":1,"item');
    expect(store.read(DOC_ID)).toBeNull();

    writeFileSync(path, '{"meetingId":"m-1"}');
    expect(store.read(DOC_ID)).toBeNull();

    writeFileSync(path, '[]');
    expect(store.read(DOC_ID)).toBeNull();

    // A record whose items list has picked up something that is not a line
    // keeps the lines it does have.
    writeFileSync(path, '{"meetingId":"m-1","writtenAt":1,"items":["a note",7,null]}');
    expect(store.read(DOC_ID)?.items).toEqual(['a note']);
  });

  it('caps a record at the newest lines, so an hour of ticks cannot grow it forever', () => {
    const store = createNotesLedgerStore(dataDir);
    const items = Array.from({ length: NOTES_LEDGER_MAX_ITEMS + 5 }, (_, i) => `note ${i}`);
    store.write(DOC_ID, { meetingId: 'm-1', writtenAt: 1, items });

    const back = store.read(DOC_ID);
    expect(back?.items).toHaveLength(NOTES_LEDGER_MAX_ITEMS);
    expect(back?.items.at(-1)).toBe(`note ${NOTES_LEDGER_MAX_ITEMS + 4}`);
    expect(back?.items).not.toContain('note 0');
  });

  it('an unwritable data dir loses the claim, never the meeting', () => {
    // A path whose parent is a FILE: every mkdir and write under it fails.
    const blocked = join(dataDir, 'not-a-dir');
    writeFileSync(blocked, 'x');
    const store = createNotesLedgerStore(blocked);
    expect(() => store.write(DOC_ID, { meetingId: 'm-1', writtenAt: 1, items: ['a'] })).not.toThrow();
    expect(store.read(DOC_ID)).toBeNull();
  });
});

describe('cappedItems', () => {
  it('keeps a short list whole', () => {
    expect(cappedItems(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('drops the oldest when the list is over the cap', () => {
    const items = Array.from({ length: NOTES_LEDGER_MAX_ITEMS + 2 }, (_, i) => `n${i}`);
    const out = cappedItems(items);
    expect(out).toHaveLength(NOTES_LEDGER_MAX_ITEMS);
    expect(out[0]).toBe('n2');
  });
});

describe('continuesSitting', () => {
  const record = { meetingId: 'm-1', writtenAt: 1_000_000, items: ['a note'] };

  it('has nothing to continue when there is no record', () => {
    expect(continuesSitting(null, 1_000_000)).toBe(false);
  });

  it('continues a claim written a moment ago — the restart this exists for', () => {
    expect(continuesSitting(record, record.writtenAt + 30_000)).toBe(true);
  });

  it('stops at the window, so a later meeting starts its own section', () => {
    expect(continuesSitting(record, record.writtenAt + NOTES_LEDGER_CONTINUATION_MS)).toBe(true);
    expect(continuesSitting(record, record.writtenAt + NOTES_LEDGER_CONTINUATION_MS + 1)).toBe(
      false,
    );
  });

  it('treats a stamp from the future the same way as one from the past', () => {
    expect(continuesSitting(record, record.writtenAt - 30_000)).toBe(true);
    expect(continuesSitting(record, record.writtenAt - NOTES_LEDGER_CONTINUATION_MS - 1)).toBe(
      false,
    );
  });
});
