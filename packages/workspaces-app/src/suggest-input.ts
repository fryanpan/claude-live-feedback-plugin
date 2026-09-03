import { SUGGEST_DELETE_MARK, SUGGEST_INSERT_MARK, type SuggestionAttrs } from '@feedback/core';
import { Extension } from '@tiptap/core';
import type { MarkType, Node as PMNode, Slice } from '@tiptap/pm/model';
import {
  type EditorState,
  Plugin,
  PluginKey,
  TextSelection,
  type Transaction,
} from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { ySyncPluginKey } from '@tiptap/y-tiptap';

/**
 * The Suggesting INPUT mode (redlining Phase 2). While ON, this plugin
 * rewrites the human's input so nothing they do is a direct edit:
 *
 * - typed text is inserted carrying `suggestInsert` (the serializer omits it
 *   from disk until accepted — the commit-1 accepted-state rule);
 * - Backspace/Delete/cut over existing text MARK it `suggestDelete` instead
 *   of removing it (the text keeps serializing until accepted);
 * - typing over a selection is a REPLACE: one sid spanning the marked-deleted
 *   selection plus the inserted text;
 * - input that already carries suggestion marks is NOT re-intercepted:
 *   deleting pending `suggestInsert` text really deletes it (shrinking the
 *   proposal), and Backspace/Delete over already-`suggestDelete` text just
 *   steps the caret past it;
 * - paste is intercepted (`handlePaste`): the selection is marked deleted and
 *   the slice's text inserted as a flattened `suggestInsert` proposal under
 *   one sid — the default `replaceSelection` would REALLY delete the
 *   selected accepted text and a multi-block slice would split the host
 *   block. Drops are suppressed outright (a drag-move deletes its source for
 *   real; a "move" has no mark-model representation);
 * - IME composition bypasses `handleTextInput`, so an appended-transaction
 *   backstop marks any UNMARKED text a local transaction inserted. Remote
 *   (Yjs/agent/undo) transactions carry the ySync meta and are never
 *   rewritten;
 * - Enter is suppressed: a block split cannot be represented as a text mark
 *   and would leak a structural direct edit to disk, violating proposal
 *   isolation. (Whole-block proposals arrive via the agent tools / commit-5
 *   chrome instead.)
 *
 * With the mode OFF the plugin still does one thing: it strips suggestion
 * marks that default input INHERITED by typing inside a pending span, so a
 * normal-mode keystroke is always a direct edit (see appendBackstop).
 *
 * A contiguous burst of typing (or of backspaces) shares one sid — one
 * proposal per gesture, matching how the agent-side `suggestReplace` groups a
 * replace under a single sid. Attrs are identical across all ranges of a sid
 * (the suggest-ops scanner takes attrs from the first range it sees).
 */

export interface SuggestAuthor {
  id: string;
  name: string;
  color: string;
}

interface Burst {
  sid: string;
  /** Creation ts for the sid — reused for every range so attrs stay identical. */
  ts: number;
  from: number;
  to: number;
}

interface SuggestInputState {
  on: boolean;
  author: SuggestAuthor | null;
  burst: Burst | null;
}

interface SuggestInputMeta {
  /** Mode change from the toolbar toggle. */
  mode?: { on: boolean; author?: SuggestAuthor | null };
  /** Set by our own transactions: the burst after this change (or null). */
  burst?: Burst | null;
  /** Marks a transaction this plugin produced — the backstop skips it. */
  handled?: boolean;
}

export const suggestInputKey = new PluginKey<SuggestInputState>('lfSuggestInput');

/** Toggle Suggesting mode on a live editor view (identity travels with it). */
export function setSuggesting(
  view: EditorView,
  opts: { on: boolean; author?: SuggestAuthor | null },
): void {
  view.dispatch(view.state.tr.setMeta(suggestInputKey, { mode: opts } satisfies SuggestInputMeta));
}

export function isSuggesting(state: EditorState): boolean {
  return suggestInputKey.getState(state)?.on ?? false;
}

// --- per-doc persistence (localStorage is already per-browser = per-user) ---

const PREF_KEY = (docId: string) => `lf:suggest-mode:${docId}`;

export function readSuggestModePref(docId: string): boolean {
  try {
    return localStorage.getItem(PREF_KEY(docId)) === 'on';
  } catch {
    return false;
  }
}

export function writeSuggestModePref(docId: string, on: boolean): void {
  try {
    localStorage.setItem(PREF_KEY(docId), on ? 'on' : 'off');
  } catch {
    // localStorage disabled (private mode) — the toggle still works in-session.
  }
}

// --- sid + attrs ---

let sidCounter = 0;

/** Same shape as suggest-ops' newSid so human and agent sids are uniform. */
function newSid(): string {
  sidCounter = (sidCounter + 1) % 36 ** 4;
  return `s-${Date.now().toString(36)}-${sidCounter.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

/** Attribute types are load-bearing (the Yjs heading-level learnings): four
 *  strings + a NUMBER ts, exactly what every reader expects. */
function attrsFor(author: SuggestAuthor, sid: string, ts: number): SuggestionAttrs {
  return { sid, authorId: author.id, authorName: author.name, authorColor: author.color, ts };
}

function markTypes(state: EditorState): { ins: MarkType; del: MarkType } | null {
  const ins = state.schema.marks[SUGGEST_INSERT_MARK];
  const del = state.schema.marks[SUGGEST_DELETE_MARK];
  return ins && del ? { ins, del } : null;
}

// --- segment scanning ---

type SegKind = 'ins' | 'del' | 'plain';

interface Seg {
  from: number;
  to: number;
  kind: SegKind;
}

function collectSegments(
  doc: PMNode,
  from: number,
  to: number,
  types: { ins: MarkType; del: MarkType },
): Seg[] {
  const segs: Seg[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return true;
    const f = Math.max(from, pos);
    const t = Math.min(to, pos + node.nodeSize);
    if (t <= f) return false;
    const kind: SegKind = types.ins.isInSet(node.marks)
      ? 'ins'
      : types.del.isInSet(node.marks)
        ? 'del'
        : 'plain';
    segs.push({ from: f, to: t, kind });
    return false;
  });
  return segs;
}

/**
 * "Delete" a range in Suggesting terms: pending-insert segments are REALLY
 * deleted (removing proposed text is just shrinking the proposal), plain
 * segments get the suggestDelete mark, already-marked-deleted segments are
 * left alone. Applied in reverse doc order so deletions don't shift the
 * earlier segment positions.
 */
function markRangeDeleted(
  tr: Transaction,
  from: number,
  to: number,
  attrs: SuggestionAttrs,
  types: { ins: MarkType; del: MarkType },
): void {
  const segs = collectSegments(tr.doc, from, to, types);
  for (const seg of segs.reverse()) {
    if (seg.kind === 'ins') tr.delete(seg.from, seg.to);
    else if (seg.kind === 'plain') tr.addMark(seg.from, seg.to, types.del.create(attrs));
  }
}

// --- input handlers ---

function handleTextInput(view: EditorView, from: number, to: number, text: string): boolean {
  const st = suggestInputKey.getState(view.state);
  if (!st?.on || !st.author) return false;
  // Let composition commit normally; the appended-transaction backstop marks
  // the committed span afterwards (the safe IME fallback).
  if (view.composing) return false;
  const types = markTypes(view.state);
  if (!types) return false;
  const $from = view.state.doc.resolve(from);
  // Contexts that don't allow the mark (code blocks) stay direct edits —
  // inserting disallowed marks would corrupt the doc.
  if (!$from.parent.type.allowsMarkType(types.ins)) return false;

  const replacing = to > from;
  const contiguous = !replacing && st.burst !== null && from === st.burst.to;
  const sid = contiguous && st.burst ? st.burst.sid : newSid();
  const ts = contiguous && st.burst ? st.burst.ts : Date.now();
  const attrs = attrsFor(st.author, sid, ts);

  const tr = view.state.tr;
  if (replacing) markRangeDeleted(tr, from, to, attrs, types);
  const insPos = tr.mapping.map(to, -1);
  tr.insert(insPos, view.state.schema.text(text, [types.ins.create(attrs)]));
  const end = insPos + text.length;
  tr.setSelection(TextSelection.create(tr.doc, end));
  tr.setMeta(suggestInputKey, {
    handled: true,
    burst: { sid, ts, from: insPos, to: end },
  } satisfies SuggestInputMeta);
  view.dispatch(tr.scrollIntoView());
  return true;
}

function handleDeleteKey(view: EditorView, forward: boolean): boolean {
  const st = suggestInputKey.getState(view.state);
  if (!st?.on || !st.author) return false;
  const types = markTypes(view.state);
  if (!types) return false;
  const sel = view.state.selection;

  // Range selection: mark the whole selection deleted, collapse to its end so
  // continued typing forms a replace under the same sid.
  if (!sel.empty) {
    const sid = newSid();
    const ts = Date.now();
    const attrs = attrsFor(st.author, sid, ts);
    const tr = view.state.tr;
    markRangeDeleted(tr, sel.from, sel.to, attrs, types);
    const from = tr.mapping.map(sel.from, -1);
    const to = tr.mapping.map(sel.to, -1);
    tr.setSelection(TextSelection.create(tr.doc, to));
    tr.setMeta(suggestInputKey, {
      handled: true,
      burst: { sid, ts, from, to },
    } satisfies SuggestInputMeta);
    view.dispatch(tr.scrollIntoView());
    return true;
  }

  const pos = sel.from;
  const $pos = view.state.doc.resolve(pos);
  if (!$pos.parent.type.allowsMarkType(types.del)) return false; // code block: direct edit
  // Block boundary: a join/split cannot be represented as a text mark and
  // would leak a structural direct edit to disk. Suppress it.
  if (!forward && $pos.parentOffset === 0) return true;
  if (forward && $pos.parentOffset === $pos.parent.content.size) return true;

  const target = forward ? { from: pos, to: pos + 1 } : { from: pos - 1, to: pos };
  const seg = collectSegments(view.state.doc, target.from, target.to, types)[0];
  if (!seg) return true;
  // Pending insert: not intercepted — the default keymap really deletes it.
  if (seg.kind === 'ins') return false;
  // Already proposed for deletion: step the caret past it, change nothing.
  if (seg.kind === 'del') {
    const tr = view.state.tr;
    tr.setSelection(TextSelection.create(tr.doc, forward ? target.to : target.from));
    view.dispatch(tr);
    return true;
  }

  const contiguous =
    st.burst !== null && (forward ? target.from === st.burst.to : target.to === st.burst.from);
  const sid = contiguous && st.burst ? st.burst.sid : newSid();
  const ts = contiguous && st.burst ? st.burst.ts : Date.now();
  const burst: Burst =
    contiguous && st.burst
      ? {
          sid,
          ts,
          from: Math.min(target.from, st.burst.from),
          to: Math.max(target.to, st.burst.to),
        }
      : { sid, ts, from: target.from, to: target.to };
  const tr = view.state.tr;
  tr.addMark(target.from, target.to, types.del.create(attrsFor(st.author, sid, ts)));
  tr.setSelection(TextSelection.create(tr.doc, forward ? target.to : target.from));
  tr.setMeta(suggestInputKey, { handled: true, burst } satisfies SuggestInputMeta);
  view.dispatch(tr.scrollIntoView());
  return true;
}

function handleKeyDown(view: EditorView, event: KeyboardEvent): boolean {
  const st = suggestInputKey.getState(view.state);
  if (!st?.on || !st.author) return false;
  if (event.key === 'Backspace') return handleDeleteKey(view, false);
  if (event.key === 'Delete') return handleDeleteKey(view, true);
  if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) {
    // Block splits can't be proposals in the mark model — suppress rather
    // than leak a structural direct edit to disk (proposal isolation).
    // Contexts that don't take suggestion marks (code blocks) stay direct.
    const types = markTypes(view.state);
    if (!types) return false;
    return view.state.selection.$from.parent.type.allowsMarkType(types.ins);
  }
  return false;
}

/** The `cut` DOM handler: copy the selection to the clipboard, then mark it
 *  deleted instead of removing it. Exported for direct testing. */
export function handleSuggestCut(view: EditorView, event: ClipboardEvent): boolean {
  const st = suggestInputKey.getState(view.state);
  if (!st?.on || !st.author) return false;
  const sel = view.state.selection;
  if (sel.empty) return false;
  event.preventDefault();
  event.clipboardData?.setData('text/plain', view.state.doc.textBetween(sel.from, sel.to, '\n'));
  return handleDeleteKey(view, false);
}

/**
 * The paste handler. Without it, pasting over a non-empty selection runs
 * ProseMirror's default `replaceSelection`, which REALLY deletes the selected
 * accepted text — the appended-transaction backstop can only mark insertions,
 * it cannot un-delete, so the deletion would flush to disk as a direct edit
 * (and rejecting the resulting "suggestion" would remove the pasted text too,
 * restoring neither side). A multi-block paste would additionally split the
 * host block — a structural direct edit, same leak Enter suppression closes.
 *
 * So: route the selection through markRangeDeleted and insert the slice's
 * text FLATTENED (block breaks become spaces — block splits can't be
 * proposals in the mark model), all under one sid, mirroring how typing over
 * a selection forms a replace. Exported for direct testing.
 */
export function handleSuggestPaste(
  view: EditorView,
  _event: ClipboardEvent,
  slice: Slice,
): boolean {
  const st = suggestInputKey.getState(view.state);
  if (!st?.on || !st.author) return false;
  const types = markTypes(view.state);
  if (!types) return false;
  const sel = view.state.selection;
  // Contexts that don't allow the mark (code blocks) stay direct edits.
  if (!view.state.doc.resolve(sel.from).parent.type.allowsMarkType(types.ins)) return false;
  const text = slice.content.textBetween(0, slice.content.size, ' ', ' ');
  // Nothing textual to propose and nothing selected: swallow the paste rather
  // than let a node-only slice land as a direct structural edit.
  if (text.length === 0 && sel.empty) return true;

  const sid = newSid();
  const ts = Date.now();
  const attrs = attrsFor(st.author, sid, ts);
  const tr = view.state.tr;
  if (!sel.empty) markRangeDeleted(tr, sel.from, sel.to, attrs, types);
  const insPos = tr.mapping.map(sel.to, -1);
  if (text.length > 0) tr.insert(insPos, view.state.schema.text(text, [types.ins.create(attrs)]));
  const end = insPos + text.length;
  tr.setSelection(TextSelection.create(tr.doc, end));
  tr.setMeta(suggestInputKey, {
    handled: true,
    burst: { sid, ts, from: insPos, to: end },
  } satisfies SuggestInputMeta);
  view.dispatch(tr.scrollIntoView());
  return true;
}

/** Drops are suppressed while Suggesting: an internal drag-move deletes the
 *  dragged text at its source FOR REAL (the backstop cannot un-delete), and a
 *  "move" has no clean representation in the mark model. Blocking the gesture
 *  beats leaking a destructive direct edit to disk. */
function handleSuggestDrop(view: EditorView): boolean {
  const st = suggestInputKey.getState(view.state);
  return !!(st?.on && st.author);
}

// --- appended-transaction backstop (IME commits, paste, programmatic input) ---

function insertedRanges(tr: Transaction): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  tr.mapping.maps.forEach((map, i) => {
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      if (newEnd <= newStart) return;
      const rest = tr.mapping.slice(i + 1);
      const from = rest.map(newStart, 1);
      const to = rest.map(newEnd, -1);
      if (to > from) ranges.push({ from, to });
    });
  });
  return ranges;
}

function appendBackstop(trs: readonly Transaction[], newState: EditorState): Transaction | null {
  const st = suggestInputKey.getState(newState);
  const types = markTypes(newState);
  if (!types) return null;

  let ranges: Array<{ from: number; to: number }> = [];
  for (const tr of trs) {
    if (!tr.docChanged) continue;
    // Map ranges found in earlier transactions through this one.
    ranges = ranges.map((r) => ({ from: tr.mapping.map(r.from, 1), to: tr.mapping.map(r.to, -1) }));
    const meta = tr.getMeta(suggestInputKey) as SuggestInputMeta | undefined;
    if (meta?.handled) continue; // our own — already marked
    if (tr.getMeta(ySyncPluginKey)) continue; // remote / undo-redo via Yjs
    ranges.push(...insertedRanges(tr));
  }
  if (ranges.length === 0) return null;

  if (st?.on && st.author) {
    const sid = newSid();
    const ts = Date.now();
    const attrs = attrsFor(st.author, sid, ts);
    let appended: Transaction | null = null;
    let last: { from: number; to: number } | null = null;
    for (const range of ranges) {
      for (const seg of collectSegments(newState.doc, range.from, range.to, types)) {
        if (seg.kind !== 'plain') continue;
        const $seg = newState.doc.resolve(seg.from);
        if (!$seg.parent.type.allowsMarkType(types.ins)) continue;
        appended = appended ?? newState.tr;
        appended.addMark(seg.from, seg.to, types.ins.create(attrs));
        last = { from: seg.from, to: seg.to };
      }
    }
    if (!appended || !last) return null;
    appended.setMeta(suggestInputKey, {
      handled: true,
      burst: { sid, ts, from: last.from, to: last.to },
    } satisfies SuggestInputMeta);
    return appended;
  }

  // Suggesting OFF: default input INHERITS the marks at the caret when it
  // sits inside a pending span (`inclusive: false` only guards the
  // boundaries — PM's $pos.marks() returns a text node's own marks mid-node,
  // and tr.insertText applies them to the typed text). Inherited
  // suggestInsert makes the human's real keystrokes invisible on disk and
  // deletes them outright if the proposal is rejected; inherited
  // suggestDelete strikes them through and deletes them on accept. Strip
  // both marks from any locally-inserted text so a normal-mode edit is
  // always a direct edit. (Remote/agent transactions carry the ySync meta
  // and are skipped above, so agent-authored proposals are untouched.)
  let stripped: Transaction | null = null;
  for (const range of ranges) {
    for (const seg of collectSegments(newState.doc, range.from, range.to, types)) {
      if (seg.kind === 'plain') continue;
      stripped = stripped ?? newState.tr;
      stripped.removeMark(seg.from, seg.to, seg.kind === 'ins' ? types.ins : types.del);
    }
  }
  if (stripped) stripped.setMeta(suggestInputKey, { handled: true } satisfies SuggestInputMeta);
  return stripped;
}

// --- the plugin ---

function createSuggestInputPlugin(): Plugin<SuggestInputState> {
  return new Plugin<SuggestInputState>({
    key: suggestInputKey,
    state: {
      init: (): SuggestInputState => ({ on: false, author: null, burst: null }),
      apply(tr, prev): SuggestInputState {
        const meta = tr.getMeta(suggestInputKey) as SuggestInputMeta | undefined;
        let next = prev;
        if (meta?.mode) {
          next = { on: meta.mode.on, author: meta.mode.author ?? prev.author, burst: null };
        }
        if (!tr.docChanged) return next;
        let burst = next.burst;
        if (meta && 'burst' in meta) {
          burst = meta.burst ?? null;
        } else if (burst) {
          burst = {
            ...burst,
            from: tr.mapping.map(burst.from, 1),
            to: tr.mapping.map(burst.to, -1),
          };
        }
        return burst === next.burst ? next : { ...next, burst };
      },
    },
    props: {
      handleTextInput,
      handleKeyDown,
      handlePaste: handleSuggestPaste,
      handleDrop: handleSuggestDrop,
      handleDOMEvents: {
        cut: (view, event) => handleSuggestCut(view, event),
      },
    },
    appendTransaction: (trs, _old, newState) => appendBackstop(trs, newState),
  });
}

/** Tiptap wrapper so createEditor registers the plugin in the base list.
 *  High priority puts our key/input handlers ahead of the default keymaps —
 *  Backspace must reach us before joinBackward deletes for real. */
export const SuggestInput = Extension.create({
  name: 'suggestInput',
  priority: 1000,
  addProseMirrorPlugins() {
    return [createSuggestInputPlugin()];
  },
});
