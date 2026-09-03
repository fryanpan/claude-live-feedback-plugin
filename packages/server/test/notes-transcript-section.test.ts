/**
 * The meeting's own words, in one section, under everything else.
 *
 * The invariant worth a suite of its own is a statement about a SEQUENCE: the
 * raw transcript is the doc's last section after every tick, it holds every
 * settled turn in the order it was said, and the notes are above it. Nothing
 * else the meeting writes — the notes' first section, a research placeholder —
 * may land below it.
 *
 * All fixtures are synthetic. The repo is public.
 */

import { describe, expect, it } from 'bun:test';
import { prose } from '@feedback/core';
import * as Y from 'yjs';
import { applyNotesTranscript } from '../src/meeting-notes-doc.ts';
import { MEETING_NOTES_HEADING, TRANSCRIPT_HEADING } from '../src/notes-section.ts';
import {
  TRANSCRIPT_LANGUAGE,
  appendTranscriptTurns,
  relabelTranscriptSection,
  transcriptAllowedIn,
  transcriptLine,
} from '../src/notes-transcript-section.ts';
import { createNotesTickHarness } from './notes-tick-harness.ts';

function docFrom(markdown: string): Y.Doc {
  const ydoc = new Y.Doc();
  prose.applyMarkdownToFragment(prose.getProseFragment(ydoc), markdown);
  return ydoc;
}

function markdownOf(ydoc: Y.Doc): string {
  return prose.serializeFragmentToMarkdown(prose.getProseFragment(ydoc));
}

describe('transcriptLine', () => {
  it('names the speaker when there is one, and folds a wrapped turn onto one line', () => {
    expect(transcriptLine({ speaker: 'Devi', text: 'we should\nmeasure first' })).toBe(
      'Devi: we should measure first',
    );
    expect(transcriptLine({ text: 'agreed' })).toBe('agreed');
  });

  it('cannot close the fence it is written inside', () => {
    const line = transcriptLine({ text: 'and then I typed ``` into the chat' });
    expect(line).not.toContain('```');
    expect(line).toContain('into the chat');
  });
});

describe('appendTranscriptTurns', () => {
  it('creates the section at the end of the doc, as one fenced block', () => {
    const ydoc = docFrom('# Agenda\n\nIntro.\n');
    const res = appendTranscriptTurns(ydoc, [{ text: 'we should measure first' }]);
    expect(res.mode).toBe('created');
    expect(res.appended).toBe(1);
    const md = markdownOf(ydoc);
    expect(md).toContain(`## ${TRANSCRIPT_HEADING}`);
    expect(md).toContain(`\`\`\`${TRANSCRIPT_LANGUAGE}`);
    expect(md.indexOf(TRANSCRIPT_HEADING)).toBeGreaterThan(md.indexOf('Intro.'));
  });

  it('extends the same block rather than laying a second section', () => {
    const ydoc = docFrom('# Agenda\n');
    appendTranscriptTurns(ydoc, [{ speaker: 'Devi', text: 'one' }]);
    const second = appendTranscriptTurns(ydoc, [{ speaker: 'Sam', text: 'two' }]);
    expect(second.mode).toBe('extended');
    const md = markdownOf(ydoc);
    expect(md.match(new RegExp(`^## ${TRANSCRIPT_HEADING}$`, 'gm'))).toHaveLength(1);
    expect(md).toContain('Devi: one\nSam: two');
  });

  it('lifts itself back to the end when something lands below it', () => {
    const ydoc = docFrom('# Agenda\n');
    appendTranscriptTurns(ydoc, [{ text: 'one' }]);
    const fragment = prose.getProseFragment(ydoc);
    fragment.insert(fragment.length, prose.parseMarkdownBlocks('## Somebody else\n\nwrote this'));
    const res = appendTranscriptTurns(ydoc, [{ text: 'two' }]);
    expect(res.moved).toBe(true);
    const md = markdownOf(ydoc);
    expect(md.indexOf('Somebody else')).toBeLessThan(md.indexOf(TRANSCRIPT_HEADING));
    // Nothing said before the move was lost.
    expect(md).toContain('one\ntwo');
    expect(md.match(new RegExp(`^## ${TRANSCRIPT_HEADING}$`, 'gm'))).toHaveLength(1);
  });

  it('rebuilds the block when a person deleted it and kept the heading', () => {
    const ydoc = docFrom(`# Agenda\n\n## ${TRANSCRIPT_HEADING}\n`);
    const res = appendTranscriptTurns(ydoc, [{ text: 'first thing said' }]);
    expect(res.ok).toBe(true);
    expect(markdownOf(ydoc)).toContain('first thing said');
  });

  it('a tick with nothing settled writes nothing at all', () => {
    const ydoc = docFrom('# Agenda\n');
    const res = appendTranscriptTurns(ydoc, []);
    expect(res.appended).toBe(0);
    expect(markdownOf(ydoc)).not.toContain(TRANSCRIPT_HEADING);
  });

  it('survives the markdown round trip a bound doc makes on every flush', () => {
    const ydoc = docFrom('# Agenda\n');
    appendTranscriptTurns(ydoc, [
      { speaker: 'Devi', text: 'we should measure first' },
      { speaker: 'Sam', text: 'agreed' },
    ]);
    const round = docFrom(markdownOf(ydoc));
    const res = appendTranscriptTurns(round, [{ speaker: 'Devi', text: 'ship on Friday' }]);
    expect(res.mode).toBe('extended');
    expect(markdownOf(round)).toContain(
      'Devi: we should measure first\nSam: agreed\nDevi: ship on Friday',
    );
  });
});

describe('relabelTranscriptSection', () => {
  it('carries a rename into every line already recorded', () => {
    const ydoc = docFrom('# Agenda\n');
    appendTranscriptTurns(ydoc, [
      { speaker: 'Speaker A', text: 'we should measure first' },
      { speaker: 'Speaker B', text: 'agreed' },
      { speaker: 'Speaker A', text: 'I will own it' },
    ]);
    expect(relabelTranscriptSection(ydoc, 'Speaker A', 'Dana').replaced).toBe(2);
    const md = markdownOf(ydoc);
    expect(md).not.toContain('Speaker A');
    expect(md).toContain('Dana: we should measure first');
    expect(md).toContain('Dana: I will own it');
    // Only that voice moved.
    expect(md).toContain('Speaker B: agreed');
  });

  it('renames on word boundaries, so a label is not a prefix of its neighbour', () => {
    const ydoc = docFrom('# Agenda\n');
    appendTranscriptTurns(ydoc, [
      { speaker: 'Speaker A', text: 'mine' },
      { speaker: 'Speaker AB', text: 'not mine' },
    ]);
    relabelTranscriptSection(ydoc, 'Speaker A', 'Dana');
    const md = markdownOf(ydoc);
    expect(md).toContain('Dana: mine');
    expect(md).toContain('Speaker AB: not mine');
  });

  it('is a no-op when there is no record, or nothing to change', () => {
    const bare = docFrom('# Agenda\n');
    expect(relabelTranscriptSection(bare, 'Speaker A', 'Dana').replaced).toBe(0);
    const ydoc = docFrom('# Agenda\n');
    appendTranscriptTurns(ydoc, [{ speaker: 'Speaker B', text: 'agreed' }]);
    const before = markdownOf(ydoc);
    expect(relabelTranscriptSection(ydoc, 'Speaker A', 'Dana').replaced).toBe(0);
    expect(relabelTranscriptSection(ydoc, 'Dana', 'Dana').replaced).toBe(0);
    expect(markdownOf(ydoc)).toBe(before);
  });
});

describe('applyNotesTranscript', () => {
  const room = (ydoc: Y.Doc, type: 'markdown' | 'diff' = 'markdown') => ({
    get: (id: string) => (id === 'd1' ? { ydoc, meta: { type } } : undefined),
  });

  it('writes prose docs and reports true', () => {
    const ydoc = docFrom('# A\n');
    expect(applyNotesTranscript(room(ydoc), { docId: 'd1', lines: [{ text: 'hello' }] })).toBe(
      true,
    );
    expect(markdownOf(ydoc)).toContain('hello');
  });

  it('a flat doc and a gone doc are both false, never a throw', () => {
    const ydoc = docFrom('# A\n');
    expect(
      applyNotesTranscript(room(ydoc, 'diff'), { docId: 'd1', lines: [{ text: 'hello' }] }),
    ).toBe(false);
    expect(applyNotesTranscript(room(ydoc), { docId: 'nope', lines: [{ text: 'x' }] })).toBe(false);
  });
});

describe('where the doc lives decides whether it holds spoken words', () => {
  const dataDir = '/srv/claude-workspaces/data';

  it('says yes to an unbound doc and to one bound under the data dir', () => {
    expect(transcriptAllowedIn(undefined, dataDir)).toBe(true);
    expect(transcriptAllowedIn(`${dataDir}/docs/huddle-2026-09-03.md`, dataDir)).toBe(true);
    // A trailing separator on either side is the same directory.
    expect(transcriptAllowedIn(`${dataDir}/notes.md`, `${dataDir}/`)).toBe(true);
  });

  it('says no to a repo file, including one whose path merely starts the same way', () => {
    expect(transcriptAllowedIn('/Users/someone/dev/project/docs/plan.md', dataDir)).toBe(false);
    // `/srv/claude-workspaces/data-old` is not inside `/srv/claude-workspaces/data`.
    expect(transcriptAllowedIn('/srv/claude-workspaces/data-old/notes.md', dataDir)).toBe(false);
  });

  it('says no when it cannot see the data dir at all', () => {
    // Unknown means no: a bound doc this cannot place could be anywhere, and
    // words written into a working tree cannot be taken back.
    expect(transcriptAllowedIn('/anywhere/notes.md', undefined)).toBe(false);
    // An unbound doc is still fine — there is no file to be wrong about.
    expect(transcriptAllowedIn(undefined, undefined)).toBe(true);
  });

  it('a doc bound to a repo file gets its notes and no record, and no error', async () => {
    const h = createNotesTickHarness({
      doc: '# Plan\n',
      dataDir: '/srv/claude-workspaces/data',
      boundPath: '/Users/someone/dev/project/docs/plan.md',
      compose: () => '## Meeting notes\n\n- measure first\n',
    });
    const shot = await h.speak('We should measure first.');
    expect(shot.markdown).not.toContain(TRANSCRIPT_HEADING);
    expect(shot.markdown).not.toContain('We should measure first.');
    // The notes still land. Refusing the record is a placement rule, not a
    // failure of the meeting.
    expect(h.notes()).toContain('measure first');
    expect(h.errors).toEqual([]);
    await h.end();
  });

  it('a doc under the data dir gets both', async () => {
    const h = createNotesTickHarness({
      doc: '# Huddle\n',
      dataDir: '/srv/claude-workspaces/data',
      boundPath: '/srv/claude-workspaces/data/docs/huddle.md',
      compose: () => '## Meeting notes\n\n- measure first\n',
    });
    const shot = await h.speak('We should measure first.');
    expect(shot.markdown).toContain(TRANSCRIPT_HEADING);
    expect(h.transcript()).toBe('We should measure first.');
    expect(h.notes()).toContain('measure first');
    expect(h.errors).toEqual([]);
    await h.end();
  });
});

describe('across three ticks of a scripted meeting', () => {
  it('the transcript is the last section every time, with the notes above it', async () => {
    const h = createNotesTickHarness({
      doc: '# Agenda\n\nSome intro.\n',
      compose: (_input, tick) =>
        `## Meeting notes\n\n${['- measure first', '- Devi owns the rollout', '- ship on Friday']
          .slice(0, tick)
          .join('\n')}\n`,
    });

    const said = ['We should measure first.', 'Devi owns the rollout.', 'Ship on Friday.'];
    for (const line of said) {
      const shot = await h.speak(line);
      expect(shot.headings.at(-1)).toBe(TRANSCRIPT_HEADING);
      expect(shot.headings.indexOf(MEETING_NOTES_HEADING)).toBeLessThan(
        shot.headings.indexOf(TRANSCRIPT_HEADING),
      );
      expect(shot.headings.filter((t) => t === TRANSCRIPT_HEADING)).toHaveLength(1);
    }

    // Every line, in the order it was said.
    expect(h.transcript()).toBe(said.join('\n'));
    expect(h.notes()).toContain('ship on Friday');
    expect(h.errors).toEqual([]);
    await h.end();
  });

  it('a failed compose still leaves the words in the record', async () => {
    const h = createNotesTickHarness({
      doc: '# Agenda\n',
      compose: (_input, tick) => {
        if (tick === 1) throw new Error('the model refused');
        return '## Meeting notes\n\n- measure first\n';
      },
    });
    await h.speak('We should measure first.');
    expect(h.transcript()).toBe('We should measure first.');
    // And the carried words are not written to the record a second time when
    // the retry succeeds: the record follows the tick's delta, not the
    // compose's input.
    await h.speak('Ship on Friday.');
    expect(h.transcript()).toBe('We should measure first.\nShip on Friday.');
    await h.end();
  });

  it('names the voices only once a second one has been heard', async () => {
    const h = createNotesTickHarness({
      doc: '# Agenda\n',
      compose: () => '## Meeting notes\n\n- a point\n',
    });
    await h.speak({ speaker: 'A', text: 'Just me here.' });
    expect(h.transcript()).toBe('Just me here.');
    await h.speak({ speaker: 'B', text: 'Not any more.' });
    expect(h.transcript()).toContain('Speaker B: Not any more.');
    await h.end();
  });
});
