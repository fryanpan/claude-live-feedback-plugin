/**
 * The transcript stays in the sister file, and comes back out of the doc.
 *
 * Two statements, and the second is why this file exists at all. A notes tick
 * writes NO verbatim record into the doc (owner, 2026-09-03). And a doc that
 * received one from the release that did gets it removed by the next tick,
 * but only while the section is still exactly what that writer left — the
 * moment somebody has written in it, it is theirs and it stays.
 *
 * All fixtures are synthetic. The repo is public.
 */

import { describe, expect, it } from 'bun:test';
import { prose } from '@feedback/core';
import * as Y from 'yjs';
import {
  dropLegacyTranscriptSection,
  legacyTranscriptSpan,
} from '../src/notes-legacy-transcript.ts';
import { LEGACY_TRANSCRIPT_HEADING, MEETING_NOTES_HEADING } from '../src/notes-section.ts';
import { createNotesTickHarness } from './notes-tick-harness.ts';

function docFrom(markdown: string): Y.Doc {
  const ydoc = new Y.Doc();
  prose.applyMarkdownToFragment(prose.getProseFragment(ydoc), markdown);
  return ydoc;
}

function markdownOf(ydoc: Y.Doc): string {
  return prose.serializeFragmentToMarkdown(prose.getProseFragment(ydoc));
}

/** A doc as the old writer left it: notes, then the heading, then one fence. */
const AS_THE_OLD_WRITER_LEFT_IT = [
  '# Agenda',
  '',
  `## ${MEETING_NOTES_HEADING}`,
  '',
  '- we should measure first',
  '',
  `## ${LEGACY_TRANSCRIPT_HEADING}`,
  '',
  '```text',
  'Devi: we should measure first',
  'Sam: agreed',
  '```',
  '',
].join('\n');

describe('legacyTranscriptSpan', () => {
  it('names the heading and its one fence, and nothing around them', () => {
    const ydoc = docFrom(AS_THE_OLD_WRITER_LEFT_IT);
    const fragment = prose.getProseFragment(ydoc);
    const span = legacyTranscriptSpan(fragment);
    if (!span) throw new Error('expected a legacy transcript span');
    // The heading and the fence, and the doc's tail is where they end.
    expect(span.endExclusive).toBe(fragment.length);
    expect(span.endExclusive - span.start).toBe(2);
  });

  it('is null when a person has written anything else under the heading', () => {
    const ydoc = docFrom(
      `${AS_THE_OLD_WRITER_LEFT_IT}\nAnd this is the bit I want to quote later.\n`,
    );
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
    expect(md).toContain('# Agenda');
    expect(md).toContain(`## ${MEETING_NOTES_HEADING}`);
    expect(md).toContain('- we should measure first');
  });

  it('leaves a section somebody has written in, and says so', () => {
    const written = `${AS_THE_OLD_WRITER_LEFT_IT}\nSam's line here is the one to quote.\n`;
    const ydoc = docFrom(written);
    expect(dropLegacyTranscriptSection(ydoc)).toBe('kept');
    expect(markdownOf(ydoc)).toBe(markdownOf(docFrom(written)));
  });

  it('a heading with nothing under it is not the shape, so it stays', () => {
    const ydoc = docFrom(`# Agenda\n\n## ${LEGACY_TRANSCRIPT_HEADING}\n`);
    expect(dropLegacyTranscriptSection(ydoc)).toBe('kept');
    expect(markdownOf(ydoc)).toContain(LEGACY_TRANSCRIPT_HEADING);
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
    expect(shot.notes).toContain('we should measure first');
    expect(shot.notes).toContain('ship on Friday');
    expect(h.errors).toEqual([]);
    await h.end();
  });

  it('a section somebody has written in survives the tick', async () => {
    const h = createNotesTickHarness({
      doc: `${AS_THE_OLD_WRITER_LEFT_IT}\nThis line is mine and I want it kept.\n`,
      compose: () => `## ${MEETING_NOTES_HEADING}\n\n- ship on Friday\n`,
    });
    const shot = await h.speak('Ship on Friday.');
    expect(shot.markdown).toContain(LEGACY_TRANSCRIPT_HEADING);
    expect(shot.markdown).toContain('This line is mine and I want it kept.');
    expect(h.errors).toEqual([]);
    await h.end();
  });
});
