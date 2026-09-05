/**
 * The transcript stays in the sister file, and comes back out of the doc —
 * but only ever the transcript.
 *
 * Three statements. A notes tick writes NO verbatim record into the doc
 * (owner, 2026-09-03). A doc that received one from the release that did gets
 * it removed by the next tick. And the removal is keyed on that writer's
 * exact fingerprint — an unbound or data-dir doc, an H2 heading, the doc's
 * tail, one `text` fence and nothing else — because a review found the first
 * version of it deleting a transcript somebody had pasted in by hand.
 *
 * All fixtures are synthetic. The repo is public.
 */

import { describe, expect, it } from 'bun:test';
import { prose } from '@feedback/core';
import * as Y from 'yjs';
import { applyNotesUpdate, createNotesLedger } from '../src/meeting-notes-doc.ts';
import {
  allowedIn,
  dropLegacyTranscriptSection,
  legacyTranscriptSpan,
} from '../src/notes-legacy-transcript.ts';
import { LEGACY_TRANSCRIPT_HEADING, MEETING_NOTES_HEADING } from '../src/notes-section.ts';
import { createNotesTickHarness } from './notes-tick-harness.ts';

const DATA_DIR = '/srv/claude-workspaces/data';

function docFrom(markdown: string): Y.Doc {
  const ydoc = new Y.Doc();
  prose.applyMarkdownToFragment(prose.getProseFragment(ydoc), markdown);
  return ydoc;
}

function markdownOf(ydoc: Y.Doc): string {
  return prose.serializeFragmentToMarkdown(prose.getProseFragment(ydoc));
}

/** A doc as the old writer left it: notes, then the H2, then one `text` fence
 *  at the tail. */
const AS_THE_OLD_WRITER_LEFT_IT = [
  '# Interview prep',
  '',
  `## ${MEETING_NOTES_HEADING}`,
  '',
  '- ask about latency',
  '',
  `## ${LEGACY_TRANSCRIPT_HEADING}`,
  '',
  '```text',
  'Devi: ask about latency',
  'Sam: agreed',
  '```',
  '',
].join('\n');

/** The same doc, but the fence is a person's own paste. Indistinguishable
 *  from the line above by heading alone, which is the whole point. */
const A_PERSON_PASTED_IT = [
  '# Interview prep',
  '',
  `## ${MEETING_NOTES_HEADING}`,
  '',
  '- ask about latency',
  '',
  `## ${LEGACY_TRANSCRIPT_HEADING}`,
  '',
  '```text',
  'I pasted this myself from Otter and I need it.',
  '```',
  '',
].join('\n');

describe('allowedIn', () => {
  it('says yes to an unbound doc and to one bound under the data dir', () => {
    expect(allowedIn({ dataDir: DATA_DIR })).toBe(true);
    expect(allowedIn({ boundPath: `${DATA_DIR}/docs/huddle.md`, dataDir: DATA_DIR })).toBe(true);
    // A trailing separator on either side is the same directory.
    expect(allowedIn({ boundPath: `${DATA_DIR}/notes.md`, dataDir: `${DATA_DIR}/` })).toBe(true);
  });

  it('says no to a repo file, including one whose path merely starts the same way', () => {
    expect(allowedIn({ boundPath: '/Users/someone/dev/project/plan.md', dataDir: DATA_DIR })).toBe(
      false,
    );
    expect(
      allowedIn({ boundPath: '/srv/claude-workspaces/data-old/n.md', dataDir: DATA_DIR }),
    ).toBe(false);
  });

  it('says no when it cannot see the data dir at all', () => {
    expect(allowedIn({ boundPath: '/anywhere/notes.md' })).toBe(false);
    expect(allowedIn({})).toBe(true);
  });
});

describe('legacyTranscriptSpan', () => {
  it('names the H2 and its one text fence at the tail, and nothing else', () => {
    const ydoc = docFrom(AS_THE_OLD_WRITER_LEFT_IT);
    const fragment = prose.getProseFragment(ydoc);
    const span = legacyTranscriptSpan(fragment);
    if (!span) throw new Error('expected a legacy transcript span');
    expect(span.endExclusive).toBe(fragment.length);
    expect(span.endExclusive - span.start).toBe(2);
  });

  it('is null when the fence is any language but text', () => {
    const json = AS_THE_OLD_WRITER_LEFT_IT.replace('```text', '```json');
    expect(legacyTranscriptSpan(prose.getProseFragment(docFrom(json)))).toBeNull();
    // A bare fence carries no language at all, and the writer always set one.
    const bare = AS_THE_OLD_WRITER_LEFT_IT.replace('```text', '```');
    expect(legacyTranscriptSpan(prose.getProseFragment(docFrom(bare)))).toBeNull();
  });

  it('is null for a nested heading, however the section reads', () => {
    const nested = AS_THE_OLD_WRITER_LEFT_IT.replace(
      `## ${LEGACY_TRANSCRIPT_HEADING}`,
      `### ${LEGACY_TRANSCRIPT_HEADING}`,
    );
    expect(legacyTranscriptSpan(prose.getProseFragment(docFrom(nested)))).toBeNull();
  });

  it('is null when the section is not the doc tail', () => {
    const ydoc = docFrom(`${AS_THE_OLD_WRITER_LEFT_IT}\n## Next steps\n\n- book the room\n`);
    expect(legacyTranscriptSpan(prose.getProseFragment(ydoc))).toBeNull();
  });

  it('is null when a person has written anything else under the heading', () => {
    const ydoc = docFrom(`${AS_THE_OLD_WRITER_LEFT_IT}\nAnd this is the bit I want to quote.\n`);
    expect(legacyTranscriptSpan(prose.getProseFragment(ydoc))).toBeNull();
  });

  it('is null when there is no such section', () => {
    const ydoc = docFrom(`# Agenda\n\n## ${MEETING_NOTES_HEADING}\n\n- a point\n`);
    expect(legacyTranscriptSpan(prose.getProseFragment(ydoc))).toBeNull();
  });
});

describe('dropLegacyTranscriptSection', () => {
  it('removes the section the old writer left, and keeps everything above it', () => {
    const ydoc = docFrom(AS_THE_OLD_WRITER_LEFT_IT);
    expect(dropLegacyTranscriptSection(ydoc)).toBe('removed');
    const md = markdownOf(ydoc);
    expect(md).not.toContain(LEGACY_TRANSCRIPT_HEADING);
    expect(md).not.toContain('Sam: agreed');
    expect(md).toContain('# Interview prep');
    expect(md).toContain('- ask about latency');
  });

  it('keeps a transcript a person pasted into a doc in their working tree', () => {
    const ydoc = docFrom(A_PERSON_PASTED_IT);
    expect(
      dropLegacyTranscriptSection(ydoc, {
        boundPath: '/Users/someone/dev/project/interview-prep.md',
        dataDir: DATA_DIR,
      }),
    ).toBe('kept');
    expect(markdownOf(ydoc)).toContain('I pasted this myself from Otter and I need it.');
  });

  it('cannot tell a hand-pasted text fence in an UNBOUND doc from the writer’s', () => {
    // The residual this fingerprint does not close, asserted rather than left
    // to be discovered: in a doc the old writer could have written in, an H2
    // `Raw transcript` with one `text` fence at the tail is byte-identical to
    // its output whoever typed it, and goes. Every doc the writer could reach
    // is a huddle or meeting doc, and the fence's own words are the only
    // thing left to tell them apart — which is not something to key a delete
    // on. Anything else about the section saves it; the cases below are that.
    const ydoc = docFrom(A_PERSON_PASTED_IT);
    expect(dropLegacyTranscriptSection(ydoc)).toBe('removed');
  });

  it('keeps a json fence under that heading', () => {
    const json = A_PERSON_PASTED_IT.replace('```text', '```json');
    const ydoc = docFrom(json);
    expect(dropLegacyTranscriptSection(ydoc)).toBe('kept');
    expect(markdownOf(ydoc)).toBe(markdownOf(docFrom(json)));
  });

  it('keeps a nested subsection of a person’s own', () => {
    const nested = AS_THE_OLD_WRITER_LEFT_IT.replace(
      `## ${LEGACY_TRANSCRIPT_HEADING}`,
      `### ${LEGACY_TRANSCRIPT_HEADING}`,
    );
    const ydoc = docFrom(nested);
    expect(dropLegacyTranscriptSection(ydoc)).toBe('kept');
    expect(markdownOf(ydoc)).toBe(markdownOf(docFrom(nested)));
  });

  it('takes only the tail section when a doc carries two, and only that one', () => {
    const two = [
      '# Agenda',
      '',
      `## ${LEGACY_TRANSCRIPT_HEADING}`,
      '',
      '```text',
      'an earlier meeting said this',
      '```',
      '',
      '## A heading of my own',
      '',
      'something I typed.',
      '',
      `## ${LEGACY_TRANSCRIPT_HEADING}`,
      '',
      '```text',
      'and this meeting said this',
      '```',
      '',
    ].join('\n');
    const ydoc = docFrom(two);
    expect(dropLegacyTranscriptSection(ydoc)).toBe('removed');
    const once = markdownOf(ydoc);
    expect(once).not.toContain('and this meeting said this');
    expect(once).toContain('an earlier meeting said this');
    expect(once).toContain('something I typed.');
    // The earlier one is not at the tail, so a second pass takes nothing more.
    expect(dropLegacyTranscriptSection(ydoc)).toBe('kept');
    expect(markdownOf(ydoc)).toBe(once);
  });

  it('will not touch a doc bound outside the data dir, where the writer never wrote', () => {
    const ydoc = docFrom(AS_THE_OLD_WRITER_LEFT_IT);
    expect(
      dropLegacyTranscriptSection(ydoc, {
        boundPath: '/Users/someone/dev/project/interview-prep.md',
        dataDir: DATA_DIR,
      }),
    ).toBe('kept');
    expect(markdownOf(ydoc)).toContain('Sam: agreed');
  });

  it('does remove it from a doc bound under the data dir', () => {
    const ydoc = docFrom(AS_THE_OLD_WRITER_LEFT_IT);
    expect(
      dropLegacyTranscriptSection(ydoc, {
        boundPath: `${DATA_DIR}/docs/huddle.md`,
        dataDir: DATA_DIR,
      }),
    ).toBe('removed');
    expect(markdownOf(ydoc)).not.toContain('Sam: agreed');
  });

  it('does nothing at all to a doc that never had one', () => {
    const clean = `# Agenda\n\n## ${MEETING_NOTES_HEADING}\n\n- a point\n`;
    const ydoc = docFrom(clean);
    expect(dropLegacyTranscriptSection(ydoc)).toBe('absent');
    expect(markdownOf(ydoc)).toBe(markdownOf(docFrom(clean)));
  });
});

describe('across a scripted meeting', () => {
  it('writes the notes and never the words', async () => {
    const h = createNotesTickHarness({
      doc: '# Agenda\n\nSome intro.\n',
      compose: (_input, tick) =>
        `## ${MEETING_NOTES_HEADING}\n\n${['- measure first', '- ship on Friday']
          .slice(0, tick)
          .join('\n')}\n`,
    });

    for (const line of ['We should measure first.', 'Ship on Friday.']) {
      const shot = await h.speak(line);
      expect(shot.headings).not.toContain(LEGACY_TRANSCRIPT_HEADING);
      expect(shot.markdown).not.toContain(line);
    }
    expect(h.notes()).toContain('ship on Friday');
    expect(h.errors).toEqual([]);
    await h.end();
  });

  it('the next tick takes out a section the old release wrote', async () => {
    const h = createNotesTickHarness({
      doc: AS_THE_OLD_WRITER_LEFT_IT,
      compose: () => `## ${MEETING_NOTES_HEADING}\n\n- ship on Friday\n`,
    });
    const shot = await h.speak('Ship on Friday.');
    expect(shot.markdown).not.toContain(LEGACY_TRANSCRIPT_HEADING);
    expect(shot.markdown).not.toContain('Sam: agreed');
    // The notes it was written under are untouched, old points and new.
    expect(shot.notes).toContain('ask about latency');
    expect(shot.notes).toContain('ship on Friday');
    expect(h.errors).toEqual([]);
    await h.end();
  });

  it("a person's own pasted transcript survives the tick", async () => {
    const h = createNotesTickHarness({
      doc: A_PERSON_PASTED_IT,
      boundPath: '/Users/someone/dev/project/interview-prep.md',
      dataDir: DATA_DIR,
      compose: () => `## ${MEETING_NOTES_HEADING}\n\n- ship on Friday\n`,
    });
    const shot = await h.speak('Ship on Friday.');
    expect(shot.markdown).toContain(LEGACY_TRANSCRIPT_HEADING);
    expect(shot.markdown).toContain('I pasted this myself from Otter and I need it.');
    expect(h.errors).toEqual([]);
    await h.end();
  });

  it('a json fence under that heading survives the tick in a huddle doc', async () => {
    const h = createNotesTickHarness({
      doc: A_PERSON_PASTED_IT.replace('```text', '```json'),
      compose: () => `## ${MEETING_NOTES_HEADING}\n\n- ship on Friday\n`,
    });
    const shot = await h.speak('Ship on Friday.');
    expect(shot.markdown).toContain(LEGACY_TRANSCRIPT_HEADING);
    expect(shot.markdown).toContain('I pasted this myself from Otter and I need it.');
    expect(h.errors).toEqual([]);
    await h.end();
  });

  it('a doc bound into a working tree keeps its section through a meeting', async () => {
    const h = createNotesTickHarness({
      doc: AS_THE_OLD_WRITER_LEFT_IT,
      boundPath: '/Users/someone/dev/project/interview-prep.md',
      dataDir: DATA_DIR,
      compose: () => `## ${MEETING_NOTES_HEADING}\n\n- ship on Friday\n`,
    });
    const shot = await h.speak('Ship on Friday.');
    expect(shot.markdown).toContain('Sam: agreed');
    expect(h.errors).toEqual([]);
    await h.end();
  });
});

describe('the kept section is reported once per doc', () => {
  it('says so on the first tick and stays quiet on every tick after', () => {
    const ydoc = docFrom(A_PERSON_PASTED_IT.replace('```text', '```json'));
    const docStore = {
      get: (id: string) =>
        id === 'd-quiet' ? { ydoc, meta: { type: 'markdown' as const } } : undefined,
    };
    const update = {
      docId: 'd-quiet',
      meetingId: 'm1',
      notes: `## ${MEETING_NOTES_HEADING}\n\n- a point\n`,
      tick: { tick: 1, reason: 'pause' as const, turns: [] },
    };
    const said: string[] = [];
    const real = console.log;
    console.log = (...args: unknown[]) => {
      said.push(args.map(String).join(' '));
    };
    try {
      const ledger = createNotesLedger();
      for (let i = 0; i < 3; i++) applyNotesUpdate(docStore, update as never, ledger);
    } finally {
      console.log = real;
    }
    expect(said.filter((line) => line.includes('d-quiet'))).toHaveLength(1);
    // And the section is still there after all three.
    expect(markdownOf(ydoc)).toContain('I pasted this myself from Otter and I need it.');
  });
});

describe("a person's own writing below the notes", () => {
  it('an unheaded paragraph typed at the doc tail is neither moved nor deleted', async () => {
    const h = createNotesTickHarness({
      doc: '# Agenda\n',
      compose: (_i, tick) =>
        `## ${MEETING_NOTES_HEADING}\n\n- point one\n${tick > 1 ? '- point two\n' : ''}`,
    });
    await h.speak('Point one.');

    // The person reads the notes and types a line under them — no heading of
    // their own, just a paragraph at the end of the doc.
    const mine = 'I disagree with this one and here is why.';
    const fragment = prose.getProseFragment(h.ydoc);
    fragment.insert(fragment.length, prose.parseMarkdownBlocks(mine));

    const second = await h.speak('Point two.');
    // Present once, unchanged, and in the place they put it: still under the
    // notes heading and still after the bullet it answers. The tick's own new
    // bullet lands after it rather than lifting it anywhere.
    expect(second.markdown.split(mine)).toHaveLength(2);
    expect(second.markdown.indexOf(mine)).toBeGreaterThan(second.markdown.indexOf('- point one'));
    expect(second.notes).toContain('point two');

    // And a third tick does not reclaim it either: the ledger never claimed
    // it, so the merge has no licence to replace or drop it.
    const third = await h.speak('Point three.');
    expect(third.markdown.split(mine)).toHaveLength(2);
    expect(h.errors).toEqual([]);
    await h.end();
  });
});
