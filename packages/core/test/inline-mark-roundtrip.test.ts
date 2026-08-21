import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  getProseFragment,
  inlineMarksToDelta,
  normalizeMarkdown,
  parseMarkdownBlocks,
  serializeFragmentToMarkdown,
} from '../src/prose.ts';

/**
 * Inline marks must round-trip BYTE-IDENTICAL through parse → Yjs → serialize,
 * AND parse to the shape a reader means.
 *
 * The serializer used to wrap each Yjs delta op independently, so a bold run
 * containing a nested span (code, italic, link) with text on either side came
 * back as `**A ****plus**** B**` — bold closed before the nested span,
 * re-opened after it, and the delimiters doubled up into runs of four or five
 * asterisks. The same function writes bound files back to disk, so this was
 * corruption of user source, not cosmetics.
 *
 * Every fixture is checked two ways. `normalizeMarkdown(md) === md` alone is
 * not enough: `**lead *tail***` was ALREADY a fixed point before the fix,
 * because the parser stopped the bold one character early and emitted the
 * stray `*` as literal text — same bytes, italic lost. So each fixture also
 * pins the delta the parser must produce (text + mark set per op).
 */
type Op = [string, Record<string, unknown> | undefined];
const B = { bold: true };
const I = { italic: true };
const BI = { bold: true, italic: true };
const C = { code: true };
const BC = { bold: true, code: true };
const S = { strike: true };
const SB = { strike: true, bold: true };
const L = (href: string) => ({ link: { href } });

const CASES: Array<{ name: string; md: string; ops: Op[] }> = [
  {
    // Positive control: a bold run wrapping a nested span with NO adjacent
    // text always round-tripped — it is here so a serializer that emits
    // nothing at all cannot pass this file.
    name: 'bold wrapping only code (control)',
    md: 'the combined status reads **`pending`** rather than absent',
    ops: [
      ['the combined status reads ', undefined],
      ['pending', BC],
      [' rather than absent', undefined],
    ],
  },
  {
    // Measured in the field, verbatim.
    name: 'bold run with code then adjacent text (list item)',
    md: '- `commits/61e75e5/status` → **`state: "pending"`, 0 statuses**',
    ops: [
      ['commits/61e75e5/status', C],
      [' → ', undefined],
      ['state: "pending"', BC],
      [', 0 statuses', B],
    ],
  },
  {
    // Measured in the field, verbatim.
    name: 'bold run with italic between adjacent text',
    md: '**A bold run that spans an inline-code span *plus* adjacent text.**',
    ops: [
      ['A bold run that spans an inline-code span ', B],
      ['plus', BI],
      [' adjacent text.', B],
    ],
  },
  {
    name: 'bold run with code between adjacent text',
    md: '**before `code` after**',
    ops: [
      ['before ', B],
      ['code', BC],
      [' after', B],
    ],
  },
  {
    name: 'bold run ending in italic',
    md: '**lead *tail***',
    ops: [
      ['lead ', B],
      ['tail', BI],
    ],
  },
  {
    name: 'bold run starting with italic',
    md: '***head* rest**',
    ops: [
      ['head', BI],
      [' rest', B],
    ],
  },
  { name: 'bold and italic over the same span', md: '***both***', ops: [['both', BI]] },
  {
    name: 'italic run with bold inside',
    md: '*a **b** c*',
    ops: [
      ['a ', I],
      ['b', BI],
      [' c', I],
    ],
  },
  {
    name: 'italic run ending in bold',
    md: '*a **b***',
    ops: [
      ['a ', I],
      ['b', BI],
    ],
  },
  {
    name: 'italic then bold, no space',
    md: '*a***b**',
    ops: [
      ['a', I],
      ['b', B],
    ],
  },
  {
    name: 'bold run with link inside',
    md: '**see [the doc](https://x.example) for detail**',
    ops: [
      ['see ', B],
      ['the doc', { ...B, ...L('https://x.example') }],
      [' for detail', B],
    ],
  },
  {
    name: 'strike over bold and plain',
    md: '~~gone **loud** quiet~~',
    ops: [
      ['gone ', S],
      ['loud', SB],
      [' quiet', S],
    ],
  },
  {
    name: 'code inside bold inside a heading',
    md: '## Status: **`pending` still**',
    ops: [
      ['Status: ', undefined],
      ['pending', BC],
      [' still', B],
    ],
  },
  {
    name: 'two separate bold runs',
    md: '**one** and **two**',
    ops: [
      ['one', B],
      [' and ', undefined],
      ['two', B],
    ],
  },
  {
    name: 'adjacent bold then plain',
    md: '**word** next',
    ops: [
      ['word', B],
      [' next', undefined],
    ],
  },
  {
    // Link is the OUTERMOST mark on serialize, so a bold link is emitted as
    // `[**b**](u)`; the parser reads the label recursively so that is a real
    // bold+link, not a link whose text is literally `**b**`.
    name: 'link then bold link',
    md: '[a](https://x.example) [**b**](https://y.example)',
    ops: [
      ['a', L('https://x.example')],
      [' ', undefined],
      ['b', { ...B, ...L('https://y.example') }],
    ],
  },
  {
    // A close-then-reopen boundary whose glued asterisk run would reach 4
    // (`***both****ital*`) switches the reopened mark to its underscore
    // form — a 4-run is ambiguous and the marks died in it.
    name: 'bold+italic then italic, no space',
    md: '***both***_ital_',
    ops: [
      ['both', BI],
      ['ital', I],
    ],
  },
  {
    name: 'bold then bold+italic then italic, no space',
    md: '**a*b***_c_',
    ops: [
      ['a', B],
      ['b', BI],
      ['c', I],
    ],
  },
  {
    // The 5-run shape: closing bold+italic then reopening bold glued into
    // `*****` before the fix.
    name: 'italic then italic+bold then bold, no space',
    md: '*a**b***__c__',
    ops: [
      ['a', I],
      ['b', BI],
      ['c', B],
    ],
  },
];

// Parse-shape only: the serializer normalizes `_x_` to `*x*`, so these are not
// fixed points, but what they MEAN must survive.
const PARSE_ONLY: Array<{ name: string; md: string; ops: Op[] }> = [
  {
    // snake_case inside an underscore-emphasised span is not a delimiter.
    name: 'underscore italic around a snake_case word',
    md: '_use the_field name_',
    ops: [['use the_field name', I]],
  },
  {
    name: 'underscore bold',
    md: '__b__ x',
    ops: [
      ['b', B],
      [' x', undefined],
    ],
  },
  {
    // Glued delimiter runs a pre-fix serializer emitted (and any external
    // markdown may contain): the 4-run closes bold+italic and opens italic.
    name: 'glued 4-run: bold+italic then italic',
    md: '***both****ital*',
    ops: [
      ['both', BI],
      ['ital', I],
    ],
  },
  {
    // The 5-run from the field: closes bold+italic, reopens bold.
    name: 'glued 5-run: italic, italic+bold, bold',
    md: '*a**b*****c**',
    ops: [
      ['a', I],
      ['b', BI],
      ['c', B],
    ],
  },
];

function parsedOps(md: string): Op[] {
  const doc = new Y.Doc();
  try {
    const frag = getProseFragment(doc);
    frag.push(parseMarkdownBlocks(md));
    const block = frag.get(0) as Y.XmlElement;
    // list item → paragraph → text; heading/paragraph → text
    let el: Y.XmlElement = block;
    while (el.get(0) instanceof Y.XmlElement) el = el.get(0) as Y.XmlElement;
    const text = el.get(0) as Y.XmlText;
    const delta = text.toDelta() as Array<{ insert: string; attributes?: Record<string, unknown> }>;
    return delta.map((d) => [d.insert, d.attributes]);
  } finally {
    doc.destroy();
  }
}

describe('inline marks round-trip byte-identical AND parse to the meant shape', () => {
  for (const { name, md, ops } of CASES) {
    it(`${name}: fixed point`, () => {
      expect(normalizeMarkdown(`${md}\n`)).toBe(`${md}\n`);
    });
    it(`${name}: parsed shape`, () => {
      expect(parsedOps(md)).toEqual(ops);
    });
  }

  for (const { name, md, ops } of PARSE_ONLY) {
    it(`${name}: parsed shape`, () => {
      expect(parsedOps(md)).toEqual(ops);
    });
    it(`${name}: normalizes to a fixed point`, () => {
      const once = normalizeMarkdown(`${md}\n`);
      expect(normalizeMarkdown(once)).toBe(once);
      expect(parsedOps(once.trimEnd())).toEqual(ops);
    });
  }

  it('never emits a run of four or more delimiters the input did not have', () => {
    for (const { md } of CASES) {
      const out = normalizeMarkdown(`${md}\n`);
      expect(out).not.toMatch(/\*{4,}/);
      expect(out).not.toMatch(/~{3,}/);
    }
  });

  it('inlineMarksToDelta parses a link label recursively', () => {
    expect(inlineMarksToDelta('[`code`](https://x.example)')).toEqual([
      { insert: 'code', attributes: { code: true, link: { href: 'https://x.example' } } },
    ]);
  });

  it('serializes an editor-shaped delta (marks as a set, no nesting order) without doubling', () => {
    // A human typing in Tiptap produces ops whose attribute SETS overlap; the
    // Yjs delta has no notion of which mark is "outer". Build that shape by
    // hand rather than through the parser so the serializer is exercised on
    // input the parser could not have produced in that order.
    const doc = new Y.Doc();
    const frag = getProseFragment(doc);
    const p = new Y.XmlElement('paragraph');
    const t = new Y.XmlText();
    p.insert(0, [t]);
    frag.push([p]);
    t.applyDelta([
      { insert: 'plain ' },
      { insert: 'bold ', attributes: { bold: true } },
      { insert: 'both', attributes: { bold: true, italic: true } },
      { insert: ' ital', attributes: { italic: true } },
      { insert: ' end' },
    ]);
    const out = serializeFragmentToMarkdown(frag);
    // bold closes before italic can continue alone, so italic is closed and
    // reopened AFTER the space it would otherwise open in front of — never
    // `**bold ****both**** ital*`, and never `*** ital*`.
    expect(out).toBe('plain **bold *both*** *ital* end\n');
    // And that output reads back as the same three marked runs.
    expect(parsedOps(out)).toEqual([
      ['plain ', undefined],
      ['bold ', B],
      ['both', BI],
      [' ', undefined],
      ['ital', I],
      [' end', undefined],
    ]);
    doc.destroy();
  });

  function serializeOps(ops: Array<{ insert: string; attributes?: Record<string, unknown> }>) {
    const doc = new Y.Doc();
    try {
      const frag = getProseFragment(doc);
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      p.insert(0, [t]);
      frag.push([p]);
      t.applyDelta(ops);
      return serializeFragmentToMarkdown(frag);
    } finally {
      doc.destroy();
    }
  }

  it('moves whitespace at an emphasis edge outside the delimiters (editor bolds a trailing space)', () => {
    // `**word **next` is not bold in CommonMark, and `*word *next` is not
    // italic even in this file's own parser. The delimiter lands on the word.
    expect(serializeOps([{ insert: 'word ', attributes: B }, { insert: 'next' }])).toBe(
      '**word** next\n',
    );
    expect(serializeOps([{ insert: 'a' }, { insert: ' word', attributes: I }])).toBe('a *word*\n');
    // A whitespace-only op between two bold ops keeps the run continuous.
    expect(
      serializeOps([
        { insert: 'a', attributes: B },
        { insert: ' ', attributes: BI },
        { insert: 'b', attributes: B },
      ]),
    ).toBe('**a b**\n');
    // Whitespace-only op whose neighbours share nothing: emitted plain.
    expect(
      serializeOps([
        { insert: 'a', attributes: B },
        { insert: ' ', attributes: B },
        { insert: 'b' },
      ]),
    ).toBe('**a** b\n');
    // Code keeps its whitespace — it is significant there.
    expect(serializeOps([{ insert: ' x ', attributes: C }])).toBe('` x `\n');
  });

  it('a close-then-reopen boundary never glues an ambiguous 4+ asterisk run (t-N8fCcpqZdJBp)', () => {
    // Bold emphasis meeting adjacent asterisk delimiters used to serialize as
    // literal ****/***** runs the parser could not read back, so the marks
    // died on the round trip. The reopened mark switches to its underscore
    // form instead.
    const shapes: Array<{
      ops: Array<{ insert: string; attributes?: Record<string, unknown> }>;
      expected: string;
    }> = [
      {
        ops: [
          { insert: 'both', attributes: BI },
          { insert: 'ital', attributes: I },
        ],
        expected: '***both***_ital_\n',
      },
      {
        ops: [
          { insert: 'a', attributes: B },
          { insert: 'b', attributes: BI },
          { insert: 'c', attributes: I },
        ],
        expected: '**a*b***_c_\n',
      },
      {
        // The 5-run shape measured in a task body.
        ops: [
          { insert: 'a', attributes: I },
          { insert: 'b', attributes: BI },
          { insert: 'c', attributes: B },
        ],
        expected: '*a**b***__c__\n',
      },
    ];
    for (const { ops, expected } of shapes) {
      const out = serializeOps(ops);
      expect(out).toBe(expected);
      expect(out).not.toMatch(/\*{4,}/);
      // And the marks survive the round trip.
      expect(parsedOps(out.trimEnd())).toEqual(ops.map((o) => [o.insert, o.attributes]));
      expect(normalizeMarkdown(out)).toBe(out);
    }
  });

  it('falls back to a glued run the parser CAN read when underscore cannot close there', () => {
    // `_ital_x` is not emphasis (underscore cannot close against a word
    // character), so this shape keeps asterisk delimiters — and the parser
    // reads the glued run instead of dropping the marks.
    const ops = [
      { insert: 'both', attributes: BI },
      { insert: 'ital', attributes: I },
      { insert: 'x' },
    ];
    const out = serializeOps(ops);
    expect(out).toBe('***both****ital*x\n');
    expect(parsedOps(out.trimEnd())).toEqual([
      ['both', BI],
      ['ital', I],
      ['x', undefined],
    ]);
    expect(normalizeMarkdown(out)).toBe(out);
  });

  it('two adjacent links with different hrefs stay two links', () => {
    const doc = new Y.Doc();
    const frag = getProseFragment(doc);
    const p = new Y.XmlElement('paragraph');
    const t = new Y.XmlText();
    p.insert(0, [t]);
    frag.push([p]);
    t.applyDelta([
      { insert: 'a', attributes: { link: { href: 'https://x.example' } } },
      { insert: 'b', attributes: { link: { href: 'https://y.example' } } },
    ]);
    expect(serializeFragmentToMarkdown(frag)).toBe(
      '[a](https://x.example)[b](https://y.example)\n',
    );
    doc.destroy();
  });
});

describe('fenced code inside a list item survives the round-trip', () => {
  const md = [
    '- item with code:',
    '',
    '  ```ts',
    '  const a = 1;',
    '  const b = 2;',
    '  ```',
    '- next item',
    '',
  ].join('\n');
  it('is a fixed point (not flattened onto one line)', () => {
    expect(normalizeMarkdown(md)).toBe(md);
  });
  it('parses to a codeBlock child of the list item, language kept', () => {
    const doc = new Y.Doc();
    const frag = getProseFragment(doc);
    frag.push(parseMarkdownBlocks(md));
    const list = frag.get(0) as Y.XmlElement;
    const li = list.get(0) as Y.XmlElement;
    const cb = li.get(1) as Y.XmlElement;
    expect(cb.nodeName).toBe('codeBlock');
    expect(cb.getAttribute('language')).toBe('ts');
    expect((cb.get(0) as Y.XmlText).toString()).toBe('const a = 1;\nconst b = 2;');
    expect(list.length).toBe(2);
    doc.destroy();
  });
});
