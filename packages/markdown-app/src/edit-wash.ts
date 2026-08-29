import { knownUserForName } from '@feedback/core';
import { Extension } from '@tiptap/core';
import type { Node as ProseNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import type { Awareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';

/**
 * Recent-edit washes for a huddle doc.
 *
 * Each participant's last three edited top-level sections carry a pastel
 * wash in that participant's color (Bryan, 2026-08-29: "highlight the last
 * three sections edited by each user in that user's color. Light pastel.").
 * Two people on one section: the later editor's wash.
 *
 * Render-time only — a ProseMirror NODE decoration in the same shape as
 * thread-decorations.ts. Nothing here is written into the Yjs fragment, so
 * the markdown on disk, the doc's HTML, and every other client are untouched;
 * print hides it with a media rule.
 *
 * WHO edited a block is not tracked anywhere today: the sync plugin's
 * awareness is wired but unused, the server's activity log records threads
 * and reads but never prose edits, and a Yjs update carries clientIDs and no
 * names. So the attribution is reconstructed CLIENT-SIDE, per transaction
 * (see `createEditAttribution`):
 *   - a local ProseMirror transaction is the local user's;
 *   - a remote one (the sync plugin marks it `isChangeOrigin`) belongs to
 *     the Yjs clientIDs whose clock advanced in the Y transaction that
 *     produced it, resolved to a name + color through awareness;
 *   - a writer with no awareness state is the server — the only writer that
 *     never announces itself — so it reads as the agent.
 * It is a per-session reconstruction: reload the page and the washes start
 * over. That is the first cut Bryan approved, not a durable record.
 *
 * WHICH blocks changed is read from node identity, not positions: ProseMirror
 * rebuilds only the edited block (siblings keep their instances), and the
 * sync plugin's remote rerender reuses the instances in its Y→PM mapping the
 * same way. Positions would not work — a remote change arrives as one
 * whole-document replace step, whose mapping says everything moved.
 */

export interface EditWashAuthor {
  name: string;
  color: string;
}

/** How many of each person's most recent sections stay washed. */
export const WASH_KEEP = 3;

/** The known agent color — what a server-side (agent) edit is washed in. */
export const AGENT_WASH_COLOR = knownUserForName('agent')?.color ?? '#e36f1e';
const AGENT_AUTHOR: EditWashAuthor = {
  name: knownUserForName('agent')?.name ?? 'Agent',
  color: AGENT_WASH_COLOR,
};

export interface WashEntry {
  /** The top-level block, by instance — see the header on why not a position. */
  node: ProseNode;
  author: EditWashAuthor;
  /** Monotonic edit order; higher = more recent. */
  seq: number;
}

interface State {
  entries: WashEntry[];
  seq: number;
  deco: DecorationSet;
}

export interface EditWashOptions {
  /** Who made this transaction's change; null = do not attribute (nobody's
   *  edit — the initial sync, a rerender, a change before the doc is ready).
   *  An unattributed change still drops the wash of any block it touched. */
  authorOf: (tr: Transaction) => EditWashAuthor | null;
  keep: number;
}

export const editWashKey = new PluginKey<State>('edit-wash');

/**
 * Carry the entries across one document change: keep those whose block
 * survived untouched, drop the rest, and record `author` on every block that
 * is new or rebuilt. Pure — the plugin and the tests share it.
 */
export function advanceWash(
  prev: WashEntry[],
  seq: number,
  oldDoc: ProseNode,
  newDoc: ProseNode,
  author: EditWashAuthor | null,
  keep: number,
): { entries: WashEntry[]; seq: number } {
  const before = new Set<ProseNode>();
  oldDoc.forEach((child) => before.add(child));
  const after = new Set<ProseNode>();
  const changed: ProseNode[] = [];
  newDoc.forEach((child) => {
    after.add(child);
    if (!before.has(child)) changed.push(child);
  });
  let entries = prev.filter((e) => after.has(e.node));
  if (author && changed.length > 0) {
    for (const node of changed) entries.push({ node, author, seq: ++seq });
    entries = trimPerAuthor(entries, keep);
  }
  return { entries, seq };
}

function trimPerAuthor(entries: WashEntry[], keep: number): WashEntry[] {
  const byAuthor = new Map<string, WashEntry[]>();
  for (const e of entries) {
    const list = byAuthor.get(e.author.name) ?? [];
    list.push(e);
    byAuthor.set(e.author.name, list);
  }
  const kept = new Set<WashEntry>();
  for (const list of byAuthor.values()) {
    list.sort((a, b) => b.seq - a.seq);
    for (const e of list.slice(0, keep)) kept.add(e);
  }
  return entries.filter((e) => kept.has(e));
}

/** Node decorations for the entries — one per washed block, in doc order. */
export function buildWashDecos(doc: ProseNode, entries: WashEntry[]): DecorationSet {
  if (entries.length === 0) return DecorationSet.empty;
  // rank 1 = that person's most recent section (the strongest wash).
  const rank = new Map<WashEntry, number>();
  const byAuthor = new Map<string, WashEntry[]>();
  for (const e of entries) {
    const list = byAuthor.get(e.author.name) ?? [];
    list.push(e);
    byAuthor.set(e.author.name, list);
  }
  for (const list of byAuthor.values()) {
    list.sort((a, b) => b.seq - a.seq);
    list.forEach((e, i) => rank.set(e, i + 1));
  }
  const byNode = new Map<ProseNode, WashEntry>();
  for (const e of entries) byNode.set(e.node, e);
  const decos: Decoration[] = [];
  doc.forEach((child, pos) => {
    const e = byNode.get(child);
    if (!e) return;
    decos.push(
      Decoration.node(pos, pos + child.nodeSize, {
        class: `edit-wash edit-wash-${rank.get(e) ?? 1}`,
        style: `--edit-color: ${e.author.color}`,
        'data-edit-author': e.author.name,
        'data-edit-rank': String(rank.get(e) ?? 1),
      }),
    );
  });
  return DecorationSet.create(doc, decos);
}

export const EditWash = Extension.create<EditWashOptions>({
  name: 'editWash',
  addOptions() {
    return { authorOf: () => null, keep: WASH_KEEP };
  },
  addProseMirrorPlugins() {
    const { authorOf, keep } = this.options;
    return [
      new Plugin<State>({
        key: editWashKey,
        state: {
          init: () => ({ entries: [], seq: 0, deco: DecorationSet.empty }),
          apply: (tr, prev, oldState) => {
            if (!tr.docChanged) return prev;
            const next = advanceWash(
              prev.entries,
              prev.seq,
              oldState.doc,
              tr.doc,
              authorOf(tr),
              keep,
            );
            return { ...next, deco: buildWashDecos(tr.doc, next.entries) };
          },
        },
        props: {
          decorations(state) {
            return editWashKey.getState(state)?.deco;
          },
        },
      }),
    ];
  },
});

export interface EditAttributionOpts {
  ydoc: Y.Doc;
  awareness: Awareness;
  /** The local person: every local transaction is theirs. */
  localUser: EditWashAuthor;
  /** Runs `cb` once the doc's first sync has landed. Nothing before it is
   *  anybody's edit — the initial hydration replays every write the doc has
   *  ever had, and washing all of it would say nothing. */
  whenSynced: (cb: () => void) => void;
}

export interface EditAttribution {
  authorOf: (tr: Transaction) => EditWashAuthor | null;
  destroy: () => void;
}

/**
 * The `authorOf` for a live Yjs-backed editor — see the module header.
 *
 * The writers of a remote change are read in `beforeObserverCalls`, which
 * Yjs emits after the transaction's state vectors are final and BEFORE the
 * sync plugin's observer dispatches the ProseMirror transaction — so by the
 * time `authorOf(tr)` runs for that tr, `writers` names its clientIDs.
 */
export function createEditAttribution(opts: EditAttributionOpts): EditAttribution {
  let armed = false;
  opts.whenSynced(() => {
    armed = true;
  });
  let writers: number[] = [];
  /** Names seen for a clientID — kept after the peer leaves, so an edit that
   *  lands as their socket closes is still theirs and not "the agent". */
  const seen = new Map<number, EditWashAuthor>();
  const onBeforeObservers = (tx: Y.Transaction) => {
    if (tx.local) {
      writers = [];
      return;
    }
    const ids: number[] = [];
    tx.afterState.forEach((clock, client) => {
      if (clock > (tx.beforeState.get(client) ?? 0)) ids.push(client);
    });
    writers = ids;
  };
  opts.ydoc.on('beforeObserverCalls', onBeforeObservers);

  const userFor = (client: number): EditWashAuthor | null => {
    const state = opts.awareness.getStates().get(client) as
      | { user?: { name?: unknown; color?: unknown } }
      | undefined;
    const u = state?.user;
    if (u && typeof u.name === 'string' && typeof u.color === 'string') {
      const author = { name: u.name, color: u.color };
      seen.set(client, author);
      return author;
    }
    return seen.get(client) ?? null;
  };

  return {
    authorOf(tr) {
      if (!armed) return null;
      const sync = tr.getMeta(ySyncPluginKey) as
        | { isChangeOrigin?: boolean; binding?: unknown }
        | undefined;
      if (!sync?.isChangeOrigin) return opts.localUser;
      // A full rerender (the binding re-initialising) is not an edit.
      if (sync.binding) return null;
      for (const client of writers) {
        if (client === opts.ydoc.clientID) continue;
        const author = userFor(client);
        if (author) return author;
      }
      return writers.some((c) => c !== opts.ydoc.clientID) ? AGENT_AUTHOR : null;
    },
    destroy() {
      opts.ydoc.off('beforeObserverCalls', onBeforeObservers);
    },
  };
}
