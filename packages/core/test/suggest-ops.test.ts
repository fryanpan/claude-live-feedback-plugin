import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  getProseFragment,
  parseMarkdownBlocks,
  serializeFragmentToMarkdown,
} from '../src/prose.ts';
import {
  acceptSuggestion,
  listSuggestions,
  rejectSuggestion,
  resolveAllSuggestions,
  scanSuggestions,
  suggestReplace,
} from '../src/suggest-ops.ts';
import { SUGGEST_DELETE_MARK, SUGGEST_INSERT_MARK, type SuggestionAttrs } from '../src/suggest.ts';

/**
 * Suggestion operations (redline-suggestions phase 2, commit 2): the pure
 * Yjs-level registry + mutations rooms-level tools delegate to.
 *
 * Semantics pinned here:
 *   - suggestReplace mirrors findAndReplace's matching (same single-match
 *     resolution) but writes a PROPOSAL: matched text marked suggestDelete,
 *     replacement inserted with suggestInsert, ONE shared sid — and the
 *     accepted state (serialization) is unchanged by creation.
 *   - accept: strip suggestInsert (text becomes real), delete suggestDelete
 *     text; a block emptied by the deletion is removed entirely (no empty
 *     shell — the find_and_replace empty-shell learnings).
 *   - reject: delete suggestInsert text, strip suggestDelete marks —
 *     restoring EXACTLY the pre-suggestion text.
 *   - missing sid → { ok:false, error:'not-found' } (the correct answer to
 *     the double-accept race).
 */

const author = { id: 'agent-1', name: 'Docs Agent', color: '#7c5cff' };

const sattrs = (sid: string): SuggestionAttrs => ({
  sid,
  authorId: author.id,
  authorName: author.name,
  authorColor: author.color,
  ts: 1754200000000,
});

function docFrom(md: string): Y.Doc {
  const doc = new Y.Doc();
  getProseFragment(doc).push(parseMarkdownBlocks(md));
  return doc;
}

function blockText(doc: Y.Doc, blockIndex: number): Y.XmlText {
  const el = getProseFragment(doc).get(blockIndex) as Y.XmlElement;
  const t = el.toArray()[0];
  if (!(t instanceof Y.XmlText)) throw new Error('block has no text child');
  return t;
}

const serialize = (doc: Y.Doc): string => serializeFragmentToMarkdown(getProseFragment(doc));

describe('suggestReplace (creation primitive)', () => {
  it('creates a replace proposal: one sid, delete+insert marks, serialization unchanged', () => {
    const doc = docFrom('Alpha beta gamma.\n');
    const res = suggestReplace(doc, { find: 'beta', replace: 'delta', author });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(typeof res.sid).toBe('string');
    // Accepted state is untouched by a proposal.
    expect(serialize(doc)).toBe('Alpha beta gamma.\n');
    // Both mark kinds present under the one sid, ts stored as a NUMBER.
    const scan = scanSuggestions(getProseFragment(doc));
    const entry = scan.get(res.sid);
    expect(entry).toBeDefined();
    expect(entry!.ranges.some((r) => r.kind === 'delete' && r.text === 'beta')).toBe(true);
    expect(entry!.ranges.some((r) => r.kind === 'insert' && r.text === 'delta')).toBe(true);
    expect(typeof entry!.attrs.ts).toBe('number');
    expect(entry!.attrs.authorId).toBe('agent-1');
  });

  it('empty replacement creates a pure deletion proposal', () => {
    const doc = docFrom('Alpha beta gamma.\n');
    const res = suggestReplace(doc, { find: ' beta', replace: '', author });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const list = listSuggestions(doc);
    expect(list).toHaveLength(1);
    expect(list[0]!.kind).toBe('delete');
    expect(serialize(doc)).toBe('Alpha beta gamma.\n');
  });

  it('mirrors findAndReplace matching: no-match and ambiguous with candidates', () => {
    const doc = docFrom('Same word here. Same word there.\n');
    const miss = suggestReplace(doc, { find: 'absent', replace: 'x', author });
    expect(miss.ok).toBe(false);
    if (!miss.ok) expect(miss.error).toBe('no-match');
    const ambi = suggestReplace(doc, { find: 'Same word', replace: 'x', author });
    expect(ambi.ok).toBe(false);
    if (!ambi.ok) {
      expect(ambi.error).toBe('ambiguous');
      expect(ambi.candidates?.length).toBe(2);
    }
    // occurrence disambiguates, same as findAndReplace.
    const ok = suggestReplace(doc, {
      find: 'Same word',
      replace: 'That word',
      occurrence: 2,
      author,
    });
    expect(ok.ok).toBe(true);
  });
});

describe('listSuggestions', () => {
  it('reports kind insert/delete/replace with author, snippet, blockContext, ts', () => {
    const doc = docFrom('Alpha beta gamma.\n\nSecond paragraph here.\n');
    // replace via the primitive
    const rep = suggestReplace(doc, { find: 'beta', replace: 'delta', author });
    expect(rep.ok).toBe(true);
    // pure insert, hand-marked (the suggesting input mode's shape)
    blockText(doc, 1).insert('Second'.length, ' extra', { [SUGGEST_INSERT_MARK]: sattrs('ins-1') });
    const list = listSuggestions(doc);
    expect(list).toHaveLength(2);
    const replace = list.find((s) => s.kind === 'replace')!;
    expect(replace.snippet).toContain('beta');
    expect(replace.snippet).toContain('delta');
    expect(replace.author).toEqual({ id: 'agent-1', name: 'Docs Agent', color: '#7c5cff' });
    expect(replace.blockContext).toContain('Alpha');
    expect(typeof replace.ts).toBe('number');
    const insert = list.find((s) => s.kind === 'insert')!;
    expect(insert.sid).toBe('ins-1');
    expect(insert.snippet).toContain('extra');
    expect(insert.blockContext).toContain('Second');
    // Doc order: the replace (first paragraph) sorts before the insert.
    expect(list[0]!.kind).toBe('replace');
  });
});

describe('accept / reject', () => {
  it('accept applies the proposal: inserted text real, deleted text gone, no marks left', () => {
    const doc = docFrom('Alpha beta gamma.\n');
    const res = suggestReplace(doc, { find: 'beta', replace: 'delta', author });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(acceptSuggestion(doc, res.sid)).toEqual({ ok: true });
    expect(serialize(doc)).toBe('Alpha delta gamma.\n');
    expect(scanSuggestions(getProseFragment(doc)).size).toBe(0);
    // The live text (not just the serializer view) reflects the accept.
    const delta = blockText(doc, 0).toDelta() as Array<{ insert?: string }>;
    expect(delta.map((op) => op.insert).join('')).toBe('Alpha delta gamma.');
  });

  it('reject restores exactly the pre-suggestion text, live and serialized', () => {
    const doc = docFrom('Alpha beta gamma.\n');
    const res = suggestReplace(doc, { find: 'beta', replace: 'delta', author });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(rejectSuggestion(doc, res.sid)).toEqual({ ok: true });
    expect(serialize(doc)).toBe('Alpha beta gamma.\n');
    expect(scanSuggestions(getProseFragment(doc)).size).toBe(0);
    const delta = blockText(doc, 0).toDelta() as Array<{
      insert?: string;
      attributes?: Record<string, unknown>;
    }>;
    expect(delta.map((op) => op.insert).join('')).toBe('Alpha beta gamma.');
    expect(delta.every((op) => op.attributes?.[SUGGEST_DELETE_MARK] == null)).toBe(true);
  });

  it('double accept: the second call gets not-found (the double-accept race)', () => {
    const doc = docFrom('Alpha beta gamma.\n');
    const res = suggestReplace(doc, { find: 'beta', replace: 'delta', author });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(acceptSuggestion(doc, res.sid)).toEqual({ ok: true });
    expect(acceptSuggestion(doc, res.sid)).toEqual({ ok: false, error: 'not-found' });
    expect(rejectSuggestion(doc, res.sid)).toEqual({ ok: false, error: 'not-found' });
  });

  it('unknown sid → not-found', () => {
    const doc = docFrom('Alpha.\n');
    expect(acceptSuggestion(doc, 'nope')).toEqual({ ok: false, error: 'not-found' });
    expect(rejectSuggestion(doc, 'nope')).toEqual({ ok: false, error: 'not-found' });
  });

  it('accepting a whole-block deletion removes the block — no empty shell', () => {
    const doc = docFrom('Keep me.\n\nDelete me entirely.\n\nAlso keep.\n');
    const t = blockText(doc, 1);
    doc.transact(() => t.format(0, t.length, { [SUGGEST_DELETE_MARK]: sattrs('wb-del') }));
    expect(acceptSuggestion(doc, 'wb-del')).toEqual({ ok: true });
    expect(getProseFragment(doc).length).toBe(2);
    expect(serialize(doc)).toBe('Keep me.\n\nAlso keep.\n');
  });

  it('accepting a whole-list-item deletion removes the item — no empty "- " marker', () => {
    const doc = docFrom('- first\n- second\n- third\n');
    const list = getProseFragment(doc).get(0) as Y.XmlElement;
    const li = list.toArray()[1] as Y.XmlElement;
    const para = li.toArray()[0] as Y.XmlElement;
    const t = para.toArray()[0] as Y.XmlText;
    doc.transact(() => t.format(0, t.length, { [SUGGEST_DELETE_MARK]: sattrs('li-del') }));
    expect(acceptSuggestion(doc, 'li-del')).toEqual({ ok: true });
    expect(serialize(doc)).toBe('- first\n- third\n');
  });

  it('rejecting a whole-block insertion removes the block — no empty shell', () => {
    const doc = docFrom('Alpha.\n');
    const fragment = getProseFragment(doc);
    const p = new Y.XmlElement('paragraph');
    doc.transact(() => {
      fragment.push([p]);
      const t = new Y.XmlText();
      p.insert(0, [t]);
      t.insert(0, 'Entirely proposed.', { [SUGGEST_INSERT_MARK]: sattrs('wb-ins') });
    });
    expect(rejectSuggestion(doc, 'wb-ins')).toEqual({ ok: true });
    expect(fragment.length).toBe(1);
    expect(serialize(doc)).toBe('Alpha.\n');
  });

  it('accepting a whole-block insertion keeps the block as real content', () => {
    const doc = docFrom('Alpha.\n');
    const fragment = getProseFragment(doc);
    const p = new Y.XmlElement('paragraph');
    doc.transact(() => {
      fragment.push([p]);
      const t = new Y.XmlText();
      p.insert(0, [t]);
      t.insert(0, 'Entirely proposed.', { [SUGGEST_INSERT_MARK]: sattrs('wb-ins2') });
    });
    expect(acceptSuggestion(doc, 'wb-ins2')).toEqual({ ok: true });
    expect(serialize(doc)).toBe('Alpha.\n\nEntirely proposed.\n');
  });

  it('accept/reject only touch their own sid — other proposals survive verbatim', () => {
    const doc = docFrom('Alpha beta gamma.\n\nSecond paragraph here.\n');
    const a = suggestReplace(doc, { find: 'beta', replace: 'delta', author });
    const b = suggestReplace(doc, { find: 'paragraph', replace: 'section', author });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(acceptSuggestion(doc, a.sid)).toEqual({ ok: true });
    const remaining = listSuggestions(doc);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.sid).toBe(b.sid);
    expect(serialize(doc)).toBe('Alpha delta gamma.\n\nSecond paragraph here.\n');
    expect(rejectSuggestion(doc, b.sid)).toEqual({ ok: true });
    expect(serialize(doc)).toBe('Alpha delta gamma.\n\nSecond paragraph here.\n');
  });
});

describe('resolveAllSuggestions', () => {
  it('accept-all applies every pending proposal', () => {
    const doc = docFrom('Alpha beta gamma.\n\nSecond paragraph here.\n');
    const a = suggestReplace(doc, { find: 'beta', replace: 'delta', author });
    const b = suggestReplace(doc, { find: 'paragraph', replace: 'section', author });
    expect(a.ok && b.ok).toBe(true);
    const res = resolveAllSuggestions(doc, { action: 'accept' });
    expect(res.resolved).toBe(2);
    expect(serialize(doc)).toBe('Alpha delta gamma.\n\nSecond section here.\n');
    expect(listSuggestions(doc)).toHaveLength(0);
  });

  it('authorId filter resolves only that author, leaving others pending', () => {
    const other = { id: 'human-1', name: 'Bryan', color: '#00aa55' };
    const doc = docFrom('Alpha beta gamma.\n\nSecond paragraph here.\n');
    const a = suggestReplace(doc, { find: 'beta', replace: 'delta', author });
    const b = suggestReplace(doc, { find: 'paragraph', replace: 'section', author: other });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    const res = resolveAllSuggestions(doc, { action: 'reject', authorId: 'agent-1' });
    expect(res.resolved).toBe(1);
    const remaining = listSuggestions(doc);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.sid).toBe(b.sid);
    expect(serialize(doc)).toBe('Alpha beta gamma.\n\nSecond paragraph here.\n');
  });

  it('no matching suggestions → resolved 0, doc untouched', () => {
    const doc = docFrom('Alpha.\n');
    expect(resolveAllSuggestions(doc, { action: 'accept' }).resolved).toBe(0);
    expect(serialize(doc)).toBe('Alpha.\n');
  });
});
