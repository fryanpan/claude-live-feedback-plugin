/**
 * Sidebar entries for one attached id (plan §3.9).
 *
 * An attached id is either a doc room or a legacy grouping id (diff review /
 * folder bind). A grouping id has no doc room of its own, so `/review/<id>`
 * renders the not-found page and `/api/docs/<id>/threads` misses — its
 * members and their threads only exist under the workspace endpoints.
 */
import type { SidebarDoc, SidebarThread } from './hub-render.ts';

type Fetcher = (url: string) => Promise<unknown>;

interface ThreadPayload {
  id: string;
  docId?: string;
  comments?: Array<{ text?: string }>;
  anchor?: { snippet?: { text?: string } };
}

interface TreeNode {
  type: 'dir' | 'file';
  docId?: string;
  children?: TreeNode[];
}

export function docLabelOf(meta: {
  title?: string;
  relPath?: string;
  sourceUrl?: string;
  docId: string;
}): string {
  if (meta.title) return meta.title;
  if (meta.relPath) return meta.relPath;
  if (meta.sourceUrl) return meta.sourceUrl.split('/').pop() ?? meta.docId;
  return meta.docId;
}

export function threadLabelOf(t: ThreadPayload): string {
  const first = t.comments?.[0]?.text?.trim();
  const snippet = t.anchor?.snippet?.text?.trim();
  const label = first || snippet || 'thread';
  return label.length > 80 ? `${label.slice(0, 79)}…` : label;
}

const reviewUrl = (docId: string) => `/review/${encodeURIComponent(docId)}`;

/** Depth-first first file leaf — the member a reader should land on. */
function firstMember(node: TreeNode | undefined): string | null {
  if (!node) return null;
  if (node.type === 'file') return node.docId ?? null;
  for (const child of node.children ?? []) {
    const found = firstMember(child);
    if (found) return found;
  }
  return null;
}

export async function sidebarEntriesFor(
  docId: string,
  fetchJson: Fetcher,
): Promise<{ docs: SidebarDoc[]; threads: SidebarThread[] }> {
  const meta = (await fetchJson(`/api/docs/${encodeURIComponent(docId)}`)) as {
    meta?: { title?: string; relPath?: string; sourceUrl?: string };
  } | null;

  if (meta?.meta) {
    const payload = (await fetchJson(
      `/api/docs/${encodeURIComponent(docId)}/threads?status=open`,
    )) as { threads?: ThreadPayload[] } | null;
    return {
      docs: [{ docId, label: docLabelOf({ ...meta.meta, docId }), url: reviewUrl(docId) }],
      threads: (payload?.threads ?? []).map((t) => ({
        docId,
        threadId: t.id,
        label: threadLabelOf(t),
        url: reviewUrl(docId),
        commentCount: t.comments?.length ?? 0,
      })),
    };
  }

  // Grouping id: resolve an entry member for the link, and take threads from
  // the workspace-wide query — the per-doc one can't see member threads.
  const tree = (await fetchJson(`/api/workspaces/${encodeURIComponent(docId)}/tree`)) as {
    tree?: TreeNode;
  } | null;
  const entry = firstMember(tree?.tree ?? undefined);
  const payload = (await fetchJson(
    `/api/workspaces/${encodeURIComponent(docId)}/threads?status=open`,
  )) as { threads?: ThreadPayload[] } | null;

  return {
    docs: [
      {
        docId,
        label: docId,
        // With no members yet there is nothing to open but the hub itself —
        // better than a link that renders the not-found page.
        url: entry ? reviewUrl(entry) : `/workspaces/${encodeURIComponent(docId)}`,
      },
    ],
    threads: (payload?.threads ?? []).map((t) => ({
      docId: t.docId ?? docId,
      threadId: t.id,
      label: threadLabelOf(t),
      url: reviewUrl(t.docId ?? entry ?? docId),
      commentCount: t.comments?.length ?? 0,
    })),
  };
}
