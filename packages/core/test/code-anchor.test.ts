import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { autoReanchorCodeDoc } from '../src/prose.ts';
import { getContent } from '../src/schema.ts';

/**
 * Seed a code doc: raw source in the flat `content` Y.Text, with a single
 * text-range thread anchored to a byte range. Mirrors how the read-only
 * code surface (markdown-app/src/code/code-editor.ts) builds anchors.
 */
function seedCodeDoc(source: string): { doc: Y.Doc; content: Y.Text } {
  const doc = new Y.Doc();
  const content = getContent(doc);
  content.insert(0, source);
  return { doc, content };
}

function anchorThread(
  doc: Y.Doc,
  content: Y.Text,
  from: number,
  to: number,
  snippet: string,
): void {
  const threads = doc.getMap('threads') as Y.Map<Y.Map<unknown>>;
  const t = new Y.Map<unknown>();
  t.set('anchor', {
    kind: 'text-range',
    startRel: Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(content, from)),
    endRel: Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(content, to)),
    snippet: { text: snippet },
  });
  threads.set('t1', t);
}

describe('autoReanchorCodeDoc', () => {
  it('recovers a thread by snippet after the content Y.Text is rebuilt', () => {
    const src = 'const a = 1;\nconst answer = 42;\nconst b = 2;\n';
    const { doc, content } = seedCodeDoc(src);
    const from = src.indexOf('const answer');
    const to = from + 'const answer = 42;'.length;
    anchorThread(doc, content, from, to, 'const answer = 42;');

    // Destructive re-render: wipe + reinsert the same source (what the
    // server does on a disk→doc reconcile). Old relative positions orphan.
    doc.transact(() => {
      content.delete(0, content.length);
      content.insert(0, src);
    });
    // A flat Y.Text relative position still "resolves" after delete+reinsert
    // (it clamps to an index), so the orphan signal is that the spanned text
    // no longer equals the snippet — autoReanchorCodeDoc detects exactly that.
    const summary = autoReanchorCodeDoc(doc);
    expect(summary.reanchored).toBe(1);
    expect(summary.stillOrphan).toBe(0);

    const after = (doc.getMap('threads').get('t1') as Y.Map<unknown>).get('anchor') as {
      kind: string;
      startRel: Uint8Array;
      endRel: Uint8Array;
    };
    expect(after.kind).toBe('text-range');
    // The rebuilt anchor must span the snippet at its new location.
    const a = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(after.startRel),
      doc,
    );
    const b = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(after.endRel),
      doc,
    );
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(content.toString().slice(a?.index, b?.index)).toBe('const answer = 42;');
  });

  it('orphans a thread when the snippet appears multiple times', () => {
    const src = 'foo();\nbar();\nfoo();\n';
    const { doc, content } = seedCodeDoc(src);
    anchorThread(doc, content, 0, 6, 'foo();');
    doc.transact(() => {
      content.delete(0, content.length);
      content.insert(0, src);
    });

    const summary = autoReanchorCodeDoc(doc);
    expect(summary.reanchored).toBe(0);
    expect(summary.stillOrphan).toBe(1);
    const anchor = (doc.getMap('threads').get('t1') as Y.Map<unknown>).get('anchor') as {
      kind: string;
    };
    expect(anchor.kind).toBe('orphan');
  });

  it('orphans a thread when the snippet no longer appears', () => {
    const { doc, content } = seedCodeDoc('let x = 1;\n');
    anchorThread(doc, content, 0, 9, 'let x = 1;');
    doc.transact(() => {
      content.delete(0, content.length);
      content.insert(0, 'let y = 2;\n');
    });

    const summary = autoReanchorCodeDoc(doc);
    expect(summary.reanchored).toBe(0);
    expect(summary.stillOrphan).toBe(1);
  });

  it('leaves still-resolving threads untouched (idempotent)', () => {
    const { doc, content } = seedCodeDoc('alpha\nbeta\ngamma\n');
    anchorThread(doc, content, 6, 10, 'beta');
    const summary = autoReanchorCodeDoc(doc);
    expect(summary.checked).toBe(1);
    expect(summary.reanchored).toBe(0);
    expect(summary.stillOrphan).toBe(0);
  });
});
