import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createFromOffsets, resolve } from '../src/anchor/text-range.ts';
import { getContent } from '../src/schema.ts';

describe('text-range anchor', () => {
  it('resolves to original offsets when content is unchanged', () => {
    const doc = new Y.Doc();
    const t = getContent(doc);
    t.insert(0, 'The quick brown fox');
    const a = createFromOffsets(t, 4, 9);
    const r = resolve(a, { doc, ytext: t });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.start).toBe(4);
      expect(r.end).toBe(9);
    }
  });

  it('shifts after insertion before the range', () => {
    const doc = new Y.Doc();
    const t = getContent(doc);
    t.insert(0, 'The quick brown fox');
    const a = createFromOffsets(t, 4, 9);
    t.insert(0, 'Once upon a time: ');
    const r = resolve(a, { doc, ytext: t });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(t.toString().slice(r.start, r.end)).toBe('quick');
    }
  });

  it('survives insertion inside the range', () => {
    const doc = new Y.Doc();
    const t = getContent(doc);
    t.insert(0, 'abcdef');
    const a = createFromOffsets(t, 1, 5);
    t.insert(3, 'XYZ');
    const r = resolve(a, { doc, ytext: t });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const slice = t.toString().slice(r.start, r.end);
      expect(slice).toContain('XYZ');
    }
  });

  it('reports deleted when the full range is removed', () => {
    const doc = new Y.Doc();
    const t = getContent(doc);
    t.insert(0, 'abcdef');
    const a = createFromOffsets(t, 1, 5);
    t.delete(0, t.length);
    const r = resolve(a, { doc, ytext: t });
    expect(r.ok).toBe(false);
  });

  it('captures the snippet at creation time', () => {
    const doc = new Y.Doc();
    const t = getContent(doc);
    t.insert(0, 'Hello world');
    const a = createFromOffsets(t, 6, 11);
    expect(a.snippet.text).toBe('world');
  });
});
