/**
 * One notes section, ever — and the raw transcript under it.
 *
 * THE BUG THIS PINS. A tick used to accept its section only while that
 * section was the doc's TAIL. Everything the product itself appends to a
 * meeting doc therefore split the notes in two: press Research on a note (or
 * say "can you research that" and let the capture pass file it) and
 * `## Research: …` lands at the end of the doc, the notes stop being the tail,
 * and the next tick appends a second "Meeting notes" below the placeholder.
 * Two presses left three sections and the meeting's points scattered across
 * them. A model that echoed its own heading in the body did it a second way:
 * the demotion turned the copy into `### Meeting notes`, which the finder read
 * as the section.
 *
 * Both are asserted here through the scripted-tick harness, which is what
 * makes them statements about a SEQUENCE rather than about one write.
 *
 * All fixtures are synthetic. The repo is public.
 */

import { describe, expect, it } from 'bun:test';
import { prose } from '@feedback/core';
import * as Y from 'yjs';
import { createNotesLedger } from '../src/meeting-notes-doc.ts';
import { mergeNotesSection } from '../src/meeting-notes-merge.ts';
import { appendResearchPlaceholder } from '../src/notes-section-write.ts';
import {
  MEETING_NOTES_HEADING,
  MEETING_NOTES_HEADINGS,
  TRANSCRIPT_HEADING,
  findNotesSection,
  sectionInsertIndex,
  stripSectionHeading,
} from '../src/notes-section.ts';
import { createNotesTickHarness } from './notes-tick-harness.ts';

/** The research placeholder a Research press leaves in a doc, written the way
 *  the pointer pill writes it — a level-2 heading, appended. */
function pressResearch(ydoc: Y.Doc, topic: string): void {
  const fragment = prose.getProseFragment(ydoc);
  fragment.insert(
    sectionInsertIndex(fragment),
    prose.parseMarkdownBlocks(`## Research: ${topic}\n\nResearching — in progress.`),
  );
}

describe('the notes tick keeps one section', () => {
  it('a research placeholder between two ticks does not split the notes', async () => {
    const h = createNotesTickHarness({
      doc: '# Agenda\n\nSome intro.\n',
      compose: (_input, tick) =>
        `## Meeting notes\n\n${[
          '- we should measure first',
          '- Devi owns the rollout',
          '- ship on Friday',
        ]
          .slice(0, tick)
          .join('\n')}\n`,
    });

    await h.speak('We should measure first.');
    expect(h.countHeadings(MEETING_NOTES_HEADING)).toBe(1);

    // The person opens the doc and presses Research on a note.
    pressResearch(h.ydoc, 'pricing');

    const second = await h.speak('Devi owns the rollout.');
    expect(h.countHeadings(MEETING_NOTES_HEADING)).toBe(1);
    expect(second.notes).toContain('we should measure first');
    expect(second.notes).toContain('Devi owns the rollout');

    // A second press, a third tick: still one section, still every point.
    pressResearch(h.ydoc, 'hosting');
    const third = await h.speak('Ship on Friday.');
    expect(h.countHeadings(MEETING_NOTES_HEADING)).toBe(1);
    expect(third.notes).toContain('we should measure first');
    expect(third.notes).toContain('ship on Friday');
    expect(h.errors).toEqual([]);
    await h.end();
  });

  it('a spoken research ask writes its placeholder above the transcript', async () => {
    const h = createNotesTickHarness({
      doc: '# Agenda\n',
      compose: () => '## Meeting notes\n\n- we should measure first\n',
    });
    await h.speak('We should measure first.');
    const res = appendResearchPlaceholder(h.ydoc, 'Research the pricing', 'http://example/task/1');
    expect(res).toEqual({ ok: true, mode: 'appended' });
    expect(h.headings().at(-1)).toBe(TRANSCRIPT_HEADING);
    await h.end();
  });

  it('the composer echoing its own heading leaves one heading, not two', async () => {
    const h = createNotesTickHarness({
      doc: '# Agenda\n',
      compose: () =>
        '## Meeting notes\n\n- we should measure first\n\n## Meeting notes\n\n- ship on Friday\n',
    });
    const shot = await h.speak('We should measure first. Ship on Friday.');
    expect(h.countHeadings(MEETING_NOTES_HEADING)).toBe(1);
    // The demoted copy is gone too: no heading anywhere reads as the section.
    expect(shot.headings.filter((t) => t === MEETING_NOTES_HEADING)).toHaveLength(1);
    expect(shot.notes).toContain('we should measure first');
    expect(shot.notes).toContain('ship on Friday');
    await h.end();
  });

  it("a person's own heading below the notes no longer starts a rival section", async () => {
    const h = createNotesTickHarness({
      doc: '# Agenda\n',
      compose: (_i, tick) => `## Meeting notes\n\n- point one\n${tick > 1 ? '- point two\n' : ''}`,
    });
    await h.speak('Point one.');
    const fragment = prose.getProseFragment(h.ydoc);
    fragment.insert(
      sectionInsertIndex(fragment),
      prose.parseMarkdownBlocks('## My own thoughts\n\nSomething I typed.'),
    );
    const second = await h.speak('Point two.');
    expect(h.countHeadings(MEETING_NOTES_HEADING)).toBe(1);
    expect(second.notes).toContain('point two');
    expect(second.markdown).toContain('Something I typed.');
    await h.end();
  });
});

describe('the section is found under any heading it has been written under', () => {
  it('an alias identifies the section, and the canonical one is what gets written', () => {
    const ydoc = new Y.Doc();
    prose.applyMarkdownToFragment(
      prose.getProseFragment(ydoc),
      '# Agenda\n\n## Live notes\n\n- an older release wrote this\n',
    );
    const ledger = createNotesLedger();
    const res = mergeNotesSection(
      ydoc,
      '## Meeting notes\n\n- and this one adds a point\n',
      [MEETING_NOTES_HEADING, 'Live notes'],
      { ownership: ledger.forDoc('d') },
    );
    expect(res.mode).toBe('merged');
    const md = prose.serializeFragmentToMarkdown(prose.getProseFragment(ydoc));
    expect(md).toContain('an older release wrote this');
    expect(md).toContain('and this one adds a point');
    // No second section: the old heading stayed, nothing new was appended.
    expect(md).not.toContain('## Meeting notes');
    expect(md.match(/^## Live notes$/gm)).toHaveLength(1);
  });

  it('the shipped list has the canonical heading first', () => {
    expect(MEETING_NOTES_HEADINGS[0]).toBe(MEETING_NOTES_HEADING);
    expect(MEETING_NOTES_HEADINGS).toContain(MEETING_NOTES_HEADING);
  });
});

describe('stripSectionHeading', () => {
  it('drops every copy of the section heading, at any level', () => {
    const out = stripSectionHeading(
      '## Meeting notes\n\n- one\n\n## Meeting notes\n\n- two\n\n#### Meeting notes\n\n- three\n',
      MEETING_NOTES_HEADINGS,
    );
    expect(out).not.toContain('Meeting notes');
    expect(out).toContain('- one');
    expect(out).toContain('- two');
    expect(out).toContain('- three');
  });

  it('still demotes a level 1-2 heading that is not the section heading', () => {
    const out = stripSectionHeading(
      '## Meeting notes\n\n## Decisions\n\n- ship it\n',
      'Meeting notes',
    );
    expect(out).toContain('### Decisions');
    expect(out.match(/^#+ Decisions$/gm)).toEqual(['### Decisions']);
  });

  it('leaves heading-shaped lines inside a fence alone', () => {
    const out = stripSectionHeading(
      '## Meeting notes\n\n```sh\n## Meeting notes\n```\n',
      MEETING_NOTES_HEADINGS,
    );
    expect(out).toContain('## Meeting notes\n```');
  });
});

describe('sectionInsertIndex', () => {
  it('is the end of the doc when there is no transcript', () => {
    const ydoc = new Y.Doc();
    prose.applyMarkdownToFragment(prose.getProseFragment(ydoc), '# A\n\nb\n');
    const fragment = prose.getProseFragment(ydoc);
    expect(sectionInsertIndex(fragment)).toBe(fragment.length);
  });

  it('is the transcript heading when there is one', () => {
    const ydoc = new Y.Doc();
    prose.applyMarkdownToFragment(
      prose.getProseFragment(ydoc),
      '# A\n\nb\n\n## Raw transcript\n\n```text\nsomebody: hello\n```\n',
    );
    const fragment = prose.getProseFragment(ydoc);
    const span = findNotesSection(fragment, TRANSCRIPT_HEADING);
    expect(span).not.toBeNull();
    expect(sectionInsertIndex(fragment)).toBe(span!.start);
  });
});
