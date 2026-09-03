import { computeRedline, prose } from '@feedback/core';
import { Extension } from '@tiptap/core';
import type { Node as ProseNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import * as Y from 'yjs';

/**
 * Live redline markup over the EDITABLE companion editor.
 *
 * The old redline surface re-rendered derived HTML with ins/del baked into the
 * content — which is why it had to be read-only. Here the document is the real
 * collaborative prose doc, and the markup vs `baseText` is computed live as
 * DECORATIONS (debounced on doc changes), so typing, remote edits, and agent
 * edits all land in the same doc while the redline re-paints around them.
 *
 * Insertions render inline (`<ins class="lf-ins">` decorations — same CSS as
 * the read-only surface). Deletions are NOT rendered inline on wide screens:
 * they're extracted as a list (`pos` in the live doc + the deleted markdown)
 * for the margin balloons (markup-margin.ts) to consume, AND rendered as a
 * grouped, compact "⌫ N lines" widget decoration (`buildDeletionChip`) that
 * only styles.css shows — hidden ≥1100px, where the balloon carries the same
 * content; visible ≤1100px, where the balloon column collapses.
 *
 * Reuses `computeRedline` from @feedback/core: the live doc is serialized
 * per-block (prose.serializeBlockToMarkdown — the same serializer the disk
 * write-back uses), diffed against `baseText`, and the resulting markdown
 * offsets are mapped back to ProseMirror positions.
 */

export interface RedlineDeletion {
  /** Position in the live doc where the deleted content was — the nearest
   *  retained position at or after the deletion (a block start for deleted
   *  blocks; the word boundary for inline deletions). */
  pos: number;
  deletedMarkdown: string;
}

export interface DeletionGroup {
  /** Live-doc position of the group's first deletion. */
  pos: number;
  /** Top-level block index the group anchors in (grouping key). */
  blockKey: number;
  deletedMarkdown: string;
}

/** The top-level block index containing `pos` — the grouping key for both the
 *  margin balloon and the mobile chip, so they always agree on what counts as
 *  "one deletion". Pure over the PM doc; no view needed. */
export function blockIndexForPos(doc: ProseNode, pos: number): number {
  const p = Math.max(0, Math.min(pos, doc.content.size));
  return doc.resolve(p).index(0);
}

/**
 * Collapse consecutive deletions that anchor in the same top-level block into
 * one group, joining their markdown line-by-line. Pure — the caller supplies
 * the pos→block mapping.
 */
export function groupDeletions(
  deletions: RedlineDeletion[],
  blockKeyForPos: (pos: number) => number,
): DeletionGroup[] {
  const groups: DeletionGroup[] = [];
  for (const d of deletions) {
    const blockKey = blockKeyForPos(d.pos);
    const last = groups[groups.length - 1];
    if (last && last.blockKey === blockKey) {
      last.deletedMarkdown += `\n${d.deletedMarkdown}`;
    } else {
      groups.push({ pos: d.pos, blockKey, deletedMarkdown: d.deletedMarkdown });
    }
  }
  return groups;
}

export interface LiveMarkupResult {
  insRanges: Array<{ from: number; to: number }>;
  deletions: RedlineDeletion[];
}

const EMPTY_RESULT: LiveMarkupResult = { insRanges: [], deletions: [] };

/** One top-level block of the live doc, with its markdown span. */
interface BlockEntry {
  pmFrom: number;
  pmTo: number;
  node: ProseNode;
  mdFrom: number;
  mdTo: number;
}

/** Flattened text of a block with a per-character PM position index, so a
 *  markdown word-diff segment can be located in the rendered doc. */
interface FlatIndex {
  text: string;
  pos: number[];
}

function flatIndex(block: ProseNode, blockPos: number): FlatIndex {
  let text = '';
  const pos: number[] = [];
  block.descendants((child, rel) => {
    if (child.isText && child.text) {
      const abs = blockPos + 1 + rel;
      for (let k = 0; k < child.text.length; k++) {
        text += child.text[k];
        pos.push(abs + k);
      }
      return true;
    }
    // Separate nested textblocks (list items, table cells) so a token can't
    // falsely match across a boundary.
    if (child.isTextblock && text.length > 0 && !text.endsWith(' ')) {
      text += ' ';
      pos.push(blockPos + 1 + rel);
    }
    return true;
  });
  return { text, pos };
}

/** Strip markdown syntax a serialized token carries but the rendered text
 *  doesn't (emphasis, code ticks, list bullets, heading hashes, links). */
function cleanToken(token: string): string {
  const stripped = token.replace(/^[#>*_`~[\]()!-]+/, '').replace(/[*_`~[\]()]+$/, '');
  // Ordered-list numbering ("1.") exists only in the markdown source.
  if (/^\d+\.$/.test(stripped)) return '';
  return stripped;
}

/** Locate a diff segment's words in the flat text, at/after `from`. Returns
 *  the covered [start, end) char range, or null when nothing matched. */
function matchTokens(
  flat: string,
  from: number,
  segText: string,
): { start: number; end: number } | null {
  const tokens = (segText.match(/\S+/g) ?? []).map(cleanToken).filter((t) => t !== '');
  if (tokens.length === 0) return null;
  const start = flat.indexOf(tokens[0], from);
  if (start === -1) return null;
  let end = start + tokens[0].length;
  for (let i = 1; i < tokens.length; i++) {
    const idx = flat.indexOf(tokens[i], end);
    if (idx === -1) break; // partial match — cover what we found
    end = idx + tokens[i].length;
  }
  return { start, end };
}

/**
 * Compute the live markup: ins decoration ranges + the deletions list.
 *
 * Pure over its inputs (the PM doc and the Yjs fragment it mirrors), so tests
 * can drive it through a real Collaboration editor. Returns the empty result
 * while the editor and fragment are transiently out of step mid-sync. Callers
 * handle the added-file case (LiveMarkupOptions.isAdded) — an empty baseText
 * here legitimately means "everything is inserted".
 */
export function computeLiveMarkup(
  baseText: string,
  doc: ProseNode,
  fragment: Y.XmlFragment,
): LiveMarkupResult {
  const children = fragment.toArray();
  if (children.length !== doc.childCount) return EMPTY_RESULT;

  // Serialize per block, tracking each block's span in the joined markdown —
  // the same shape serializeFragmentToMarkdown writes to disk.
  const entries: BlockEntry[] = [];
  let newMd = '';
  doc.forEach((node, pmFrom, i) => {
    const child = children[i];
    const md = child instanceof Y.XmlElement ? prose.serializeBlockToMarkdown(child) : '';
    if (md === '') {
      entries.push({
        pmFrom,
        pmTo: pmFrom + node.nodeSize,
        node,
        mdFrom: newMd.length,
        mdTo: newMd.length,
      });
      return;
    }
    if (newMd !== '') newMd += '\n\n';
    const mdFrom = newMd.length;
    newMd += md;
    entries.push({ pmFrom, pmTo: pmFrom + node.nodeSize, node, mdFrom, mdTo: newMd.length });
  });
  if (newMd !== '') newMd += '\n';

  /** The block whose markdown span contains `mdOffset`. An offset in the
   *  `\n\n` join gap belongs to the NEXT block (that's where a deletion
   *  snapping there should anchor); past the last block, to the last one. */
  const ownerAt = (mdOffset: number): BlockEntry | null => {
    let prev: BlockEntry | null = null;
    for (const e of entries) {
      if (e.mdFrom >= e.mdTo) continue; // empty block — no markdown span
      if (mdOffset < e.mdTo) return e;
      prev = e;
    }
    return prev;
  };

  const insRanges: Array<{ from: number; to: number }> = [];
  const deletions: RedlineDeletion[] = [];

  // A deleted block anchors at the start of the next SURVIVING block in the
  // redline's output order (that's where the content was removed from); a
  // deletion at the very end anchors at the end of the document. Not snapTo:
  // that offset serves comment anchoring and points at the last retained LINE
  // for trailing deletions — which is before the deletion, not at it.
  const pendingDels: string[] = [];
  const flushDels = (pos: number): void => {
    for (const md of pendingDels.splice(0)) deletions.push({ pos, deletedMarkdown: md });
  };

  for (const block of computeRedline(baseText, newMd)) {
    if (block.kind === 'del') {
      pendingDels.push(block.segments.map((s) => s.text).join(''));
      continue;
    }

    const owner = block.from != null ? ownerAt(block.from) : null;
    if (owner) flushDels(owner.pmFrom);
    if (block.kind === 'same' || !owner) continue;

    if (block.kind === 'ins') {
      const from = owner.pmFrom + 1;
      const to = owner.pmTo - 1;
      if (to > from) insRanges.push({ from, to });
      continue;
    }

    // 'changed': walk the word-diff segments through the block's flat text.
    const flat = flatIndex(owner.node, owner.pmFrom);
    let cursor = 0;
    for (const seg of block.segments) {
      if (seg.kind === 'del') {
        deletions.push({
          pos: flat.pos[Math.min(cursor, flat.pos.length - 1)] ?? owner.pmFrom + 1,
          deletedMarkdown: seg.text,
        });
        continue;
      }
      const m = matchTokens(flat.text, cursor, seg.text);
      if (!m) continue; // syntax-only segment (e.g. bare `**`) — nothing rendered to mark
      if (seg.kind === 'ins') {
        insRanges.push({ from: flat.pos[m.start], to: flat.pos[m.end - 1] + 1 });
      }
      cursor = m.end;
    }
  }
  flushDels(doc.content.size);

  deletions.sort((a, b) => a.pos - b.pos);
  return { insRanges, deletions };
}

interface LiveMarkupState {
  decorations: DecorationSet;
  deletions: RedlineDeletion[];
}

export const liveMarkupKey = new PluginKey<LiveMarkupState>('lf-live-markup');

/**
 * The mobile chip's DOM (styles.css: `.lf-del-chip`, shown only ≤1100px —
 * the balloon margin shows the same content on wide screens). Always built
 * regardless of viewport, same as every other decoration here — CSS alone
 * decides which of the two (balloon vs chip) is visible, so there's no JS
 * branching on window width to keep in sync with the stylesheet's breakpoint.
 *
 * `contentEditable = 'false'` per ProseMirror's own guidance for widget
 * decorations: they're excluded from the document's content model, but
 * nothing stops native editing INSIDE the injected DOM unless the widget
 * opts out itself. The deleted markdown rides along as a `data-*` attribute
 * — the margin's click handler (markup-margin.ts) reads it back to fill the
 * mobile sheet, so this module stays free of DOM-mounting concerns (scope,
 * listeners) it doesn't otherwise need.
 */
function buildDeletionChip(group: DeletionGroup): HTMLElement {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'lf-del-chip';
  chip.contentEditable = 'false';
  const lines = group.deletedMarkdown.split('\n').length;
  const label = lines === 1 ? '1 line' : `${lines} lines`;
  chip.textContent = `⌫ ${label}`;
  chip.setAttribute('aria-label', `View ${label} of deleted text`);
  chip.dataset.lfDelText = group.deletedMarkdown;
  return chip;
}

function toState(doc: ProseNode, result: LiveMarkupResult): LiveMarkupState {
  const insDecos = result.insRanges
    .filter((r) => r.to > r.from)
    .map((r) => Decoration.inline(r.from, r.to, { nodeName: 'ins', class: 'lf-ins' }));
  const delGroups = groupDeletions(result.deletions, (pos) => blockIndexForPos(doc, pos));
  const chipDecos = delGroups.map((g) => Decoration.widget(g.pos, () => buildDeletionChip(g)));
  return {
    decorations: DecorationSet.create(doc, [...insDecos, ...chipDecos]),
    deletions: result.deletions,
  };
}

export interface LiveMarkupOptions {
  /** File content at the base commit. */
  baseText: string;
  /** True only when the diff reports the file as ADDED — suppresses all
   *  markup (a clean render + banner beats a fully-underlined document).
   *  NOT inferred from an empty baseText: a tracked file can have an empty
   *  base blob and still be modified/renamed, and that file's changes must
   *  show as insertions. */
  isAdded: boolean;
  /** The companion Y.Doc the editor collaborates on. */
  ydoc: Y.Doc | null;
  /** Recompute delay after a doc change. */
  debounceMs: number;
}

/**
 * Tiptap extension carrying the live markup plugin. Between recomputes,
 * existing decorations and deletion positions are MAPPED through each
 * transaction, so markup tracks concurrent typing until the debounce fires.
 */
export const LiveMarkup = Extension.create<LiveMarkupOptions>({
  name: 'liveMarkup',

  addOptions() {
    return { baseText: '', isAdded: false, ydoc: null, debounceMs: 300 };
  },

  addProseMirrorPlugins() {
    const opts = this.options;
    const compute = (doc: ProseNode): LiveMarkupResult => {
      if (!opts.ydoc || opts.isAdded) return EMPTY_RESULT;
      return computeLiveMarkup(opts.baseText, doc, prose.getProseFragment(opts.ydoc));
    };
    let timer: ReturnType<typeof setTimeout> | null = null;

    return [
      new Plugin<LiveMarkupState>({
        key: liveMarkupKey,
        state: {
          init: (_config, state) => toState(state.doc, compute(state.doc)),
          apply: (tr, prev, _oldState, newState) => {
            const meta = tr.getMeta(liveMarkupKey) as LiveMarkupResult | undefined;
            if (meta) return toState(newState.doc, meta);
            if (!tr.docChanged) return prev;
            return {
              decorations: prev.decorations.map(tr.mapping, tr.doc),
              deletions: prev.deletions.map((d) => ({ ...d, pos: tr.mapping.map(d.pos) })),
            };
          },
        },
        props: {
          decorations(state) {
            return liveMarkupKey.getState(state)?.decorations;
          },
        },
        view: (view) => {
          const schedule = () => {
            if (timer != null) clearTimeout(timer);
            timer = setTimeout(() => {
              timer = null;
              if (view.isDestroyed) return;
              view.dispatch(view.state.tr.setMeta(liveMarkupKey, compute(view.state.doc)));
            }, opts.debounceMs);
          };
          // Initial compute: the Collaboration binding populates the doc
          // DURING editor construction — before this view exists — so no
          // `update` ever fires for the initial content. (Same family as the
          // collapseUnchanged learning: state derived at init is stale for
          // content that lands around mount time.)
          schedule();
          return {
            update: (v, prevState) => {
              // Reference check: an unchanged doc keeps its identity, so this
              // only fires on real edits (local, remote, or agent-driven).
              if (v.state.doc !== prevState.doc) schedule();
            },
            destroy: () => {
              if (timer != null) clearTimeout(timer);
              timer = null;
            },
          };
        },
      }),
    ];
  },
});
