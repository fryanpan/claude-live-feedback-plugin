/**
 * One notes section ACROSS A RESTART.
 *
 * THE BUG THIS PINS. The section a tick extends is the one the ownership
 * ledger says this note-taker wrote; a section it claims nothing in falls back
 * to the position test, and that test fails the moment anything is appended
 * below the notes — a Research placeholder, a heading a person typed. The
 * ledger lived only in memory, so a deploy mid-meeting emptied it and the very
 * next tick opened a SECOND "Meeting notes": the twinning #637 fixed, back
 * again for as long as the process is young. Deploys happen mid-meeting.
 *
 * The restart is modelled the way one really happens: the doc comes back from
 * its markdown, the process's ledger is new, and the recording is a NEW
 * meeting — the browser says "the connection to the meeting was lost" and the
 * person presses record again, which mints a new meeting id. That is why the
 * claim cannot be keyed to the meeting id alone.
 *
 * All fixtures are synthetic. The repo is public.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { prose } from '@feedback/core';
import type * as Y from 'yjs';
import { MEETING_NOTES_HEADING, sectionInsertIndex } from '../src/notes-section.ts';
import { createNotesTickHarness } from './notes-tick-harness.ts';

const DOC_ID = 'd-huddle';

/** The heading a Research press leaves below the notes — the writer whose
 *  placeholder triggered the original report. */
function pressResearch(ydoc: Y.Doc, topic: string): void {
  const fragment = prose.getProseFragment(ydoc);
  fragment.insert(
    sectionInsertIndex(fragment),
    prose.parseMarkdownBlocks(`## Research: ${topic}\n\nResearching — in progress.`),
  );
}

describe('a deploy mid-meeting keeps the notes in one section', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'notes-ledger-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('the tick after a restart extends the section rather than twinning it', async () => {
    const first = createNotesTickHarness({
      doc: '# Agenda\n\nSome intro.\n',
      dataDir,
      docId: DOC_ID,
      meetingId: 'm-1',
      compose: () => '## Meeting notes\n\n- we should measure first\n',
    });
    await first.speak('We should measure first.');
    expect(first.countHeadings(MEETING_NOTES_HEADING)).toBe(1);
    // A Research press lands a heading below the notes: the notes stop being
    // the doc's tail, which is all the position test ever looked at.
    pressResearch(first.ydoc, 'pricing');
    const onDisk = first.markdown();
    await first.end();

    // The deploy. New process, new ledger, doc reloaded, new recording.
    const after = createNotesTickHarness({
      doc: onDisk,
      dataDir,
      docId: DOC_ID,
      meetingId: 'm-2',
      compose: () => '## Meeting notes\n\n- we should measure first\n- Devi owns the rollout\n',
    });
    const shot = await after.speak('Devi owns the rollout.');

    expect(after.countHeadings(MEETING_NOTES_HEADING)).toBe(1);
    expect(shot.notes).toContain('we should measure first');
    expect(shot.notes).toContain('Devi owns the rollout');
    // The point carried across the restart is written once, not re-listed.
    expect(shot.markdown.match(/we should measure first/g)).toHaveLength(1);
    expect(after.errors).toEqual([]);
    await after.end();
  });
});
