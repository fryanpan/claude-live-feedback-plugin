/**
 * The network half of the notes' link affordances: which rows this doc is
 * linked from, and the two writes that change that.
 *
 * Kept apart from the editor plugin because the plugin's job is a decoration
 * and a tap, and both of those have to be synchronous. This holds the set the
 * plugin is told about, and the two routes — the SAME routes the MCP verbs
 * `link_refs` and `unlink_refs` reach, writing the same `{kind:'doc'}` ref
 * the meeting writes when it hears "link that to the existing task". A second
 * ref shape here would produce a link the note could make and never remove.
 */
import { api } from '../doc-path.ts';

/** The ref a note's link puts on a row. Mirrors `spokenLinkRef` on the
 *  server, which is what the meeting itself writes. */
function docRef(docId: string): { kind: 'doc'; docId: string } {
  return { kind: 'doc', docId };
}

export interface NotesLinkRefs {
  /** Rows this doc is currently linked from, as last read. */
  linked(): ReadonlySet<string>;
  /** Re-read it. Never throws: a failed read leaves the last answer standing,
   *  which costs an undo control its accuracy and costs the note nothing. */
  refresh(): Promise<void>;
  link(taskId: string): Promise<boolean>;
  unlink(taskId: string): Promise<boolean>;
}

type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;

export function createNotesLinkRefs(docId: string, fetchImpl?: Fetcher): NotesLinkRefs {
  const call: Fetcher = fetchImpl ?? ((path, init) => fetch(path, init));
  let linked: ReadonlySet<string> = new Set();

  const write = async (method: 'POST' | 'DELETE', taskId: string): Promise<boolean> => {
    try {
      const res = await call(api(`tasks/${encodeURIComponent(taskId)}/links`), {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ref: docRef(docId) }),
      });
      return res.ok;
    } catch {
      // A write that never left the browser must not edit the note: the
      // whole point of the affordance is that the doc and the row agree.
      return false;
    }
  };

  return {
    linked: () => linked,
    async refresh(): Promise<void> {
      try {
        const res = await call(api(`docs/${encodeURIComponent(docId)}/tasks`));
        if (!res.ok) return;
        const body = (await res.json()) as { tasks?: Array<{ id?: string }> };
        linked = new Set(
          (body.tasks ?? []).map((t) => t.id).filter((id): id is string => typeof id === 'string'),
        );
      } catch {
        // Same rule as a failed write: the last good answer stands.
      }
    },
    link: (taskId) => write('POST', taskId),
    unlink: (taskId) => write('DELETE', taskId),
  };
}
