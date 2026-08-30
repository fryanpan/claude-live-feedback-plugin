/**
 * The note-taker writing into a section a person is ALSO writing in.
 *
 * Every test here fixes words a person typed and asserts they are still
 * there, character for character, after the agent's next write. The suite is
 * the guard: the previous behaviour (delete the section, re-insert the
 * composed string) passes nothing below.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { describe, expect, it } from 'bun:test';
import { prose, suggestOps } from '@feedback/core';
import * as Y from 'yjs';
import {
  type IncomingItem,
  type NoteItem,
  classifyOwnership,
  findNotesSection,
  itemsInSection,
  itemsOfMarkdown,
  mergeNotesSection,
  planNotesMerge,
  readNotesSection,
  similarity,
} from '../src/meeting-notes-merge.ts';

const HEADING = 'Meeting notes';

function docFrom(markdown: string): Y.Doc {
  const ydoc = new Y.Doc();
  prose.applyMarkdownToFragment(prose.getProseFragment(ydoc), markdown);
  return ydoc;
}

function markdownOf(ydoc: Y.Doc): string {
  return prose.serializeFragmentToMarkdown(prose.getProseFragment(ydoc));
}

function sectionItems(ydoc: Y.Doc): NoteItem[] {
  const fragment = prose.getProseFragment(ydoc);
  const span = findNotesSection(fragment, HEADING);
  return span ? itemsInSection(fragment, span) : [];
}

/** Type a bullet into an existing list the way the browser editor would —
 *  a non-agent transaction origin, straight into the Yjs structure. */
function typeBullet(ydoc: Y.Doc, at: number, text: string): Y.XmlElement {
  const list = (prose.getProseFragment(ydoc).toArray() as Y.XmlElement[]).find(
    (el) => el.nodeName === 'bulletList',
  );
  if (!list) throw new Error('fixture has no list to type into');
  const li = new Y.XmlElement('listItem');
  const p = new Y.XmlElement('paragraph');
  const t = new Y.XmlText();
  li.insert(0, [p]);
  p.insert(0, [t]);
  ydoc.transact(() => {
    list.insert(at, [li]);
    prose.insertTextWithMarks(t, 0, text, { parseInlineMarks: true });
  }, 'browser');
  return li;
}

/** Rewrite one existing bullet's words, as a person retyping it would. */
function editBullet(ydoc: Y.Doc, index: number, text: string): void {
  const list = (prose.getProseFragment(ydoc).toArray() as Y.XmlElement[]).find(
    (el) => el.nodeName === 'bulletList',
  );
  if (!list) throw new Error('fixture has no list to edit');
  const items = list.toArray().filter((c) => c instanceof Y.XmlElement) as Y.XmlElement[];
  const holder = items[index]!.toArray()[0] as Y.XmlElement;
  const t = holder.toArray()[0] as Y.XmlText;
  ydoc.transact(() => {
    t.delete(0, t.length);
    prose.insertTextWithMarks(t, 0, text, { parseInlineMarks: true });
  }, 'browser');
}

describe('mergeNotesSection — a person writing in the section', () => {
  it("keeps a bullet the person typed, and still revises the agent's own", () => {
    const ydoc = docFrom('# Huddle\n');
    const first = mergeNotesSection(
      ydoc,
      '## Meeting notes\n\n- Ship on Friday\n- Dana owns the migration\n',
      HEADING,
      { owned: [] },
    );
    expect(first.mode).toBe('appended');

    typeBullet(ydoc, 1, 'MY OWN note, in my words');
    const read = readNotesSection(ydoc, HEADING, first.owned)!;
    expect(read.human).toEqual(['MY OWN note, in my words']);

    const merged = mergeNotesSection(
      ydoc,
      '## Meeting notes\n\n- Ship on Friday, per Dana\n- MY OWN note, in my words\n' +
        '- Dana owns the migration\n- A new point from this tick\n',
      HEADING,
      { owned: first.owned, basedOn: read.items },
    );
    expect(merged.mode).toBe('merged');
    const md = markdownOf(ydoc);
    // His line, verbatim and in place.
    expect(md).toContain('- MY OWN note, in my words');
    expect(md.split('MY OWN note, in my words').length).toBe(2); // exactly once
    // The agent's own notes still move.
    expect(md).toContain('- Ship on Friday, per Dana');
    expect(md).not.toContain('- Ship on Friday\n');
    expect(md).toContain('- A new point from this tick');
  });

  it("keeps the person's inline formatting, and the very same Yjs element", () => {
    const ydoc = docFrom('# Huddle\n');
    const first = mergeNotesSection(ydoc, '## Meeting notes\n\n- Agent bullet\n', HEADING, {
      owned: [],
    });
    const typed = typeBullet(ydoc, 1, 'Keep the **bold** and the `code`');
    const read = readNotesSection(ydoc, HEADING, first.owned)!;

    mergeNotesSection(
      ydoc,
      '## Meeting notes\n\n- Agent bullet, revised\n- Keep the **bold** and the `code`\n',
      HEADING,
      { owned: first.owned, basedOn: read.items },
    );

    expect(markdownOf(ydoc)).toContain('- Keep the **bold** and the `code`');
    // Not re-created from markdown: the element the person typed into is
    // still the element in the doc, so its marks, comment anchors and any
    // cursor inside it are the same ones.
    const stillThere = sectionItems(ydoc).some((i) => i.el === typed);
    expect(stillThere).toBe(true);
  });

  it('never rewrites prose OUTSIDE the section, however it is worded', () => {
    const ydoc = docFrom(
      '# Huddle\n\nShip on Friday — my own paragraph.\n\n' +
        '## Meeting notes\n\n- Ship on Friday\n\n## Next steps\n\nShip on Friday, again.\n',
    );
    const merged = mergeNotesSection(
      ydoc,
      '## Meeting notes\n\n- Ship on Friday, per Dana\n',
      HEADING,
      { owned: ['Ship on Friday'] },
    );
    expect(merged.ok).toBe(true);
    const md = markdownOf(ydoc);
    expect(md).toContain('Ship on Friday — my own paragraph.');
    expect(md).toContain('Ship on Friday, again.');
    expect(md).toContain('## Next steps');
  });

  it('an empty ledger treats everything already there as somebody else’s', () => {
    // A doc whose notes section holds an agenda typed BEFORE the meeting
    // started: the first tick has no ledger, so it must add, never replace.
    const ydoc = docFrom('# Huddle\n\n## Meeting notes\n\n- My agenda, typed before we started\n');
    const merged = mergeNotesSection(ydoc, '## Meeting notes\n\n- First composed note\n', HEADING, {
      owned: [],
    });
    expect(merged.deleted).toBe(0);
    const md = markdownOf(ydoc);
    expect(md).toContain('- My agenda, typed before we started');
    expect(md).toContain('- First composed note');
  });

  it('a person’s edit of an agent bullet makes it theirs from then on', () => {
    const ydoc = docFrom('# Huddle\n');
    const first = mergeNotesSection(
      ydoc,
      '## Meeting notes\n\n- Discussed teh budget\n- Second point\n',
      HEADING,
      { owned: [] },
    );
    editBullet(ydoc, 0, 'Discussed the budget');
    const read = readNotesSection(ydoc, HEADING, first.owned)!;
    expect(read.human).toContain('Discussed the budget');

    // The composer now sees his spelling and reproduces it.
    const merged = mergeNotesSection(
      ydoc,
      '## Meeting notes\n\n- Discussed the budget\n- Second point, revised\n',
      HEADING,
      { owned: first.owned, basedOn: read.items },
    );
    const md = markdownOf(ydoc);
    expect(md).toContain('- Discussed the budget');
    expect(md).not.toContain('teh budget');
    expect(md.split('the budget').length).toBe(2); // his line, not his line twice
    expect(merged.ok).toBe(true);
  });
});

describe('mergeNotesSection — proposing rather than rewriting', () => {
  const setup = (): { ydoc: Y.Doc; owned: string[]; basedOn: string[] } => {
    const ydoc = docFrom('# Huddle\n');
    const first = mergeNotesSection(ydoc, '## Meeting notes\n\n- Agent bullet\n', HEADING, {
      owned: [],
    });
    typeBullet(ydoc, 1, 'we shuold ship on friday i think');
    const read = readNotesSection(ydoc, HEADING, first.owned)!;
    return { ydoc, owned: first.owned, basedOn: read.items };
  };

  const proposal = '## Meeting notes\n\n- Agent bullet\n- We should ship on Friday, I think\n';

  it('a changed version of a person’s line lands as a suggestion, not a rewrite', () => {
    const { ydoc, owned, basedOn } = setup();
    const merged = mergeNotesSection(ydoc, proposal, HEADING, { owned, basedOn });
    expect(merged.suggested).toBe(1);
    expect(merged.inserted).toBe(0);

    // The ACCEPTED state — what serializes to disk — is still his words.
    expect(markdownOf(ydoc)).toContain('- we shuold ship on friday i think');
    expect(markdownOf(ydoc)).not.toContain('We should ship on Friday, I think');

    const pending = suggestOps.listSuggestions(ydoc);
    expect(pending.length).toBe(1);
    expect(pending[0]!.insertedText).toBe('We should ship on Friday, I think');
    expect(pending[0]!.author.name).toBe('Meeting Assistant');
  });

  it('accepting the suggestion is what changes his line', () => {
    const { ydoc, owned, basedOn } = setup();
    mergeNotesSection(ydoc, proposal, HEADING, { owned, basedOn });
    const sid = suggestOps.listSuggestions(ydoc)[0]!.sid;
    expect(suggestOps.acceptSuggestion(ydoc, sid)).toEqual({ ok: true });
    expect(markdownOf(ydoc)).toContain('- We should ship on Friday, I think');
  });

  it('the same proposal is not raised again on the next tick', () => {
    const { ydoc, owned, basedOn } = setup();
    const one = mergeNotesSection(ydoc, proposal, HEADING, { owned, basedOn });
    const read = readNotesSection(ydoc, HEADING, one.owned)!;
    const two = mergeNotesSection(ydoc, proposal, HEADING, {
      owned: one.owned,
      basedOn: read.items,
    });
    expect(two.suggested).toBe(0);
    expect(suggestOps.listSuggestions(ydoc).length).toBe(1);
  });
});

describe('mergeNotesSection — the stale-compose race', () => {
  it('a compose that never saw the edit does not propose over it', () => {
    const ydoc = docFrom('# Huddle\n');
    const first = mergeNotesSection(ydoc, '## Meeting notes\n\n- Agent bullet\n', HEADING, {
      owned: [],
    });
    // The compose reads the section...
    const read = readNotesSection(ydoc, HEADING, first.owned)!;
    // ...and WHILE it is in flight, he types.
    typeBullet(ydoc, 1, 'my note, mid-compose, in my words');

    const merged = mergeNotesSection(
      ydoc,
      '## Meeting notes\n\n- Agent bullet\n- My note, mid compose, in my words\n',
      HEADING,
      { owned: first.owned, basedOn: read.items },
    );
    expect(merged.suggested).toBe(0);
    expect(merged.dropped).toBe(1);
    const md = markdownOf(ydoc);
    expect(md).toContain('- my note, mid-compose, in my words');
    expect(md).not.toContain('My note, mid compose');
    expect(suggestOps.listSuggestions(ydoc).length).toBe(0);
  });

  it('older words for a line he changed mid-compose do not come back', () => {
    const ydoc = docFrom('# Huddle\n');
    const first = mergeNotesSection(
      ydoc,
      '## Meeting notes\n\n- Ship on Friday\n- New point from tick 2\n',
      HEADING,
      { owned: [] },
    );
    const read = readNotesSection(ydoc, HEADING, first.owned)!;
    editBullet(ydoc, 1, 'New point from tick 2 — reworded by hand');

    const merged = mergeNotesSection(
      ydoc,
      '## Meeting notes\n\n- Ship on Friday\n- New point from tick two, polished\n',
      HEADING,
      { owned: first.owned, basedOn: read.items },
    );
    expect(merged.dropped).toBe(1);
    expect(merged.inserted).toBe(0);
    const md = markdownOf(ydoc);
    expect(md).toContain('- New point from tick 2 — reworded by hand');
    expect(md).not.toContain('polished');
  });

  it('with no race, the same shape of revision lands normally', () => {
    // The positive control for the two above: identical inputs except that
    // the compose READ the current section, so nothing is withheld.
    const ydoc = docFrom('# Huddle\n');
    const first = mergeNotesSection(
      ydoc,
      '## Meeting notes\n\n- Ship on Friday\n- New point from tick 2\n',
      HEADING,
      { owned: [] },
    );
    editBullet(ydoc, 1, 'New point from tick 2 — reworded by hand');
    const read = readNotesSection(ydoc, HEADING, first.owned)!;

    const merged = mergeNotesSection(
      ydoc,
      '## Meeting notes\n\n- Ship on Friday\n- New point from tick 2, reworded and polished\n',
      HEADING,
      { owned: first.owned, basedOn: read.items },
    );
    expect(merged.dropped).toBe(0);
    expect(merged.suggested).toBe(1);
    expect(markdownOf(ydoc)).toContain('- New point from tick 2 — reworded by hand');
  });
});

describe('planNotesMerge', () => {
  const item = (md: string): NoteItem =>
    ({ md, kind: 'item', el: new Y.XmlElement('listItem') }) as NoteItem;
  const incoming = (md: string): IncomingItem => ({ md, kind: 'item', ordered: false });

  it('never plans a delete for an item the ledger does not claim', () => {
    const current = [item('agent one'), item('a person typed this'), item('agent two')];
    const plan = planNotesMerge(current, [incoming('agent one revised')], {
      owned: ['agent one', 'agent two'],
    });
    expect(plan.deletes.map((d) => d.md)).toEqual(['agent one', 'agent two']);
    expect(plan.deletes.some((d) => d.md === 'a person typed this')).toBe(false);
  });

  it("carries the agent's unchanged items forward in the ledger", () => {
    const current = [item('agent one'), item('a person typed this')];
    const plan = planNotesMerge(
      current,
      [incoming('agent one'), incoming('a person typed this'), incoming('agent two')],
      { owned: ['agent one'] },
    );
    expect(plan.owned).toEqual(['agent one', 'agent two']);
    expect(plan.deletes).toEqual([]);
  });
});

describe('ownership, items and similarity', () => {
  it('matches the ledger as a multiset, not a set', () => {
    const items = [
      { md: 'same line', kind: 'item' } as NoteItem,
      { md: 'same line', kind: 'item' } as NoteItem,
    ];
    expect(classifyOwnership(items, ['same line'])).toEqual([true, false]);
  });

  it('reads a list as its items, so one edited bullet does not seize the list', () => {
    const ydoc = docFrom('## Meeting notes\n\n- one\n- two\n- three\n');
    const read = readNotesSection(ydoc, HEADING, ['one', 'three']);
    expect(read?.items).toEqual(['one', 'two', 'three']);
    expect(read?.human).toEqual(['two']);
  });

  it('flattens incoming markdown the same way the doc is flattened', () => {
    const items = itemsOfMarkdown('- one\n- two\n\nA paragraph.\n\n1. first\n');
    expect(items?.map((i) => [i.kind, i.md, i.ordered])).toEqual([
      ['item', 'one', false],
      ['item', 'two', false],
      ['block', 'A paragraph.', false],
      ['item', 'first', true],
    ]);
  });

  it('scores a rewrite of a line above two unrelated lines', () => {
    expect(
      similarity('we should ship on friday', 'We should ship on Friday, I think'),
    ).toBeGreaterThan(0.6);
    expect(similarity('we should ship on friday', 'Dana owns the migration')).toBeLessThan(0.3);
  });
});
