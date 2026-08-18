import type { DocMeta } from './mount-context.ts';

/**
 * Read a doc's persisted type + paths from `/api/docs/<id>` before a surface
 * mounts.
 *
 * It lives in its own module rather than inside `app.ts` because `app.ts` runs
 * `main()` on import and therefore cannot be exercised by a test at all — which
 * left the one layer that hand-copies wire fields into `DocMeta` with no
 * coverage anywhere. The router's tests inject `fetchMeta`, so a field dropped
 * HERE is invisible to every one of them.
 *
 * Defaults to a boardless `markdown` doc if the meta can't be read: markdown is
 * the safe surface (it never assumes code), and an unknown board is better sent
 * to the machine index than to a guess.
 */
export async function fetchDocMeta(docId: string): Promise<DocMeta> {
  const fallback: DocMeta = {
    docType: 'markdown',
    sourceUrl: '',
    workspaceId: '',
    relPath: '',
    diffTarget: '',
  };
  try {
    const res = await fetch(`/api/docs/${encodeURIComponent(docId)}`);
    if (!res.ok) return fallback;
    const data = (await res.json()) as {
      meta?: {
        type?: string;
        sourceUrl?: string;
        workspaceId?: string;
        relPath?: string;
        diffTarget?: string;
      };
      // Top-level, NOT under `meta`: `meta.workspaceId` is the GROUPING id of
      // a diff review / folder browse, which is a different thing from the
      // board that holds it. The server resolves one from the other.
      backTo?: { workspaceId?: string; name?: string };
    };
    const t = data.meta?.type;
    const backId = data.backTo?.workspaceId;
    return {
      docType: t === 'code' || t === 'diff' ? t : 'markdown',
      sourceUrl: data.meta?.sourceUrl ?? '',
      workspaceId: data.meta?.workspaceId ?? '',
      relPath: data.meta?.relPath ?? '',
      diffTarget: data.meta?.diffTarget ?? '',
      // A board with no id is no board: `/workspaces/undefined` is worse than
      // the index. A board with no NAME is still a board — `backLinkFor` falls
      // back to showing the id.
      ...(backId ? { backTo: { workspaceId: backId, name: data.backTo?.name ?? '' } } : {}),
    };
  } catch {
    return fallback;
  }
}
