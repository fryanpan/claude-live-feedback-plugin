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
  applyNotesUpdate,
  replaceNotesSection,
  withServerNotesSinks,
} from '../src/meeting-notes-doc.ts';
import type { NotesUpdate } from '../src/meeting-notes.ts';

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
    expect(applyNotesUpdate(rooms, update('doc-a', '- noted'))).toBe(true);
    expect(markdownOf(ydoc)).toContain('- noted');
  });

  it('refuses flat docs — a diff surface is not a notepad', () => {
    const { rooms, ydoc } = roomsWith('doc-a', 'diff');
    expect(applyNotesUpdate(rooms, update('doc-a', '- noted'))).toBe(false);
    expect(markdownOf(ydoc)).not.toContain('- noted');
  });

  it('an unknown doc is a false, never a throw', () => {
    const { rooms } = roomsWith('doc-a', 'markdown');
    expect(applyNotesUpdate(rooms, update('doc-gone', '- noted'))).toBe(false);
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
