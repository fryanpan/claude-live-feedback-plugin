import { parseWorkspaceLink } from '@feedback/core';
import { Extension } from '@tiptap/core';
import type { Node as ProseNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import {
  cachedLinkStatus,
  fetchLinkInfos,
  staleTaskLinkStatuses,
  statusChipLabel,
} from './link-titles.ts';

/**
 * Live status chips on workspace task links inside DOC PROSE — the editor
 * seam the comment renderer's chips (#416) had no equivalent of, because doc
 * content renders through ProseMirror rather than through
 * `comment-markdown.ts`.
 *
 * STRICTLY RENDER-TIME. The chip is a widget decoration beside the link; the
 * stored doc — the Yjs fragment, the serialized markdown, the bound file —
 * keeps exactly the raw or custom-labelled link that was written. This is
 * what lets the meeting composer write a plain markdown link and the chip
 * flip to "in progress" the moment the lead dispatches the task, with no
 * write to the doc at all.
 *
 * Statuses come from the SAME module-level cache the comment renderer uses
 * (`link-titles.ts`), so a URL resolved for a thread body is free here and
 * vice versa. Unknown URLs are fetched in one batch per pass; a URL the
 * server answers with no status (a doc link, an unknown id) is cached as the
 * "no chip" state and never re-asked until something stales it.
 */

export const taskLinkChipsKey = new PluginKey<ChipState>('task-link-chips');
const META_KEY = 'taskLinkChips';

interface ChipState {
  deco: DecorationSet;
  /** URLs the cache has never answered for — the view layer's fetch list. */
  pending: readonly string[];
}

interface ChipMeta {
  /** Statuses changed out from under us (a fetch landed, a task
   *  transitioned): rebuild from the cache as it now stands. */
  refresh?: boolean;
}

/** One contiguous link in the doc, as the chip needs it. */
export interface TaskLinkRun {
  url: string;
  from: number;
  to: number;
}

/** A workspace link is same-origin by definition: root-relative, or absolute
 *  on this page's own origin. A foreign lookalike gets no chip — same rule
 *  as the comment renderer. */
function isSameOriginHref(href: string): boolean {
  if (href.startsWith('/')) return true;
  if (!/^https?:\/\//i.test(href)) return false;
  try {
    return new URL(href).origin === location.origin;
  } catch {
    return false;
  }
}

function linkHrefOf(node: ProseNode): string | null {
  for (const mark of node.marks) {
    if (mark.type.name === 'link') {
      const href = (mark.attrs as { href?: unknown }).href;
      return typeof href === 'string' ? href : null;
    }
  }
  return null;
}

/**
 * Every workspace-resource link in the doc, merged across the text nodes a
 * mark boundary may split it into — one run per written link, so one chip.
 */
export function taskLinkRunsIn(doc: ProseNode): TaskLinkRun[] {
  const runs: TaskLinkRun[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return true;
    const href = linkHrefOf(node);
    if (!href || !isSameOriginHref(href) || !parseWorkspaceLink(href)) return true;
    const last = runs[runs.length - 1];
    if (last && last.url === href && last.to === pos) {
      last.to = pos + node.nodeSize;
    } else {
      runs.push({ url: href, from: pos, to: pos + node.nodeSize });
    }
    return true;
  });
  return runs;
}

function chipEl(status: string): HTMLSpanElement {
  const chip = document.createElement('span');
  chip.className = `ws-status-chip ws-chip-${status}`;
  chip.textContent = statusChipLabel(status);
  return chip;
}

function build(doc: ProseNode): ChipState {
  const decos: Decoration[] = [];
  const pending = new Set<string>();
  for (const run of taskLinkRunsIn(doc)) {
    const status = cachedLinkStatus(run.url);
    if (status === undefined) {
      pending.add(run.url);
      continue;
    }
    if (status === null) continue; // resolved: not a task, no chip
    decos.push(
      Decoration.widget(run.to, () => chipEl(status), {
        // The key is the widget's identity: an unchanged url+status pair is
        // the same widget across rebuilds, so repaints never churn the DOM.
        key: `${run.url}|${status}`,
        side: 1,
        ignoreSelection: true,
      }),
    );
  }
  return { deco: DecorationSet.create(doc, decos), pending: [...pending] };
}

export const TaskLinkChips = Extension.create({
  name: 'taskLinkChips',
  addProseMirrorPlugins() {
    return [
      new Plugin<ChipState>({
        key: taskLinkChipsKey,
        state: {
          init: (_cfg, pmState) => build(pmState.doc),
          apply: (tr, prev) => {
            const meta = tr.getMeta(META_KEY) as ChipMeta | undefined;
            if (meta?.refresh || tr.docChanged) return build(tr.doc);
            return prev;
          },
        },
        props: {
          decorations(state) {
            return taskLinkChipsKey.getState(state)?.deco;
          },
        },
        view() {
          // URLs this editor already asked for and got no answer to (a
          // network failure, a batch cap) — not re-asked on every keystroke;
          // a refresh meta (SSE, navigation) empties the slate.
          let asked = new Set<string>();
          let inflight = false;
          const ensure = (view: EditorView): void => {
            if (inflight) return;
            const pending =
              taskLinkChipsKey.getState(view.state)?.pending.filter((u) => !asked.has(u)) ?? [];
            if (pending.length === 0) return;
            for (const u of pending) asked.add(u);
            inflight = true;
            void fetchLinkInfos(pending)
              .then((landed) => {
                inflight = false;
                asked = new Set([...asked].filter((u) => cachedLinkStatus(u) === undefined));
                if (landed && !(view as { isDestroyed?: boolean }).isDestroyed) {
                  refreshTaskLinkChips(view);
                }
              })
              .catch(() => {
                inflight = false;
              });
          };
          return {
            update: ensure,
          };
        },
      }),
    ];
  },
});

/** Rebuild the chips from the cache as it now stands. */
export function refreshTaskLinkChips(view: EditorView): void {
  const tr = view.state.tr;
  tr.setMeta(META_KEY, { refresh: true } satisfies ChipMeta);
  view.dispatch(tr);
}

/**
 * Keep this editor's chips live: the board's `task.transitioned` push stales
 * every cached status and the next rebuild re-asks — the same event the hub
 * refreshes its own chips on. Returns the teardown; callers bind it to the
 * mount scope so navigation closes the stream.
 */
export function watchTaskLinkStatuses(workspaceId: string, view: EditorView): () => void {
  const es = new EventSource(`/events/workspace/${encodeURIComponent(workspaceId)}`);
  const onTransition = (): void => {
    staleTaskLinkStatuses();
    refreshTaskLinkChips(view);
  };
  es.addEventListener('task.transitioned', onTransition);
  return () => {
    es.removeEventListener('task.transitioned', onTransition);
    es.close();
  };
}
