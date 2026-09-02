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
  NOTES_REWRITE_SIMILARITY,
  type NoteItem,
  type NotesOwnership,
  classifyOwnership,
  createNotesOwnership,
  findNotesSection,
  itemsInSection,
  itemsOfMarkdown,
  mergeNotesSection,
  planNotesMerge,
  readNotesSection,
  similarity,
} from '../src/meeting-notes-merge.ts';

const HEADING = 'Meeting notes';

/** An ownership record that claims whatever markdown is listed, whichever
 *  element carries it — for the pure-plan tests, which hold no real doc. */
const claimsText = (mds: readonly string[]): NotesOwnership => ({
  claims: (_el, md) => mds.includes(md),
  record: () => {},
  release: () => {},
});

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

/** Turn one of the section's paragraphs into a bullet at the end of the
 *  list, the way a person tidying their notes mid-meeting would. The words
 *  do not change; only the structure does. */
function paragraphToBullet(ydoc: Y.Doc, text: string): void {
  const fragment = prose.getProseFragment(ydoc);
  const span = findNotesSection(fragment, HEADING)!;
  const para = itemsInSection(fragment, span).find((i) => i.kind === 'block' && i.md === text)!;
  const list = (fragment.toArray() as Y.XmlElement[]).find((el) => el.nodeName === 'bulletList')!;
  const li = new Y.XmlElement('listItem');
  const holder = new Y.XmlElement('paragraph');
  const t = new Y.XmlText();
  li.insert(0, [holder]);
  holder.insert(0, [t]);
  ydoc.transact(() => {
    fragment.delete((fragment.toArray() as Y.XmlElement[]).indexOf(para.el), 1);
    list.insert(list.length, [li]);
    prose.insertTextWithMarks(t, 0, text, { parseInlineMarks: true });
  }, 'browser');
}

describe('mergeNotesSection — a person writing in the section', () => {
  it("keeps a bullet the person typed, and still revises the agent's own", () => {
    const ydoc = docFrom('# Huddle\n');
    const own = createNotesOwnership();
    const first = mergeNotesSection(
      ydoc,
      '## Meeting notes\n\n- Ship on Friday\n- Dana owns the migration\n',
      HEADING,
      { ownership: own },
    );
    expect(first.mode).toBe('appended');

    typeBullet(ydoc, 1, 'MY OWN note, in my words');
    const read = readNotesSection(ydoc, HEADING, own)!;
    expect(read.human).toEqual(['MY OWN note, in my words']);

    const merged = mergeNotesSection(
      ydoc,
      '## Meeting notes\n\n- Ship on Friday, per Dana\n- MY OWN note, in my words\n' +
        '- Dana owns the migration\n- A new point from this tick\n',
      HEADING,
      { ownership: own, basedOn: read.items },
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
    const own = createNotesOwnership();
    mergeNotesSection(ydoc, '## Meeting notes\n\n- Agent bullet\n', HEADING, {
      ownership: own,
    });
    const typed = typeBullet(ydoc, 1, 'Keep the **bold** and the `code`');
    const read = readNotesSection(ydoc, HEADING, own)!;

    mergeNotesSection(
      ydoc,
      '## Meeting notes\n\n- Agent bullet, revised\n- Keep the **bold** and the `code`\n',
      HEADING,
      { ownership: own, basedOn: read.items },
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
    // The agent wrote that one bullet, so it is the only thing it may touch.
    const own = createNotesOwnership();
    const fragment = prose.getProseFragment(ydoc);
    const span = findNotesSection(fragment, HEADING)!;
    own.record(itemsInSection(fragment, span).map((i) => ({ el: i.el, md: i.md })));

    const merged = mergeNotesSection(
      ydoc,
      '## Meeting notes\n\n- Ship on Friday, per Dana\n',
      HEADING,
      { ownership: own },
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
      ownership: createNotesOwnership(),
    });
    expect(merged.deleted).toBe(0);
    const md = markdownOf(ydoc);
    expect(md).toContain('- My agenda, typed before we started');
    expect(md).toContain('- First composed note');
  });

  it('a line the person typed that MATCHES an agent line is still theirs', () => {
    // Ownership by text alone would consume the ledger entry in reading
    // order and hand the person's element to the agent, which would then
    // delete it on the next revision — the loss this module exists to stop.
    const ydoc = docFrom('# Huddle\n');
    const own = createNotesOwnership();
    mergeNotesSection(ydoc, '## Meeting notes\n\n- Ship on Friday\n', HEADING, {
      ownership: own,
    });
    const typed = typeBullet(ydoc, 0, 'Ship on Friday');
    const read = readNotesSection(ydoc, HEADING, own)!;
    expect(read.human).toEqual(['Ship on Friday']);

    mergeNotesSection(
      ydoc,
      '## Meeting notes\n\n- Ship on Friday\n- Ship on Friday, per Dana\n',
      HEADING,
      { ownership: own, basedOn: read.items },
    );
    expect(sectionItems(ydoc).some((i) => i.el === typed)).toBe(true);
    expect(markdownOf(ydoc)).toContain('- Ship on Friday, per Dana');
  });

  it('a person’s edit of an agent bullet makes it theirs from then on', () => {
    const ydoc = docFrom('# Huddle\n');
    const own = createNotesOwnership();
    mergeNotesSection(
      ydoc,
      '## Meeting notes\n\n- Discussed teh budget\n- Second point\n',
      HEADING,
      { ownership: own },
    );
    editBullet(ydoc, 0, 'Discussed the budget');
    const read = readNotesSection(ydoc, HEADING, own)!;
    expect(read.human).toContain('Discussed the budget');

    // The composer now sees his spelling and reproduces it.
    const merged = mergeNotesSection(
      ydoc,
      '## Meeting notes\n\n- Discussed the budget\n- Second point, revised\n',
      HEADING,
      { ownership: own, basedOn: read.items },
    );
    const md = markdownOf(ydoc);
    expect(md).toContain('- Discussed the budget');
    expect(md).not.toContain('teh budget');
    expect(md.split('the budget').length).toBe(2); // his line, not his line twice
    expect(merged.ok).toBe(true);
  });
});

describe('mergeNotesSection — proposing rather than rewriting', () => {
  const setup = (): { ydoc: Y.Doc; own: NotesOwnership; basedOn: string[] } => {
    const ydoc = docFrom('# Huddle\n');
    const own = createNotesOwnership();
    mergeNotesSection(ydoc, '## Meeting notes\n\n- Agent bullet\n', HEADING, { ownership: own });
    typeBullet(ydoc, 1, 'we shuold ship on friday i think');
    const read = readNotesSection(ydoc, HEADING, own)!;
    return { ydoc, own, basedOn: read.items };
  };

  const proposal = '## Meeting notes\n\n- Agent bullet\n- We should ship on Friday, I think\n';

  it('a changed version of a person’s line lands as a suggestion, not a rewrite', () => {
    const { ydoc, own, basedOn } = setup();
    const merged = mergeNotesSection(ydoc, proposal, HEADING, { ownership: own, basedOn });
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
    const { ydoc, own, basedOn } = setup();
    mergeNotesSection(ydoc, proposal, HEADING, { ownership: own, basedOn });
    const sid = suggestOps.listSuggestions(ydoc)[0]!.sid;
    expect(suggestOps.acceptSuggestion(ydoc, sid)).toEqual({ ok: true });
    expect(markdownOf(ydoc)).toContain('- We should ship on Friday, I think');
  });

  it('the same proposal is not raised again on the next tick', () => {
    const { ydoc, own, basedOn } = setup();
    mergeNotesSection(ydoc, proposal, HEADING, { ownership: own, basedOn });
    const read = readNotesSection(ydoc, HEADING, own)!;
    const two = mergeNotesSection(ydoc, proposal, HEADING, {
      ownership: own,
      basedOn: read.items,
    });
    expect(two.suggested).toBe(0);
    expect(suggestOps.listSuggestions(ydoc).length).toBe(1);
  });
});

describe('mergeNotesSection — the stale-compose race', () => {
  it('a compose that never saw the edit does not propose over it', () => {
    const ydoc = docFrom('# Huddle\n');
    const own = createNotesOwnership();
    mergeNotesSection(ydoc, '## Meeting notes\n\n- Agent bullet\n', HEADING, {
      ownership: own,
    });
    // The compose reads the section...
    const read = readNotesSection(ydoc, HEADING, own)!;
    // ...and WHILE it is in flight, he types.
    typeBullet(ydoc, 1, 'my note, mid-compose, in my words');

    const merged = mergeNotesSection(
      ydoc,
      '## Meeting notes\n\n- Agent bullet\n- My note, mid compose, in my words\n',
      HEADING,
      { ownership: own, basedOn: read.items },
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
    const own = createNotesOwnership();
    mergeNotesSection(
      ydoc,
      '## Meeting notes\n\n- Ship on Friday\n- New point from tick 2\n',
      HEADING,
      { ownership: own },
    );
    const read = readNotesSection(ydoc, HEADING, own)!;
    editBullet(ydoc, 1, 'New point from tick 2 — reworded by hand');

    const merged = mergeNotesSection(
      ydoc,
      '## Meeting notes\n\n- Ship on Friday\n- New point from tick two, polished\n',
      HEADING,
      { ownership: own, basedOn: read.items },
    );
    expect(merged.dropped).toBe(1);
    expect(merged.inserted).toBe(0);
    const md = markdownOf(ydoc);
    expect(md).toContain('- New point from tick 2 — reworded by hand');
    expect(md).not.toContain('polished');
  });

  it('does not restore a paragraph the person turned into a bullet', () => {
    // Same words, new structure. The compose read the paragraph; by the time
    // it answers, that sentence is a bullet in his own list. Re-inserting
    // the paragraph would leave him holding two copies of his own line.
    const ydoc = docFrom('# Huddle\n');
    const own = createNotesOwnership();
    mergeNotesSection(
      ydoc,
      '## Meeting notes\n\nShip on Friday.\n\n- Dana owns the migration\n',
      HEADING,
      { ownership: own },
    );
    const read = readNotesSection(ydoc, HEADING, own)!;
    paragraphToBullet(ydoc, 'Ship on Friday.');

    const merged = mergeNotesSection(
      ydoc,
      '## Meeting notes\n\nShip on Friday.\n\n- Dana owns the migration\n',
      HEADING,
      { ownership: own, basedOn: read.items },
    );
    expect(merged.inserted).toBe(0);
    expect(merged.dropped).toBe(1);
    const md = markdownOf(ydoc);
    expect(md).toContain('- Ship on Friday.');
    expect(md.match(/Ship on Friday\./g)?.length).toBe(1);
  });

  it('a line scoring EXACTLY the cutoff is still a rewrite, not a new note', () => {
    // 3 shared words of 5 and 5 — Dice 0.6 on the nose. The constant says
    // 0.6 counts; a strict > here would insert the composer's version as a
    // second note and leave him holding both.
    const ydoc = docFrom('# Huddle\n');
    const own = createNotesOwnership();
    mergeNotesSection(ydoc, '## Meeting notes\n\n- placeholder\n', HEADING, {
      ownership: own,
    });
    typeBullet(ydoc, 1, 'ship the migration on friday');
    const read = readNotesSection(ydoc, HEADING, own)!;
    expect(similarity('ship the migration on friday', 'ship the migration next tuesday')).toBe(
      NOTES_REWRITE_SIMILARITY,
    );

    const merged = mergeNotesSection(
      ydoc,
      '## Meeting notes\n\n- placeholder\n- ship the migration next tuesday\n',
      HEADING,
      { ownership: own, basedOn: read.items },
    );
    expect(merged.inserted).toBe(0);
    expect(merged.suggested).toBe(1);
    expect(markdownOf(ydoc)).toContain('- ship the migration on friday');
    expect(markdownOf(ydoc)).not.toContain('next tuesday');
  });

  it('with no race, the same shape of revision lands normally', () => {
    // The positive control for the two above: identical inputs except that
    // the compose READ the current section, so nothing is withheld.
    const ydoc = docFrom('# Huddle\n');
    const own = createNotesOwnership();
    mergeNotesSection(
      ydoc,
      '## Meeting notes\n\n- Ship on Friday\n- New point from tick 2\n',
      HEADING,
      { ownership: own },
    );
    editBullet(ydoc, 1, 'New point from tick 2 — reworded by hand');
    const read = readNotesSection(ydoc, HEADING, own)!;

    const merged = mergeNotesSection(
      ydoc,
      '## Meeting notes\n\n- Ship on Friday\n- New point from tick 2, reworded and polished\n',
      HEADING,
      { ownership: own, basedOn: read.items },
    );
    expect(merged.dropped).toBe(0);
    expect(merged.suggested).toBe(1);
    expect(markdownOf(ydoc)).toContain('- New point from tick 2 — reworded by hand');
  });
});

describe("mergeNotesSection — the composer moving a person's line", () => {
  it('does not leave two of a note it reordered', () => {
    // The prompt tells the composer to reproduce a person's lines verbatim.
    // It does — but emits them in the other order. Its copy of the line it
    // moved is that same line, not a new note, and must not be inserted.
    const ydoc = docFrom('# Huddle\n');
    const own = createNotesOwnership();
    mergeNotesSection(ydoc, '## Meeting notes\n\n- Alpha\n- Beta\n', HEADING, {
      ownership: own,
    });
    editBullet(ydoc, 0, 'Alpha, as I wrote it');
    editBullet(ydoc, 1, 'Beta, as I wrote it');
    const read = readNotesSection(ydoc, HEADING, own)!;
    expect(read.human.length).toBe(2);

    const merged = mergeNotesSection(
      ydoc,
      '## Meeting notes\n\n- Beta, as I wrote it\n- Alpha, as I wrote it\n',
      HEADING,
      { ownership: own, basedOn: read.items },
    );
    expect(merged.inserted).toBe(0);
    expect(merged.suggested).toBe(0);
    const md = markdownOf(ydoc);
    expect(md.match(/Alpha, as I wrote it/g)?.length).toBe(1);
    expect(md.match(/Beta, as I wrote it/g)?.length).toBe(1);
  });
});

describe('planNotesMerge', () => {
  const item = (md: string): NoteItem =>
    ({ md, kind: 'item', el: new Y.XmlElement('listItem') }) as NoteItem;
  const incoming = (md: string): IncomingItem => ({ md, kind: 'item', ordered: false });

  it('never plans a delete for an item the ledger does not claim', () => {
    const current = [item('agent one'), item('a person typed this'), item('agent two')];
    const plan = planNotesMerge(current, [incoming('agent one revised')], {
      ownership: claimsText(['agent one', 'agent two']),
    });
    expect(plan.deletes.map((d) => d.md)).toEqual(['agent one', 'agent two']);
    expect(plan.deletes.some((d) => d.md === 'a person typed this')).toBe(false);
  });

  it('a line the composer repeats at a second place is not inserted twice — its own included', () => {
    // A later tick re-lists an earlier point under the new material: the
    // first copy anchors to the line already in the doc, the second is an
    // echo of it, not a new note. Agent-owned lines were the gap — only a
    // person's lines used to be checked for echoes, so the agent's own line
    // came back as a duplicate.
    const current = [item('agent one'), item('agent two'), item('a person typed this')];
    const plan = planNotesMerge(
      current,
      [
        incoming('agent one'),
        incoming('agent two'),
        incoming('a person typed this'),
        incoming('agent two'),
        incoming('a person typed this'),
        incoming('agent three'),
      ],
      { ownership: claimsText(['agent one', 'agent two']) },
    );
    expect(plan.deletes).toEqual([]);
    expect(plan.inserts.flatMap((run) => run.entries.map((e) => e.md))).toEqual(['agent three']);
  });

  it("carries the agent's unchanged items forward in the ledger", () => {
    const current = [item('agent one'), item('a person typed this')];
    const plan = planNotesMerge(
      current,
      [incoming('agent one'), incoming('a person typed this'), incoming('agent two')],
      { ownership: claimsText(['agent one']) },
    );
    expect(plan.keptAgent.map((i) => i.md)).toEqual(['agent one']);
    expect(plan.inserts.flatMap((r) => r.entries.map((e) => e.md))).toEqual(['agent two']);
    expect(plan.deletes).toEqual([]);
  });
});

describe('ownership, items and similarity', () => {
  it('claims an ELEMENT, so an identical line the agent did not write is not its own', () => {
    const own = createNotesOwnership();
    const mine = new Y.XmlElement('listItem');
    const theirs = new Y.XmlElement('listItem');
    own.record([{ el: mine, md: 'same line' }]);
    const items = [
      { md: 'same line', kind: 'item', el: theirs } as NoteItem,
      { md: 'same line', kind: 'item', el: mine } as NoteItem,
    ];
    expect(classifyOwnership(items, own)).toEqual([false, true]);
  });

  it('stops claiming an element the moment its words change', () => {
    const own = createNotesOwnership();
    const el = new Y.XmlElement('listItem');
    own.record([{ el, md: 'as the agent left it' }]);
    expect(
      classifyOwnership([{ md: 'as the agent left it', kind: 'item', el } as NoteItem], own),
    ).toEqual([true]);
    expect(
      classifyOwnership([{ md: 'edited by hand', kind: 'item', el } as NoteItem], own),
    ).toEqual([false]);
  });

  it('reads a list as its items, so one edited bullet does not seize the list', () => {
    const ydoc = docFrom('## Meeting notes\n\n- one\n- two\n- three\n');
    const own = createNotesOwnership();
    const fragment = prose.getProseFragment(ydoc);
    const span = findNotesSection(fragment, HEADING)!;
    const all = itemsInSection(fragment, span);
    own.record(all.filter((i) => i.md !== 'two').map((i) => ({ el: i.el, md: i.md })));
    const read = readNotesSection(ydoc, HEADING, own);
    // Items are keys — kind plus markdown — so a person restructuring a line
    // without retyping it still reads as a change to the next compose.
    expect(read?.items).toEqual(['item one', 'item two', 'item three']);
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

describe('a suggestion may not re-attribute a person’s note', () => {
  /** A section holding one agent bullet and one bullet Bryan typed. */
  const setup = (typed: string): { ydoc: Y.Doc; own: NotesOwnership; basedOn: string[] } => {
    const ydoc = docFrom('# Huddle\n');
    const own = createNotesOwnership();
    mergeNotesSection(ydoc, '## Meeting notes\n\n- Agent bullet\n', HEADING, { ownership: own });
    typeBullet(ydoc, 1, typed);
    const read = readNotesSection(ydoc, HEADING, own)!;
    return { ydoc, own, basedOn: read.items };
  };

  it('drops a rewrite that puts a speaker tag on a line the person typed', () => {
    // A line Bryan typed is HIS idea. The composer, seeing it beside the
    // transcript, returns it credited to a voice — which is not a wording
    // proposal, it is a change of authorship, and nobody would read the
    // redline as one. Attribution moves by the reassign gesture only.
    const { ydoc, own, basedOn } = setup('we should ship on friday i think');
    const merged = mergeNotesSection(
      ydoc,
      '## Meeting notes\n\n- Agent bullet\n- [@Devi](speaker:B) says we should ship on Friday, I think\n',
      HEADING,
      { ownership: own, basedOn },
    );
    expect(merged.suggested).toBe(0);
    expect(merged.dropped).toBe(1);
    expect(suggestOps.listSuggestions(ydoc).length).toBe(0);
    const md = markdownOf(ydoc);
    expect(md).toContain('- we should ship on friday i think');
    expect(md).not.toContain('speaker:B');
  });

  it('still proposes a wording change on a line that already carries that tag', () => {
    // The positive control: without it, a guard that dropped every proposal
    // would pass the test above. An attribution the line ALREADY carries is
    // the composer preserving it while it revises the words, which is
    // exactly what it is asked to do.
    const { ydoc, own, basedOn } = setup('[@Devi](speaker:B) we shuold ship on friday');
    const merged = mergeNotesSection(
      ydoc,
      '## Meeting notes\n\n- Agent bullet\n- [@Devi](speaker:B) we should ship on Friday\n',
      HEADING,
      { ownership: own, basedOn },
    );
    expect(merged.suggested).toBe(1);
    // And his words are still the accepted state until he accepts it.
    expect(markdownOf(ydoc)).toContain('we shuold ship on friday');
  });
});

describe('a stop-and-restart never replaces what is already written', () => {
  // The reported data loss (owner, 2026-08-31: "recording replaces all
  // existing notes"): a new session's first tick composes from scratch, so
  // any item the ledger still claimed from the PREVIOUS recording was
  // deleted as "the agent's own note, no longer in the notes". Releasing
  // the claims at session start is the fix; these tests are its guard.

  it('released claims turn a from-scratch compose into an append', () => {
    const ydoc = docFrom('# Doc\n\nIntro.');
    const ownership = createNotesOwnership();
    const first = mergeNotesSection(ydoc, '- old note one\n- old note two', HEADING, {
      ownership,
    });
    expect(first.ok).toBe(true);

    // The recording stops; a new one starts. Session start releases claims.
    ownership.release();

    // The new meeting's first tick composes from scratch: only its own note.
    const read = readNotesSection(ydoc, HEADING, ownership);
    const second = mergeNotesSection(ydoc, '- a brand new note', HEADING, {
      ownership,
      basedOn: read?.items ?? [],
    });
    expect(second.ok).toBe(true);
    expect(second.deleted).toBe(0);

    const md = markdownOf(ydoc);
    expect(md).toContain('old note one');
    expect(md).toContain('old note two');
    expect(md).toContain('a brand new note');
    // Appended after the finished notes, not above them.
    expect(md.indexOf('old note two')).toBeLessThan(md.indexOf('a brand new note'));
  });

  it('a revision of a finished meeting’s note lands as a suggestion, not a rewrite', () => {
    const ydoc = docFrom('# Doc');
    const ownership = createNotesOwnership();
    mergeNotesSection(ydoc, '- we ship the gate on Friday', HEADING, { ownership });
    ownership.release();

    const read = readNotesSection(ydoc, HEADING, ownership);
    const res = mergeNotesSection(ydoc, '- we ship the gate on Thursday', HEADING, {
      ownership,
      basedOn: read?.items ?? [],
    });
    expect(res.ok).toBe(true);
    expect(res.deleted).toBe(0);
    expect(res.suggested).toBe(1);
    // The accepted state is still the finished meeting's words.
    expect(markdownOf(ydoc)).toContain('we ship the gate on Friday');
  });

  it('a new meeting starts a fresh section at the end when the old one is mid-doc', () => {
    // Bryan's report: "notes got inserted in the top in the original Meeting
    // notes section, not at the end of the doc". The old section sits above
    // content he wrote after it; the new meeting's notes go at the END.
    const ydoc = docFrom('# Doc\n\n## Meeting notes\n\n- old note\n\n## Next steps\n\nHis plan.');
    const ownership = createNotesOwnership();
    const res = mergeNotesSection(ydoc, '- new meeting note', HEADING, { ownership });
    expect(res.ok).toBe(true);
    expect(res.mode).toBe('appended');

    const md = markdownOf(ydoc);
    // Two sections now: the old one untouched, the new one at the doc's end.
    expect(md.split('## Meeting notes').length).toBe(3);
    expect(md).toContain('old note');
    expect(md).toContain('His plan.');
    expect(md.indexOf('His plan.')).toBeLessThan(md.indexOf('new meeting note'));
  });

  it('a heading a person types below the section sends the next notes to the END of the doc', () => {
    // Owner's call (2026-09-01): "note always at the end of doc for now".
    // The section this meeting was writing is no longer the doc's tail once
    // a person writes below it; the next tick starts a fresh section after
    // their words instead of growing the old one above them.
    const ydoc = docFrom('# Doc');
    const ownership = createNotesOwnership();
    mergeNotesSection(ydoc, '- first note', HEADING, { ownership });

    // Mid-meeting, a person writes a heading after the section.
    const fragment = prose.getProseFragment(ydoc);
    ydoc.transact(() => {
      fragment.insert(fragment.length, prose.parseMarkdownBlocks('## Aside\n\nTyped below.'));
    }, 'browser');

    const read = readNotesSection(ydoc, HEADING, ownership);
    const res = mergeNotesSection(ydoc, '- first note\n- second note', HEADING, {
      ownership,
      basedOn: read?.items ?? [],
    });
    expect(res.ok).toBe(true);
    expect(res.mode).toBe('appended');
    const md = markdownOf(ydoc);
    // A second section, after the person's text…
    expect(md.split('## Meeting notes').length).toBe(3);
    expect(md.indexOf('Typed below.')).toBeLessThan(md.indexOf('second note'));
    // …holding only what is NEW: the first note is already written above,
    // and the fresh section does not say it again.
    expect(md.match(/first note/g)).toHaveLength(1);
    expect(md.indexOf('first note')).toBeLessThan(md.indexOf('Typed below.'));
  });

  it('once the fresh section is the tail, later ticks append into it and still skip the old lines', () => {
    const ydoc = docFrom('# Doc');
    const ownership = createNotesOwnership();
    mergeNotesSection(ydoc, '- first note', HEADING, { ownership });
    const fragment = prose.getProseFragment(ydoc);
    ydoc.transact(() => {
      fragment.insert(fragment.length, prose.parseMarkdownBlocks('## Aside\n\nTyped below.'));
    }, 'browser');
    mergeNotesSection(ydoc, '- first note\n- second note', HEADING, { ownership, basedOn: [] });

    // The composer's `previous` is the last section only, so it re-lists
    // the first note every tick. It lands nowhere new.
    const read = readNotesSection(ydoc, HEADING, ownership);
    expect(read?.items).toEqual(['item second note']);
    const res = mergeNotesSection(ydoc, '- first note\n- second note\n- third note', HEADING, {
      ownership,
      basedOn: read?.items ?? [],
    });
    expect(res.ok).toBe(true);
    expect(res.mode).toBe('merged');
    const md = markdownOf(ydoc);
    expect(md.split('## Meeting notes').length).toBe(3);
    expect(md.match(/first note/g)).toHaveLength(1);
    expect(md.indexOf('second note')).toBeLessThan(md.indexOf('third note'));
    expect(md.indexOf('Typed below.')).toBeLessThan(md.indexOf('third note'));
  });

  it('a tick that only re-lists written lines changes nothing and is not a failure', () => {
    const ydoc = docFrom('# Doc');
    const ownership = createNotesOwnership();
    mergeNotesSection(ydoc, '- first note', HEADING, { ownership });
    const fragment = prose.getProseFragment(ydoc);
    ydoc.transact(() => {
      fragment.insert(fragment.length, prose.parseMarkdownBlocks('## Aside\n\nTyped below.'));
    }, 'browser');
    const before = markdownOf(ydoc);
    const res = mergeNotesSection(ydoc, '- first note', HEADING, { ownership, basedOn: [] });
    expect(res.ok).toBe(true);
    expect(res.inserted).toBe(0);
    expect(res.dropped).toBe(1);
    expect(markdownOf(ydoc)).toBe(before);
  });

  it('a trailing section from a finished meeting is joined, not duplicated', () => {
    const ydoc = docFrom('# Doc\n\n## Meeting notes\n\n- old note');
    const ownership = createNotesOwnership(); // fresh session: claims nothing
    const res = mergeNotesSection(ydoc, '- new note', HEADING, { ownership });
    expect(res.ok).toBe(true);
    const md = markdownOf(ydoc);
    expect(md.split('## Meeting notes').length).toBe(2);
    expect(md).toContain('old note');
    expect(md.indexOf('old note')).toBeLessThan(md.indexOf('new note'));
  });

  it('findNotesSection answers the LAST matching heading', () => {
    const ydoc = docFrom(
      '# Doc\n\n## Meeting notes\n\n- old note\n\n## Between\n\nx\n\n## Meeting notes\n\n- live note',
    );
    const fragment = prose.getProseFragment(ydoc);
    const span = findNotesSection(fragment, HEADING);
    expect(span).not.toBeNull();
    const items = itemsInSection(fragment, span!);
    expect(items.map((i) => i.md)).toEqual(['live note']);
  });
});
