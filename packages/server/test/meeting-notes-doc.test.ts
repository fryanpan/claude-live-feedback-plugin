/**
 * Where composed notes LAND: the named section inside the meeting doc,
 * written through the Yjs fragment — never the filesystem — plus the
 * server-side sink that joins the composer output to the doc and the
 * project context to the composer input.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { describe, expect, it } from 'bun:test';
import { type DocType, prose } from '@feedback/core';
import * as Y from 'yjs';
import {
  MEETING_NOTES_HEADING,
  applyNotesRelabel,
  applyNotesUpdate,
  createNotesLedger,
  relabelNotesSection,
  replaceNotesSection,
  retagSpeakerInNotes,
  withServerNotesSinks,
} from '../src/meeting-notes-doc.ts';
import type { NotesRelabel, NotesUpdate } from '../src/meeting-notes.ts';

function docFrom(markdown: string): Y.Doc {
  const ydoc = new Y.Doc();
  prose.applyMarkdownToFragment(prose.getProseFragment(ydoc), markdown);
  return ydoc;
}

function markdownOf(ydoc: Y.Doc): string {
  return prose.serializeFragmentToMarkdown(prose.getProseFragment(ydoc));
}

describe('replaceNotesSection', () => {
  it('appends the section at the end when the doc has none', () => {
    const ydoc = docFrom('# Agenda\n\nSome intro.\n');
    const res = replaceNotesSection(ydoc, '## Meeting notes\n\n- first point\n');
    expect(res).toEqual({ ok: true, mode: 'appended' });
    const md = markdownOf(ydoc);
    expect(md).toContain('Some intro.');
    expect(md.indexOf('## Meeting notes')).toBeGreaterThan(md.indexOf('Some intro.'));
    expect(md).toContain('- first point');
  });

  it('replaces the whole section in place, leaving neighbours untouched', () => {
    const ydoc = docFrom(
      '# Agenda\n\n## Meeting notes\n\n- old point\n\nold paragraph\n\n## Next steps\n\n- later\n',
    );
    const res = replaceNotesSection(ydoc, '## Meeting notes\n\n- revised point\n');
    expect(res).toEqual({ ok: true, mode: 'replaced' });
    const md = markdownOf(ydoc);
    expect(md).not.toContain('old point');
    expect(md).not.toContain('old paragraph');
    expect(md).toContain('- revised point');
    expect(md).toContain('# Agenda');
    expect(md).toContain('## Next steps');
    expect(md).toContain('- later');
    expect(md.split(MEETING_NOTES_HEADING).length).toBe(2); // exactly one heading
  });

  it('a payload without the heading still lands under it, and stays replaceable', () => {
    const ydoc = docFrom('# Agenda\n');
    expect(replaceNotesSection(ydoc, '- bare bullet').ok).toBe(true);
    expect(replaceNotesSection(ydoc, '- second write').mode).toBe('replaced');
    const md = markdownOf(ydoc);
    expect(md.split(MEETING_NOTES_HEADING).length).toBe(2);
    expect(md).not.toContain('bare bullet');
    expect(md).toContain('- second write');
  });

  it('a payload with its own level-2 headings still replaces cleanly next write', () => {
    // The replace span runs heading-to-next-heading at the same level, so a
    // body heading at the section's own level would end the span early and
    // every later write would leave the previous body behind, duplicating
    // the notes once per pause for the length of the meeting.
    const ydoc = docFrom('# Agenda\n\n## Next steps\n\n- later\n');
    const v1 = '## Meeting notes\n\n## Decisions\n\n- ship it\n';
    const v2 = '## Meeting notes\n\n## Decisions\n\n- ship it\n- measure it\n';
    expect(replaceNotesSection(ydoc, v1).ok).toBe(true);
    expect(replaceNotesSection(ydoc, v2).mode).toBe('replaced');
    const md = markdownOf(ydoc);
    expect(md.split('- ship it').length).toBe(2); // exactly once
    expect(md).toContain('- measure it');
    // The body heading survives as structure, demoted below the section
    // heading so it can never terminate the section's own replace span.
    expect(md).toContain('### Decisions');
    expect(md).not.toContain('\n## Decisions');
    // Neighbours untouched.
    expect(md).toContain('## Next steps');
    expect(md).toContain('- later');
  });

  it('refuses an empty payload — blank notes never erase a section', () => {
    const ydoc = docFrom('# Agenda\n\n## Meeting notes\n\n- keep me\n');
    expect(replaceNotesSection(ydoc, '   \n').ok).toBe(false);
    expect(markdownOf(ydoc)).toContain('- keep me');
  });
});

const update = (docId: string, notes: string): NotesUpdate => ({
  docId,
  meetingId: `m-${docId}-1`,
  tick: { tick: 1, reason: 'pause', turns: [{ turn: 0, text: 'hi' }] },
  notes,
});

describe('applyNotesUpdate', () => {
  const roomsWith = (docId: string, type: DocType, markdown = '# Doc\n') => {
    const ydoc = docFrom(markdown);
    return {
      rooms: { get: (id: string) => (id === docId ? { ydoc, meta: { type } } : undefined) },
      ydoc,
    };
  };

  it('writes prose docs and reports true', () => {
    const { rooms, ydoc } = roomsWith('doc-a', 'markdown');
    expect(applyNotesUpdate(rooms, update('doc-a', '- noted'), createNotesLedger())).toBe(true);
    expect(markdownOf(ydoc)).toContain('- noted');
  });

  it('refuses flat docs — a diff surface is not a notepad', () => {
    const { rooms, ydoc } = roomsWith('doc-a', 'diff');
    expect(applyNotesUpdate(rooms, update('doc-a', '- noted'), createNotesLedger())).toBe(false);
    expect(markdownOf(ydoc)).not.toContain('- noted');
  });

  it('an unknown doc is a false, never a throw', () => {
    const { rooms } = roomsWith('doc-a', 'markdown');
    expect(applyNotesUpdate(rooms, update('doc-gone', '- noted'), createNotesLedger())).toBe(false);
  });
});

describe('relabelNotesSection', () => {
  it('renames every mention in the notes, and only inside the section', () => {
    // The word the rename must NOT touch appears three times outside the
    // section: above it, below it, and inside a heading. Without the scope
    // this test reads them all as mentions.
    const ydoc = docFrom(
      [
        '# Agenda',
        '',
        'Speaker B is who I keep meaning to ask about the roadmap.',
        '',
        '## Meeting notes',
        '',
        '- Speaker B: ships the parser Thursday.',
        '- Rin agreed; Speaker B will send the branch.',
        '',
        '## Speaker B, my own heading',
        '',
        'Speaker B again, still my own writing.',
        '',
      ].join('\n'),
    );
    const res = relabelNotesSection(ydoc, 'Speaker B', 'Marisol');
    expect(res.replaced).toBe(2);
    const md = markdownOf(ydoc);
    expect(md).toContain('- Marisol: ships the parser Thursday.');
    expect(md).toContain('- Rin agreed; Marisol will send the branch.');
    // Every mention outside the section survives verbatim.
    expect(md).toContain('Speaker B is who I keep meaning to ask about the roadmap.');
    expect(md).toContain('## Speaker B, my own heading');
    expect(md).toContain('Speaker B again, still my own writing.');
  });

  it("leaves the human's own sentence inside the section intact apart from the name", () => {
    // The rename must not re-compose the section: everything the person
    // typed into it since the last tick is still there afterwards.
    const ydoc = docFrom(
      [
        '## Meeting notes',
        '',
        '- Speaker A: wants the migration split in two.',
        '',
        'MY NOTE: check whether Speaker A already has the ticket. Ask before standup.',
        '',
      ].join('\n'),
    );
    expect(relabelNotesSection(ydoc, 'Speaker A', 'Priya').replaced).toBe(2);
    const md = markdownOf(ydoc);
    expect(md).toContain('- Priya: wants the migration split in two.');
    expect(md).toContain(
      'MY NOTE: check whether Priya already has the ticket. Ask before standup.',
    );
  });

  it('carries the marks at each site, so a bold name stays bold', () => {
    const ydoc = docFrom('## Meeting notes\n\n- **Speaker A** opened; Speaker A then closed.\n');
    expect(relabelNotesSection(ydoc, 'Speaker A', 'Priya').replaced).toBe(2);
    const md = markdownOf(ydoc);
    expect(md).toContain('**Priya**');
    expect(md).toContain('Priya then closed');
  });

  it('matches whole tokens only — naming A does not touch a longer label', () => {
    const ydoc = docFrom('## Meeting notes\n\n- Speaker A: hi.\n- Speaker AB: also hi.\n');
    expect(relabelNotesSection(ydoc, 'Speaker A', 'Priya').replaced).toBe(1);
    const md = markdownOf(ydoc);
    expect(md).toContain('- Priya: hi.');
    expect(md).toContain('- Speaker AB: also hi.');
  });

  it('a doc with no notes section yet is a zero, not a write', () => {
    const ydoc = docFrom('# Agenda\n\nSpeaker B said something.\n');
    expect(relabelNotesSection(ydoc, 'Speaker B', 'Marisol').replaced).toBe(0);
    expect(markdownOf(ydoc)).toContain('Speaker B said something.');
  });

  it('renames a name again, since a correction reads the same way', () => {
    const ydoc = docFrom('## Meeting notes\n\n- Priya: said it.\n');
    expect(relabelNotesSection(ydoc, 'Priya', 'Priya Raman').replaced).toBe(1);
    expect(markdownOf(ydoc)).toContain('- Priya Raman: said it.');
  });
});

describe('retagSpeakerInNotes — renaming by label rather than by spelling', () => {
  it('renames every tag for that voice and leaves every other tag alone', () => {
    const ydoc = docFrom(
      '## Meeting notes\n\n' +
        '- [@Speaker B](speaker:B) asked for the gate.\n' +
        '- [@Speaker A](speaker:A) pushed back.\n' +
        '- [@Speaker B](speaker:B) agreed to file it.\n',
    );
    expect(retagSpeakerInNotes(ydoc, 'B', 'Devi').replaced).toBe(2);
    const md = markdownOf(ydoc);
    expect(md).toContain('- [@Devi](speaker:B) asked for the gate.');
    expect(md).toContain('- [@Devi](speaker:B) agreed to file it.');
    expect(md).toContain('- [@Speaker A](speaker:A) pushed back.');
  });

  it('separates two voices a person has given the same name', () => {
    // The thing `relabelNotesSection` cannot do, and the reason tags exist:
    // the text says "Alex" twice and the label says which Alex is which.
    const ydoc = docFrom(
      '## Meeting notes\n\n- [@Alex](speaker:A) proposed it.\n- [@Alex](speaker:B) objected.\n',
    );
    expect(retagSpeakerInNotes(ydoc, 'A', 'Alex Chen').replaced).toBe(1);
    const md = markdownOf(ydoc);
    expect(md).toContain('- [@Alex Chen](speaker:A) proposed it.');
    expect(md).toContain('- [@Alex](speaker:B) objected.');
  });

  it('leaves the tag a tag — the link mark survives, so the next rename finds it', () => {
    const ydoc = docFrom('## Meeting notes\n\n- [@Speaker B](speaker:B) asked.\n');
    retagSpeakerInNotes(ydoc, 'B', 'Devi');
    // The second rename can only work if the first left the href in place.
    expect(retagSpeakerInNotes(ydoc, 'B', 'Devi Raman').replaced).toBe(1);
    expect(markdownOf(ydoc)).toContain('- [@Devi Raman](speaker:B) asked.');
  });

  it('keeps the words around the tag exactly, marks included', () => {
    const ydoc = docFrom(
      '## Meeting notes\n\n- [@Speaker B](speaker:B) wants **the gate** moved [before merge](/w/w-1/t/t-1).\n',
    );
    expect(retagSpeakerInNotes(ydoc, 'B', 'Devi').replaced).toBe(1);
    expect(markdownOf(ydoc)).toContain(
      '- [@Devi](speaker:B) wants **the gate** moved [before merge](/w/w-1/t/t-1).',
    );
  });

  it('cannot reach a tag outside the notes section, or prose that merely says the name', () => {
    const ydoc = docFrom(
      '# Agenda\n\n[@Speaker B](speaker:B) is joining.\n\n' +
        '## Meeting notes\n\n- Speaker B is the one on the call, says [@Speaker B](speaker:B).\n\n' +
        '## Next steps\n\n- [@Speaker B](speaker:B) to file it.\n',
    );
    expect(retagSpeakerInNotes(ydoc, 'B', 'Devi').replaced).toBe(1);
    const md = markdownOf(ydoc);
    expect(md).toContain('[@Speaker B](speaker:B) is joining.');
    expect(md).toContain('- [@Speaker B](speaker:B) to file it.');
    // Inside the section, only the TAG moved — the words did not.
    expect(md).toContain('- Speaker B is the one on the call, says [@Devi](speaker:B).');
  });

  it('a doc with no notes section is a zero, not a write', () => {
    const ydoc = docFrom('# Agenda\n\n[@Speaker B](speaker:B) is joining.\n');
    expect(retagSpeakerInNotes(ydoc, 'B', 'Devi').replaced).toBe(0);
    expect(markdownOf(ydoc)).toContain('[@Speaker B](speaker:B) is joining.');
  });

  it('is a no-op when the tag already reads that way', () => {
    const ydoc = docFrom('## Meeting notes\n\n- [@Devi](speaker:B) asked.\n');
    expect(retagSpeakerInNotes(ydoc, 'B', 'Devi').replaced).toBe(0);
  });
});

describe('applyNotesRelabel', () => {
  const roomsWith = (docId: string, type: DocType, markdown: string) => {
    const ydoc = docFrom(markdown);
    return {
      rooms: { get: (id: string) => (id === docId ? { ydoc, meta: { type } } : undefined) },
      ydoc,
    };
  };
  const relabel = (
    docId: string,
    from: string,
    to: string,
    over: Partial<NotesRelabel> = {},
  ): NotesRelabel => ({
    docId,
    meetingId: 'm-1',
    label: 'B',
    from,
    to,
    rewriteUntagged: true,
    ...over,
  });

  it('renames tags AND untagged prose when the name is unambiguous', () => {
    const { rooms, ydoc } = roomsWith(
      'doc-a',
      'markdown',
      '## Meeting notes\n\n- [@Speaker B](speaker:B) asked.\n- Speaker B also agreed.\n',
    );
    expect(
      applyNotesRelabel(rooms, relabel('doc-a', 'Speaker B', 'Devi'), createNotesLedger()),
    ).toBe(2);
    const md = markdownOf(ydoc);
    expect(md).toContain('- [@Devi](speaker:B) asked.');
    expect(md).toContain('- Devi also agreed.');
  });

  it('renames only the tags when the display name belongs to more than one voice', () => {
    // Two Alexes: the tag knows which one it is and renames; the sentence
    // that merely SAYS "Alex" does not, and is left as the person wrote it.
    const { rooms, ydoc } = roomsWith(
      'doc-a',
      'markdown',
      '## Meeting notes\n\n- [@Alex](speaker:A) proposed it.\n- Alex and Alex disagreed.\n',
    );
    expect(
      applyNotesRelabel(
        rooms,
        relabel('doc-a', 'Alex', 'Sam', { label: 'A', rewriteUntagged: false }),
        createNotesLedger(),
      ),
    ).toBe(1);
    const md = markdownOf(ydoc);
    expect(md).toContain('- [@Sam](speaker:A) proposed it.');
    expect(md).toContain('- Alex and Alex disagreed.');
  });

  it('rewrites the mentions in a prose doc and counts them', () => {
    const { rooms, ydoc } = roomsWith(
      'doc-a',
      'markdown',
      '## Meeting notes\n\n- Speaker B: yes.\n',
    );
    expect(
      applyNotesRelabel(rooms, relabel('doc-a', 'Speaker B', 'Marisol'), createNotesLedger()),
    ).toBe(1);
    expect(markdownOf(ydoc)).toContain('- Marisol: yes.');
  });

  it('leaves the agent still owning the lines it renamed', () => {
    // The rename edits the agent's own bullet in place. If the ledger came
    // out of that not recognising its own line, the note-taker would have
    // silently handed it to Bryan: the next tick could only propose on it,
    // and the notes would freeze at the moment of the rename.
    const { rooms, ydoc } = roomsWith('doc-a', 'markdown', '# Huddle\n');
    const ledger = createNotesLedger();
    let n = 0;
    const tick = (notes: string) =>
      applyNotesUpdate(
        rooms,
        {
          docId: 'doc-a',
          meetingId: 'm-1',
          tick: { tick: ++n, reason: 'pause', turns: [] },
          notes,
        },
        ledger,
      );
    tick('## Meeting notes\n\n- Speaker B: yes.\n');
    expect(applyNotesRelabel(rooms, relabel('doc-a', 'Speaker B', 'Marisol'), ledger)).toBe(1);

    tick('## Meeting notes\n\n- Marisol: yes, on Friday.\n');
    const md = markdownOf(ydoc);
    expect(md).toContain('- Marisol: yes, on Friday.');
    expect(md).not.toContain('- Marisol: yes.\n');
  });

  it('leaves the agent still owning the lines whose TAG it renamed', () => {
    // Same freeze as above, reached through the tag path: the retag rewrites
    // characters inside the agent's own bullet, so the ledger has to learn
    // the new wording or the next tick can only propose on it.
    const { rooms, ydoc } = roomsWith('doc-a', 'markdown', '# Huddle\n');
    const ledger = createNotesLedger();
    let n = 0;
    const tick = (notes: string) =>
      applyNotesUpdate(
        rooms,
        {
          docId: 'doc-a',
          meetingId: 'm-1',
          tick: { tick: ++n, reason: 'pause', turns: [] },
          notes,
        },
        ledger,
      );
    tick('## Meeting notes\n\n- [@Speaker B](speaker:B) said yes.\n');
    expect(
      applyNotesRelabel(
        rooms,
        relabel('doc-a', 'Speaker B', 'Marisol', { rewriteUntagged: false }),
        ledger,
      ),
    ).toBe(1);

    tick('## Meeting notes\n\n- [@Marisol](speaker:B) said yes, on Friday.\n');
    const md = markdownOf(ydoc);
    expect(md).toContain('- [@Marisol](speaker:B) said yes, on Friday.');
    expect(md).not.toContain('said yes.\n');
  });

  it('a rename does not let the agent reclaim a line Bryan made his', () => {
    const { rooms, ydoc } = roomsWith('doc-a', 'markdown', '# Huddle\n');
    const ledger = createNotesLedger();
    let n = 0;
    const tick = (notes: string) =>
      applyNotesUpdate(
        rooms,
        {
          docId: 'doc-a',
          meetingId: 'm-1',
          tick: { tick: ++n, reason: 'pause', turns: [] },
          notes,
        },
        ledger,
      );
    tick('## Meeting notes\n\n- Speaker B: yes.\n- Speaker B: and the date.\n');
    // He rewrites the second bullet in his own words, then the rename runs.
    const list = (prose.getProseFragment(ydoc).toArray() as Y.XmlElement[]).find(
      (el) => el.nodeName === 'bulletList',
    )!;
    const li = list.toArray()[1] as Y.XmlElement;
    const text = (li.toArray()[0] as Y.XmlElement).toArray()[0] as Y.XmlText;
    ydoc.transact(() => {
      text.delete(0, text.length);
      prose.insertTextWithMarks(text, 0, 'Speaker B — MY wording of the date', {
        parseInlineMarks: true,
      });
    }, 'browser');
    applyNotesRelabel(rooms, relabel('doc-a', 'Speaker B', 'Marisol'), ledger);

    tick('## Meeting notes\n\n- Marisol: yes.\n- Marisol: the date, tidied up.\n');
    expect(markdownOf(ydoc)).toContain('Marisol — MY wording of the date');
  });

  it('a gone doc and a flat doc are both zero, never a throw', () => {
    const { rooms } = roomsWith('doc-a', 'markdown', '## Meeting notes\n\n- Speaker B: yes.\n');
    expect(
      applyNotesRelabel(rooms, relabel('doc-gone', 'Speaker B', 'Marisol'), createNotesLedger()),
    ).toBe(0);
    const flat = roomsWith('doc-b', 'diff', '## Meeting notes\n\n- Speaker B: yes.\n');
    expect(
      applyNotesRelabel(flat.rooms, relabel('doc-b', 'Speaker B', 'Marisol'), createNotesLedger()),
    ).toBe(0);
    expect(markdownOf(flat.ydoc)).toContain('- Speaker B: yes.');
  });
});

describe('withServerNotesSinks', () => {
  const serverDeps = () => {
    const ydoc = docFrom('# Planning\n');
    const rooms = {
      get: (id: string) =>
        id === 'doc-a'
          ? { ydoc, meta: { type: 'markdown' as DocType, title: 'Q3 planning', setId: 'w-1' } }
          : undefined,
    };
    const tasks = {
      listTasks: (workspaceId: string) =>
        workspaceId === 'w-1'
          ? [
              { title: 'Live task', status: 'todo' },
              { title: 'Done task', status: 'done' },
              { title: 'A goal row', status: 'todo', kind: 'goal' as const },
            ]
          : [],
    };
    return { ydoc, deps: { rooms: () => rooms, tasks: () => tasks } };
  };

  it('resolves doc title and OPEN board task titles as the composer context', () => {
    const { deps } = serverDeps();
    const wired = withServerNotesSinks({ composer: { name: 's', compose: async () => 'n' } }, deps);
    const context = wired.resolveContext?.('doc-a');
    expect(context?.docTitle).toBe('Q3 planning');
    expect(context?.workspaceId).toBe('w-1');
    expect(context?.taskTitles).toEqual(['Live task']);
  });

  it('caller-supplied context fields ride along with the gathered ones', () => {
    const { deps } = serverDeps();
    const wired = withServerNotesSinks(
      { composer: { name: 's', compose: async () => 'n' }, context: { repoRoot: '/repo' } },
      deps,
    );
    const context = wired.resolveContext?.('doc-a');
    expect(context?.repoRoot).toBe('/repo');
    expect(context?.docTitle).toBe('Q3 planning');
  });

  it('a doc without a room still resolves the caller context', () => {
    const { deps } = serverDeps();
    const wired = withServerNotesSinks(
      { composer: { name: 's', compose: async () => 'n' }, context: { repoRoot: '/repo' } },
      deps,
    );
    expect(wired.resolveContext?.('doc-gone')).toEqual({ repoRoot: '/repo' });
  });

  it('composed notes land in the doc AND reach the caller sink', () => {
    const { ydoc, deps } = serverDeps();
    const seen: NotesUpdate[] = [];
    const wired = withServerNotesSinks(
      { composer: { name: 's', compose: async () => 'n' }, onNotes: (u) => seen.push(u) },
      deps,
    );
    wired.onNotes(update('doc-a', '## Meeting notes\n\n- landed\n'));
    expect(markdownOf(ydoc)).toContain('- landed');
    expect(seen.length).toBe(1);
  });

  it('a caller sink is optional — the doc write alone is the feature', () => {
    const { ydoc, deps } = serverDeps();
    const wired = withServerNotesSinks({ composer: { name: 's', compose: async () => 'n' } }, deps);
    wired.onNotes(update('doc-a', '- landed'));
    expect(markdownOf(ydoc)).toContain('- landed');
  });
});

describe('withServerNotesSinks task capture', () => {
  const captureWorld = () => {
    const ydoc = docFrom('# Planning\n');
    const rooms = {
      get: (id: string) =>
        id === 'doc-a'
          ? { ydoc, meta: { type: 'markdown' as DocType, title: 'Q3 planning', setId: 'w-1' } }
          : undefined,
    };
    const created: unknown[] = [];
    const wakes: unknown[] = [];
    const board = {
      listTasks: (workspaceId: string) =>
        workspaceId === 'w-1'
          ? [{ id: 't-live', title: 'Live navbar strip task', status: 'todo' as const }]
          : [],
      createTask: () => {
        created.push(1);
        return { ok: false as const, error: 'workspace-retired' };
      },
      transition: () => ({ ok: false as const }),
    };
    const extractor = {
      name: 'stub',
      extract: () => Promise.resolve([{ kind: 'reference' as const, taskId: 't-live' }]),
    };
    return { rooms, board, created, wakes, extractor };
  };

  it('assembles a per-tick capture that resolves the doc board and links rows', async () => {
    const w = captureWorld();
    const wired = withServerNotesSinks(
      { composer: { name: 's', compose: async () => 'n' }, taskExtractor: w.extractor },
      {
        rooms: () => w.rooms,
        tasks: () => ({ listTasks: () => [] }),
        captureBoard: () => w.board,
        onTaskReady: (wake) => w.wakes.push(wake),
      },
    );
    const links = await wired.captureTasks?.({
      docId: 'doc-a',
      meetingId: 'm-1',
      turns: [{ turn: 1, text: 'The navbar strip task again.' }],
    });
    expect(links).toEqual([
      { title: 'Live navbar strip task', url: '/workspaces/w-1?task=t-live', status: 'todo' },
    ]);
    expect(w.created).toHaveLength(0);
  });

  it('a doc outside any workspace captures nothing', async () => {
    const w = captureWorld();
    const wired = withServerNotesSinks(
      { composer: { name: 's', compose: async () => 'n' }, taskExtractor: w.extractor },
      {
        rooms: () => w.rooms,
        tasks: () => ({ listTasks: () => [] }),
        captureBoard: () => w.board,
      },
    );
    const links = await wired.captureTasks?.({
      docId: 'doc-unknown',
      meetingId: 'm-1',
      turns: [{ turn: 1, text: 'Anything.' }],
    });
    expect(links).toEqual([]);
  });

  it('no extractor means no capture hook at all', () => {
    const w = captureWorld();
    const wired = withServerNotesSinks(
      { composer: { name: 's', compose: async () => 'n' } },
      { rooms: () => w.rooms, tasks: () => ({ listTasks: () => [] }), captureBoard: () => w.board },
    );
    expect(wired.captureTasks).toBeUndefined();
  });
});

describe('withServerNotesSinks — the person’s writing survives the next tick', () => {
  const wire = () => {
    const ydoc = docFrom('# Planning\n');
    const rooms = {
      get: (id: string) =>
        id === 'doc-a'
          ? { ydoc, meta: { type: 'markdown' as DocType, title: 'Q3 planning', setId: 'w-1' } }
          : undefined,
    };
    const wired = withServerNotesSinks(
      { composer: { name: 's', compose: async () => 'n' } },
      { rooms: () => rooms, tasks: () => ({ listTasks: () => [] }) },
    );
    return { ydoc, wired };
  };

  it('keeps a bullet typed between two ticks, and still revises the agent’s', () => {
    const { ydoc, wired } = wire();
    wired.onNotes(update('doc-a', '## Meeting notes\n\n- agent point one\n'));

    // The person types into the section, the way the editor would.
    const list = (prose.getProseFragment(ydoc).toArray() as Y.XmlElement[]).find(
      (el) => el.nodeName === 'bulletList',
    )!;
    const li = new Y.XmlElement('listItem');
    const p = new Y.XmlElement('paragraph');
    const t = new Y.XmlText();
    li.insert(0, [p]);
    p.insert(0, [t]);
    ydoc.transact(() => {
      list.insert(1, [li]);
      prose.insertTextWithMarks(t, 0, 'and MY note, in my words', { parseInlineMarks: true });
    }, 'browser');

    // The next tick reads the section first, exactly as the session does.
    const read = wired.readSection?.({ docId: 'doc-a', meetingId: 'm-doc-a-1' });
    expect(read?.human).toEqual(['and MY note, in my words']);
    wired.onNotes({
      ...update(
        'doc-a',
        '## Meeting notes\n\n- agent point one, revised\n' +
          '- and MY note, in my words\n- agent point two\n',
      ),
      ...(read ? { basedOn: read.items } : {}),
    });

    const md = markdownOf(ydoc);
    expect(md).toContain('- and MY note, in my words');
    expect(md.split('and MY note, in my words').length).toBe(2);
    expect(md).toContain('- agent point one, revised');
    expect(md).toContain('- agent point two');
    expect(md).not.toContain('- agent point one\n');
  });

  it('a second meeting on the same doc still revises the first one’s notes', () => {
    const { ydoc, wired } = wire();
    wired.onNotes(update('doc-a', '## Meeting notes\n\n- last meeting’s note\n'));
    // The ledger is per doc and outlives a meeting, so notes the agent wrote
    // last time are still its own to replace.
    wired.onNotes({ ...update('doc-a', '## Meeting notes\n\n- this meeting\n'), meetingId: 'm-2' });
    const md = markdownOf(ydoc);
    expect(md).not.toContain('last meeting’s note');
    expect(md).toContain('- this meeting');
  });

  it('a restarted server adds rather than replacing — it wrote none of this', () => {
    const { ydoc, wired } = wire();
    wired.onNotes(update('doc-a', '## Meeting notes\n\n- from before the restart\n'));
    // A fresh wiring is a fresh process: its ledger claims nothing.
    const rooms = {
      get: (id: string) =>
        id === 'doc-a'
          ? { ydoc, meta: { type: 'markdown' as DocType, title: 'Q3 planning', setId: 'w-1' } }
          : undefined,
    };
    const restarted = withServerNotesSinks(
      { composer: { name: 's', compose: async () => 'n' } },
      { rooms: () => rooms, tasks: () => ({ listTasks: () => [] }) },
    );
    restarted.onNotes(update('doc-a', '## Meeting notes\n\n- after the restart\n'));
    const md = markdownOf(ydoc);
    expect(md).toContain('- from before the restart');
    expect(md).toContain('- after the restart');
  });
});
