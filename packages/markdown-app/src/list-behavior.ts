import { type Editor, Extension } from '@tiptap/core';
import type { Node as ProseNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, Selection, TextSelection } from '@tiptap/pm/state';
import { canJoin } from '@tiptap/pm/transform';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

/**
 * Bullet-list ergonomics for the doc editor (meeting-notes UX plan, AC 3):
 *
 * 1. Tab indents a first/sole list item. ProseMirror's `sinkListItem` is a
 *    no-op on an item with no preceding sibling (there is no host item to
 *    nest under), so Tab on the only bullet of a list did nothing. When the
 *    stock sink declines, we build the host ourselves: the item moves one
 *    level deeper — into a nested list of the same type, where it remains
 *    the only item. The schema (`listItem: 'paragraph block*'`) requires the
 *    host item to open with a paragraph, so the host gets an empty one; the
 *    shape round-trips through the core markdown layer as `- \n  - x`.
 *    The host is IMPLICIT: the person asked for an indent and must see one,
 *    not a blank parent bullet above their line — so a host of exactly that
 *    shape is decorated `implicit-host` and the stylesheet draws neither its
 *    marker nor its empty line, and a caret that lands in the empty line
 *    (arrow keys, a click on the blank) is moved on past it, in the
 *    direction it was travelling. Shift-Tab — and Backspace at the start of
 *    the indented line — recognise the shape and reverse it (the stock lift
 *    would lift the item but strand the host bullet); any other nested item
 *    falls through to the stock commands.
 *
 * 2. Adjacent sibling lists of the SAME type auto-join. Enter-splitting a
 *    numbered list and deleting the empty item leaves two orderedLists that
 *    each restart at 1 and nothing ever merges them — an appendTransaction
 *    joins such neighbours (top level and nested alike), so the numbering
 *    reads sequentially again. Different-type neighbours are left alone.
 *
 * Registered ONLY in editor.ts's createEditor. The redline surface builds
 * its own Editor and must never join lists — its adjacent lists carry
 * per-hunk anchors on purpose (redline-marks.test.ts pins that).
 */

const LIST_TYPE_NAMES = new Set(['bulletList', 'orderedList']);

/** Depth of the nearest listItem ancestor of $from, or -1. */
function listItemDepth(editor: Editor): number {
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === 'listItem') return d;
  }
  return -1;
}

/**
 * Sink an item that has NO preceding sibling: wrap it in a host item whose
 * content is an empty paragraph plus a nested list (same type as its parent)
 * holding the original item. The selection keeps its place in the moved
 * text — every position inside the item shifts by exactly +4 tokens (host
 * item open, empty paragraph, nested list open).
 */
function sinkFirstListItem(editor: Editor): boolean {
  const { state } = editor;
  const { $from, $to } = state.selection;
  const depth = listItemDepth(editor);
  if (depth < 1) return false;
  const item = $from.node(depth);
  // Selection must sit entirely inside this one item.
  if ($to.depth < depth || $to.node(depth) !== item) return false;
  const list = $from.node(depth - 1);
  if (!LIST_TYPE_NAMES.has(list.type.name)) return false;
  // An item WITH a preceding sibling is sinkListItem's case, not ours.
  if ($from.index(depth - 1) !== 0) return false;
  const paragraph = state.schema.nodes.paragraph.createAndFill();
  if (!paragraph) return false;
  const host = item.type.create(null, [paragraph, list.type.create(null, item)]);
  const itemPos = $from.before(depth);
  const tr = state.tr.replaceWith(itemPos, itemPos + item.nodeSize, host);
  tr.setSelection(TextSelection.create(tr.doc, $from.pos + 4, $to.pos + 4)).scrollIntoView();
  editor.view.dispatch(tr);
  return true;
}

/** The host shape sinkFirstListItem builds, and nothing else: a list item
 *  holding an empty paragraph and then one nested list. */
function isImplicitHost(item: ProseNode): boolean {
  if (item.type.name !== 'listItem' || item.childCount !== 2) return false;
  const first = item.child(0);
  if (first.type.name !== 'paragraph' || first.content.size !== 0) return false;
  return LIST_TYPE_NAMES.has(item.child(1).type.name);
}

/**
 * Reverse of sinkFirstListItem: when the selection sits in a nested list
 * whose host item is exactly (empty paragraph, that list), replace the host
 * with the nested items — the empty host bullet must not survive the lift.
 * Anything else returns false so the stock liftListItem handles it.
 */
function liftFromEmptyHost(editor: Editor): boolean {
  const { state } = editor;
  const { $from, $to } = state.selection;
  const depth = listItemDepth(editor);
  // Needs list > hostItem > list > item nesting around the selection.
  if (depth < 3) return false;
  if ($to.depth < depth || $to.node(depth) !== $from.node(depth)) return false;
  const innerList = $from.node(depth - 1);
  const host = $from.node(depth - 2);
  if (!isImplicitHost(host) || host.child(1) !== innerList) return false;
  const hostPos = $from.before(depth - 2);
  const tr = state.tr.replaceWith(hostPos, hostPos + host.nodeSize, innerList.content);
  tr.setSelection(TextSelection.create(tr.doc, $from.pos - 4, $to.pos - 4)).scrollIntoView();
  editor.view.dispatch(tr);
  return true;
}

/** One `implicit-host` node decoration per host item in `doc`. */
function implicitHostDecorations(doc: ProseNode): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (isImplicitHost(node)) {
      decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'implicit-host' }));
    }
    return true;
  });
  return DecorationSet.create(doc, decos);
}

const implicitHostKey = new PluginKey<DecorationSet>('implicit-host');

/**
 * Where a cursor that came to rest in an implicit host's empty paragraph
 * belongs instead: before the host when it was travelling up (an arrow up
 * out of the nested item, which reads as "the line above"), into the nested
 * item when it was travelling down or arrived from nowhere in particular.
 * Null when the selection is anywhere else.
 */
function stepPastImplicitHost(oldSel: Selection, sel: Selection): Selection | null {
  if (!(sel instanceof TextSelection) || !sel.empty) return null;
  const { $from } = sel;
  if ($from.depth < 2 || $from.parent.type.name !== 'paragraph') return null;
  const host = $from.node($from.depth - 1);
  if ($from.index($from.depth - 1) !== 0 || !isImplicitHost(host)) return null;
  const hostPos = $from.before($from.depth - 1);
  if (sel.from < oldSel.from) {
    const before = Selection.findFrom($from.doc.resolve(hostPos), -1, true);
    if (before) return before;
  }
  // Past the paragraph close, the nested list open and the item open: the
  // same +4 sinkFirstListItem moves the caret by.
  return TextSelection.create($from.doc, $from.pos + 4);
}

/** First position where a list sits right after a same-type sibling list. */
function joinableListBoundary(doc: ProseNode): number | null {
  let found: number | null = null;
  doc.descendants((node, pos) => {
    if (found != null) return false;
    if (!LIST_TYPE_NAMES.has(node.type.name)) return true;
    const before = doc.resolve(pos).nodeBefore;
    if (before && before.type === node.type && canJoin(doc, pos)) {
      found = pos;
      return false;
    }
    return true;
  });
  return found;
}

export const ListBehavior = Extension.create({
  name: 'listBehavior',
  // Above StarterKit's ListItem so these Tab handlers run first; both fall
  // through (return false) whenever the stock commands should apply.
  priority: 1000,

  addKeyboardShortcuts() {
    return {
      Tab: () => {
        if (this.editor.commands.sinkListItem('listItem')) return true;
        return sinkFirstListItem(this.editor);
      },
      'Shift-Tab': () => liftFromEmptyHost(this.editor),
      // Backspace at the very start of the indented item: the stock
      // joinBackward would lift the item out beside its host, leaving the
      // blank host bullet visible — the one thing the implicit host must
      // never become. Lift the way Shift-Tab does instead.
      Backspace: () => {
        const { $from, empty } = this.editor.state.selection;
        if (!empty || $from.parentOffset !== 0) return false;
        const depth = listItemDepth(this.editor);
        if (depth < 3 || $from.index(depth) !== 0 || $from.index(depth - 1) !== 0) return false;
        return liftFromEmptyHost(this.editor);
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: implicitHostKey,
        state: {
          init: (_config, state) => implicitHostDecorations(state.doc),
          apply: (tr, set) => (tr.docChanged ? implicitHostDecorations(tr.doc) : set),
        },
        props: {
          decorations(state) {
            return implicitHostKey.getState(state);
          },
        },
        appendTransaction: (_trs, oldState, newState) => {
          const to = stepPastImplicitHost(oldState.selection, newState.selection);
          return to ? newState.tr.setSelection(to) : null;
        },
      }),
      new Plugin({
        key: new PluginKey('list-join'),
        appendTransaction: (transactions, _oldState, newState) => {
          if (!transactions.some((tr) => tr.docChanged)) return null;
          const tr = newState.tr;
          let joined = false;
          // Each join removes one boundary, so this terminates.
          for (
            let pos = joinableListBoundary(tr.doc);
            pos != null;
            pos = joinableListBoundary(tr.doc)
          ) {
            tr.join(pos);
            joined = true;
          }
          return joined ? tr : null;
        },
      }),
    ];
  },
});
