/**
 * The doc-surface voice dock (§3.8: voice is not board-only). Mounts one mic
 * button + indicator on the review shell; each utterance is anchored to the
 * doc currently open — `{surface:'doc', docId, visibleHeading}`, where
 * `visibleHeading` is the topmost heading on screen (rough scroll awareness,
 * no pixel tracking) — and routed to the doc's hub workspace.
 *
 * Docs attached to no hub workspace still get an answer (voice always
 * answers): a local ack explaining there is nowhere to route to.
 */
import { type User } from '@feedback/core';
import { type VoiceAck, createVoiceCapture, visibleHeadingIn } from './voice-capture.ts';

/** The current /review/<docId> docId, or null elsewhere. */
function docIdFromPath(): string | null {
  const m = location.pathname.match(/^\/review\/([^/?#]+)/);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

/**
 * docId → hub workspace id, memoized. Only ATTACHED answers are cached: a doc
 * can be attached to a hub later in the same page load, and caching "not
 * attached" would leave voice unroutable until a reload. A miss costs one
 * round trip; the server re-resolves on every /voice call anyway.
 */
export function createWorkspaceResolver(
  fetchDoc: (docId: string) => Promise<{ hubWorkspaceId?: string } | null>,
): (docId: string) => Promise<string | null> {
  const cache = new Map<string, string>();
  return async (docId: string) => {
    const cached = cache.get(docId);
    if (cached !== undefined) return cached;
    const data = await fetchDoc(docId).catch(() => null);
    const ws = data?.hubWorkspaceId ?? null;
    if (ws) cache.set(docId, ws);
    return ws;
  };
}

export function mountDocVoice(user: User): { destroy(): void } {
  const button = document.createElement('button');
  button.type = 'button';
  button.id = 'doc-mic';
  button.className = 'voice-mic';
  button.title = 'Hold to talk (or hold Space)';
  button.setAttribute('aria-label', 'Hold to talk');
  button.textContent = '🎙';
  const indicator = document.createElement('div');
  indicator.id = 'doc-voice';
  indicator.className = 'voice-indicator hidden';
  indicator.setAttribute('aria-live', 'polite');
  document.body.append(button, indicator);

  const hubWorkspaceOf = createWorkspaceResolver(async (docId) => {
    const res = await fetch(`/api/docs/${encodeURIComponent(docId)}`);
    if (!res.ok) return null;
    return (await res.json()) as { hubWorkspaceId?: string };
  });

  const capture = createVoiceCapture({
    button,
    indicator,
    getContext: () => {
      const docId = docIdFromPath() ?? undefined;
      const editorEl = document.getElementById('editor');
      const visibleHeading = editorEl ? visibleHeadingIn(editorEl) : undefined;
      return {
        surface: 'doc',
        ...(docId !== undefined ? { docId } : {}),
        ...(visibleHeading !== undefined ? { visibleHeading } : {}),
      };
    },
    send: async (transcript, context): Promise<VoiceAck | null> => {
      const docId = context.docId;
      const workspaceId = docId ? await hubWorkspaceOf(docId) : null;
      if (!workspaceId) {
        // Still an answer — never a dead mic.
        return {
          route: 'none',
          ack: `Heard: "${transcript}". This doc isn't attached to a workspace hub, so there's nowhere to route it.`,
        };
      }
      try {
        const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/voice`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            transcript,
            context,
            author: { id: user.id, name: user.name, kind: user.kind, color: user.color },
          }),
        });
        if (!res.ok) return null;
        return (await res.json()) as VoiceAck;
      } catch {
        return null;
      }
    },
    onNavigate: (u) => location.assign(u),
  });

  return {
    destroy: () => {
      capture.destroy();
      button.remove();
      indicator.remove();
    },
  };
}
