import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  findAndReplace,
  getProseFragment,
  parseMarkdownBlocks,
  rewriteRange,
  walkProse,
} from '../src/prose.ts';
import { acceptSuggestion, suggestReplace } from '../src/suggest-ops.ts';

/**
 * Regression cover for the silent inline-mark loss in the mandated edit path.
 *
 * The trigger: `find_and_replace` re-inserted the replacement with NO
 * attributes, and Yjs' unattributed insert inherits the marks of the character
 * to the LEFT of the insertion point. A match starting strictly inside a
 * marked run therefore kept its formatting (which is why most replaces looked
 * fine), while a match starting at the run's FIRST character — very often the
 * whole run: a bold label, a link, an inline-code span — inherited the
 * UNMARKED text in front of it, and when the match covered the run entirely
 * the mark vanished from the document with `ok: true` and no other signal.
 *
 * Every assertion here is on the MARKS. The plain text was correct throughout
 * the incident, which is exactly why nothing noticed for a whole session.
 */

type Op = { insert: string; attributes?: Record<string, unknown> };

function docFrom(markdown: string): Y.Doc {
  const doc = new Y.Doc();
  const frag = getProseFragment(doc);
  doc.transact(() => frag.push(parseMarkdownBlocks(markdown)));
  return doc;
}

/** Delta of the nth Y.XmlText in document order. */
function delta(doc: Y.Doc, index = 0): Op[] {
  const { segments } = walkProse(getProseFragment(doc));
  return (segments[index]?.node.toDelta() ?? []) as Op[];
}

/** The run carrying `text`, or undefined — the assertion target. */
function run(ops: Op[], text: string): Op | undefined {
  return ops.find((op) => op.insert === text);
}

describe('find_and_replace preserves the marks covering the match', () => {
  it('keeps bold when the match IS the whole bold run (the field case)', () => {
    // A list of bold-label items: the reported incident replaced two labels
    // and lost their bold while every sibling item kept its own.
    const doc = docFrom('- **Fast, secure share** - one\n- **Ambient awareness** - two');
    const res = findAndReplace(doc, {
      find: 'Fast, secure share',
      replace: 'Fast, secure sharing',
    });

    expect(res.ok).toBe(true);
    expect(res.marksDropped).toBeUndefined();
    expect(run(delta(doc, 0), 'Fast, secure sharing')?.attributes?.bold).toBe(true);
    // Positive control on the same doc: the untouched sibling still has its
    // bold, so a green assertion above cannot come from a doc that lost all
    // formatting for some unrelated reason.
    expect(run(delta(doc, 1), 'Ambient awareness')?.attributes?.bold).toBe(true);
  });

  it('keeps bold when the run starts the block (nothing to its left at all)', () => {
    const doc = docFrom('**Lead label** then more');
    expect(findAndReplace(doc, { find: 'Lead label', replace: 'New label' }).ok).toBe(true);
    expect(run(delta(doc), 'New label')?.attributes?.bold).toBe(true);
  });

  it('keeps italic, code, strike and the link href on a whole-run replace', () => {
    const doc = docFrom('a *ital* b `snip` c ~~gone~~ d [docs](https://example.com/x) e');
    for (const [find, replace] of [
      ['ital', 'ITAL'],
      ['snip', 'SNIP'],
      ['gone', 'GONE'],
      ['docs', 'DOCS'],
    ] as const) {
      expect(findAndReplace(doc, { find, replace }).ok).toBe(true);
    }
    const ops = delta(doc);
    expect(run(ops, 'ITAL')?.attributes?.italic).toBe(true);
    expect(run(ops, 'SNIP')?.attributes?.code).toBe(true);
    expect(run(ops, 'GONE')?.attributes?.strike).toBe(true);
    expect((run(ops, 'DOCS')?.attributes?.link as { href: string } | undefined)?.href).toBe(
      'https://example.com/x',
    );
  });

  it('keeps bold for a match strictly inside the run, and for its prefix', () => {
    const inside = docFrom('Intro **bold label** trailing');
    expect(findAndReplace(inside, { find: 'label', replace: 'LABEL' }).ok).toBe(true);
    expect(run(delta(inside), 'bold LABEL')?.attributes?.bold).toBe(true);

    const prefix = docFrom('Intro **bold label** trailing');
    expect(findAndReplace(prefix, { find: 'bold', replace: 'BOLD' }).ok).toBe(true);
    expect(run(delta(prefix), 'BOLD label')?.attributes?.bold).toBe(true);
  });

  it('does NOT bleed a neighbouring run onto an unmarked match', () => {
    // The mirror of the bug: reading marks off the replaced text must also
    // stop left-inheritance from ADDING a mark the match never had.
    const doc = docFrom('**bold**plain tail');
    expect(findAndReplace(doc, { find: 'plain', replace: 'PLAIN' }).ok).toBe(true);
    const ops = delta(doc);
    expect(run(ops, 'bold')?.attributes?.bold).toBe(true);
    expect(ops.find((op) => op.insert.startsWith('PLAIN'))?.attributes?.bold).toBeUndefined();
  });

  it('parseInlineMarks keeps the covering mark AND applies the parsed one', () => {
    const doc = docFrom('Intro **bold label** trailing');
    const res = findAndReplace(doc, {
      find: 'bold label',
      replace: 'a `snippet` here',
      parseInlineMarks: true,
    });
    expect(res.ok).toBe(true);
    const ops = delta(doc);
    expect(run(ops, 'a ')?.attributes?.bold).toBe(true);
    expect(run(ops, 'snippet')?.attributes?.bold).toBe(true);
    expect(run(ops, 'snippet')?.attributes?.code).toBe(true);
  });

  it('REPORTS the mark it cannot carry when the match is only partly covered', () => {
    // A single replacement string has no correspondence to the runs it
    // replaces, so this one genuinely cannot be preserved. The defect being
    // fixed is the silence, so it must come back named.
    const doc = docFrom('Intro **bold label** trailing');
    const res = findAndReplace(doc, { find: 'bold label trailing', replace: 'flat' });

    expect(res.ok).toBe(true);
    expect(res.marksDropped).toEqual(['bold']);
    expect(res.warning).toContain('bold');
    expect(run(delta(doc), 'Intro flat')?.attributes?.bold).toBeUndefined();
  });

  it('says nothing when a uniformly-formatted match is replaced', () => {
    const doc = docFrom('Intro **bold label** trailing');
    const res = findAndReplace(doc, { find: 'bold label', replace: 'NEW' });
    expect(res.marksDropped).toBeUndefined();
    expect(res.warning).toBeUndefined();
  });
});

describe('the anchored and proposed paths agree with the direct one', () => {
  it('rewriteRange keeps the bold of the range it rewrites', () => {
    const doc = docFrom('Intro **bold label** trailing');
    const { segments } = walkProse(getProseFragment(doc));
    const node = segments[0]!.node;
    const startRel = Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(node, 6));
    const endRel = Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(node, 16));

    const res = rewriteRange(doc, { startRel, endRel, replacement: 'NEW LABEL' });
    expect(res.ok).toBe(true);
    expect(run(delta(doc), 'NEW LABEL')?.attributes?.bold).toBe(true);
  });

  it('accepting a suggestion produces what the direct edit produces', () => {
    const source = 'Intro **bold label** trailing';
    const proposed = docFrom(source);
    const r = suggestReplace(proposed, {
      find: 'bold label',
      replace: 'NEW LABEL',
      author: { id: 'a-1', name: 'Agent', color: '#e36f1e' },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(acceptSuggestion(proposed, r.sid).ok).toBe(true);

    const direct = docFrom(source);
    expect(findAndReplace(direct, { find: 'bold label', replace: 'NEW LABEL' }).ok).toBe(true);

    expect(run(delta(proposed), 'NEW LABEL')?.attributes?.bold).toBe(true);
    expect(delta(proposed)).toEqual(delta(direct));
  });
});
