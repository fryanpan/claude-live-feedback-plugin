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

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prose } from '@feedback/core';
import type * as Y from 'yjs';
import { createNotesLedger } from '../src/meeting-notes-doc.ts';
import { NOTES_LEDGER_CONTINUATION_MS, createNotesLedgerStore } from '../src/notes-ledger-store.ts';
import { createNotesOwnership } from '../src/notes-ownership.ts';
import { MEETING_NOTES_HEADING, sectionInsertIndex } from '../src/notes-section.ts';
import { createNotesTickHarness } from './notes-tick-harness.ts';

const DOC_ID = 'd-huddle';

/** A stand-in for one item's Yjs element. The ledger only ever uses it as a
 *  WeakMap key, and a fresh object per call is what a doc reloaded from disk
 *  hands back: the same words in objects nothing has seen before. */
function element(): Y.XmlElement {
  return {} as unknown as Y.XmlElement;
}

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

  it('a section holding none of the note-taker’s lines is not claimed after a restart', () => {
    // The negative control for the test above: the claim recognises a section
    // by lines this note-taker WROTE, never by its heading. A "Meeting notes"
    // a person opened themselves — or one whose every note they have since
    // rewritten — is not adopted, and the position test decides it as before.
    const written = createNotesLedger(createNotesLedgerStore(dataDir));
    written.beginMeeting(DOC_ID, 'm-1');
    written.forDoc(DOC_ID).record([
      { el: element(), md: 'we should measure first' },
      { el: element(), md: 'Devi owns the rollout' },
    ]);

    const restarted = createNotesLedger(createNotesLedgerStore(dataDir));
    restarted.beginMeeting(DOC_ID, 'm-2');
    const ownership = restarted.forDoc(DOC_ID);
    expect(ownership.wroteAnyOf(['we should measure first'])).toBe(true);
    expect(ownership.wroteAnyOf(['my own heading’s first line', 'and its second'])).toBe(false);
    // And recognising the section grants nothing inside it: the restarted
    // server may add and suggest there, never replace.
    expect(ownership.claims(element(), 'we should measure first')).toBe(false);
  });

  it('a section sharing only a topic heading with the notes is not claimed', () => {
    // A sub-heading is an ordinary item to the merge, so it used to go into
    // the durable claim beside the bullets. It is the one item that cannot
    // carry evidence: the composer emits the same small vocabulary every
    // meeting, and a person organising their own notes reaches for the same
    // words. One `### Decisions` in common would hand the note-taker a
    // section it never wrote a word of.
    const first = createNotesTickHarness({
      doc: '# Agenda\n\nSome intro.\n',
      dataDir,
      docId: DOC_ID,
      meetingId: 'm-1',
      compose: () => '## Meeting notes\n\n### Decisions\n\n- we should measure first\n',
    });
    return (async () => {
      const wrote = await first.speak('We should measure first.');
      expect(wrote.markdown).toContain('### Decisions');
      await first.end();

      // The restart finds a "Meeting notes" holding the SAME topic heading
      // and none of the note-taker's own lines — the person kept the shape
      // and rewrote the substance. A Research heading sits below it, so the
      // position test cannot claim it either, and the tick must start its
      // own section rather than growing theirs.
      const after = createNotesTickHarness({
        doc: [
          '# Agenda',
          '',
          'Some intro.',
          '',
          '## Meeting notes',
          '',
          '### Decisions',
          '',
          '- I will decide the budget myself',
          '',
          '## Research: pricing',
          '',
          'Researching — in progress.',
          '',
        ].join('\n'),
        dataDir,
        docId: DOC_ID,
        meetingId: 'm-2',
        compose: () => '## Meeting notes\n\n- Devi owns the rollout\n',
      });
      const shot = await after.speak('Devi owns the rollout.');

      expect(after.countHeadings(MEETING_NOTES_HEADING)).toBe(2);
      // And the person's line is untouched wherever it sits.
      expect(shot.markdown).toContain('I will decide the budget myself');
      expect(after.errors).toEqual([]);
      await after.end();
    })();
  });

  it('a second recording in the same sitting keeps writing the same section', () => {
    // THE DELIBERATE HALF of the continuation window, pinned so it cannot be
    // narrowed to "restart-only" by accident. One process, one ledger, two
    // recordings minutes apart, with a Research heading landed below the
    // notes between them. A boot id would make this twin — and it would twin
    // ONLY because something happens to sit below the notes, which is the
    // arbitrary rule rather than the safe one. See `beginMeeting`.
    const ledger = createNotesLedger(createNotesLedgerStore(dataDir));
    const first = createNotesTickHarness({
      doc: '# Agenda\n\nSome intro.\n',
      dataDir,
      ledger,
      docId: DOC_ID,
      meetingId: 'm-1',
      compose: () => '## Meeting notes\n\n- we should measure first\n',
    });
    return (async () => {
      await first.speak('We should measure first.');
      pressResearch(first.ydoc, 'pricing');
      const onDisk = first.markdown();
      await first.end();

      const second = createNotesTickHarness({
        doc: onDisk,
        dataDir,
        ledger,
        docId: DOC_ID,
        meetingId: 'm-2',
        compose: () => '## Meeting notes\n\n- we should measure first\n- Devi owns the rollout\n',
      });
      const shot = await second.speak('Devi owns the rollout.');

      expect(second.countHeadings(MEETING_NOTES_HEADING)).toBe(1);
      expect(shot.notes).toContain('Devi owns the rollout');
      expect(shot.markdown.match(/we should measure first/g)).toHaveLength(1);
      await second.end();
    })();
  });

  it('a meeting long after the last note starts its own section again', () => {
    // The owner's 2026-09-01 rule, unchanged: a NEW meeting does not grow an
    // old meeting's notes above everything a person has written since. The
    // claim is adopted only while the sitting that wrote it is still going on.
    const written = createNotesLedger(createNotesLedgerStore(dataDir));
    written.beginMeeting(DOC_ID, 'm-1');
    written.forDoc(DOC_ID).record([{ el: element(), md: 'last week’s note' }]);

    const later = createNotesLedger(createNotesLedgerStore(dataDir));
    later.beginMeeting(DOC_ID, 'm-2', Date.now() + NOTES_LEDGER_CONTINUATION_MS + 1);
    expect(later.forDoc(DOC_ID).wroteAnyOf(['last week’s note'])).toBe(false);
  });

  it('a ledger with no store behaves exactly as memory alone did', () => {
    const ledger = createNotesLedger();
    ledger.beginMeeting(DOC_ID, 'm-1');
    ledger.forDoc(DOC_ID).record([{ el: element(), md: 'a note' }]);
    expect(ledger.forDoc(DOC_ID).wroteAnyOf(['a note'])).toBe(true);
    // A new recording in the same process carries nothing forward, because
    // nothing was written down for it to read.
    ledger.beginMeeting(DOC_ID, 'm-2');
    expect(ledger.forDoc(DOC_ID).wroteAnyOf(['a note'])).toBe(false);
  });
});

describe('the ledger’s written half, driven directly', () => {
  it('reports the claim to its keeper only when the claim grows', () => {
    // The store is rewritten from this callback, and a tick that re-records
    // the same lines is the ordinary case: the composer returns the WHOLE
    // notes every time. Firing on every record would rewrite the file once
    // per item per tick for the length of a meeting.
    const seen: string[][] = [];
    const ownership = createNotesOwnership({ onWrite: (written) => seen.push([...written]) });
    const first = element();
    ownership.record([{ el: first, md: 'we should measure first' }]);
    expect(seen).toEqual([['we should measure first']]);

    ownership.record([{ el: first, md: 'we should measure first' }]);
    expect(seen).toHaveLength(1);

    ownership.record([{ el: element(), md: 'Devi owns the rollout' }]);
    expect(seen).toHaveLength(2);
    expect(seen.at(-1)).toEqual(['we should measure first', 'Devi owns the rollout']);
  });

  it('never claims an empty item, so a blank line cannot identify a section', () => {
    // `wroteAnyOf` decides which section a tick extends. An empty item is
    // what a person leaves behind pressing return in their own notes, and a
    // claim on the empty string would hand the note-taker every section that
    // has one.
    const seen: string[][] = [];
    const ownership = createNotesOwnership({ onWrite: (written) => seen.push([...written]) });
    ownership.record([{ el: element(), md: '' }]);
    expect(ownership.wroteAnyOf([''])).toBe(false);
    expect(seen).toEqual([]);
  });

  it('seeds a claim it can recognise but may not replace', () => {
    // The whole shape of the restart: the text half comes back, the element
    // half cannot and must not.
    const ownership = createNotesOwnership({ written: ['a line from before the restart'] });
    expect(ownership.wroteAnyOf(['a line from before the restart'])).toBe(true);
    expect(ownership.claims(element(), 'a line from before the restart')).toBe(false);
  });

  it('a release drops what may be replaced and keeps which section it is', () => {
    // The two halves have different lives. Releasing is how a new recording
    // stops overwriting the last one's notes; it is not a statement about
    // where those notes are.
    const ownership = createNotesOwnership();
    const el = element();
    ownership.record([{ el, md: 'a note' }]);
    expect(ownership.claims(el, 'a note')).toBe(true);

    ownership.release();
    expect(ownership.claims(el, 'a note')).toBe(false);
    expect(ownership.wroteAnyOf(['a note'])).toBe(true);
  });
});

describe('a topic heading is not evidence', () => {
  it('records a heading as the agent’s element without letting it claim a section', () => {
    // Both halves in one assertion, because the split is the whole point: the
    // note-taker must go on owning the heading it wrote (so it can revise it),
    // and that heading must never be what tells a later process "this section
    // is mine".
    const written: string[][] = [];
    const ownership = createNotesOwnership({ onWrite: (w) => written.push([...w]) });
    const heading = { nodeName: 'heading' } as unknown as Y.XmlElement;
    const bullet = { nodeName: 'listItem' } as unknown as Y.XmlElement;
    ownership.record([
      { el: heading, md: '### Decisions' },
      { el: bullet, md: 'ship on Friday' },
    ]);

    expect(ownership.claims(heading, '### Decisions')).toBe(true);
    expect(ownership.wroteAnyOf(['### Decisions'])).toBe(false);
    expect(ownership.wroteAnyOf(['ship on Friday'])).toBe(true);
    expect(written).toEqual([['ship on Friday']]);
  });

  it('drops a heading a record written by an older build still carries', () => {
    // The seed is text with no elements to ask, so the one thing it can go on
    // is the leading `#` a serialized heading always has. Without this a file
    // written before the guard — or edited by hand — would put the claim back.
    const ownership = createNotesOwnership({
      written: ['### Decisions', '## Next steps', 'ship on Friday'],
    });
    expect(ownership.wroteAnyOf(['### Decisions'])).toBe(false);
    expect(ownership.wroteAnyOf(['## Next steps'])).toBe(false);
    expect(ownership.wroteAnyOf(['ship on Friday'])).toBe(true);
    // A line that merely mentions a hash is not a heading.
    expect(
      createNotesOwnership({ written: ['#1 priority is pricing'] }).wroteAnyOf([
        '#1 priority is pricing',
      ]),
    ).toBe(true);
  });
});
