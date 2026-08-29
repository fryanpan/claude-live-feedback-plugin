/**
 * The doc-surface voice dock (§3.8: voice is not board-only). Mounts one mic
 * button + indicator on the review shell; each utterance is anchored to the
 * doc currently open — `{surface:'doc', docId, visibleHeading}`, where
 * `visibleHeading` is the topmost heading on screen (rough scroll awareness,
 * no pixel tracking) — and routed to the doc's hub workspace.
 *
 * Docs attached to no hub workspace still get an answer (voice always
 * answers): a local ack explaining there is nowhere to route to.
 *
 * DOCKED IN THE TOPBAR, not appended to <body>. This surface was the last one
 * still wearing the float: the mic went on the document as a `position: fixed`
 * launcher in the bottom-left corner and sat on top of whatever prose happened
 * to be there — measured at 430, 1000, 1180x820 and 1440, its 44px box covered
 * a paragraph (and at 1000x800 a heading as well) at every scroll position,
 * because a fixed box over a scrolling document is always over something.
 * Nothing under it was a control, which is why this outlived the board's own
 * docking; covering prose on the surface whose entire job is prose is still
 * the same bug.
 *
 * The board docks into a nav rail or a tab bar. This shell has neither — but
 * it does have `#topbar`, a hard 48px row (`#shell`'s
 * `grid-template-rows: 48px 1fr`) that already holds the doc's own controls.
 * Putting the mic at the head of that toolbar costs the layout nothing, cannot
 * cover the document, and gives the readout a positioned box to hang from
 * instead of the viewport corner.
 *
 * The <body> fallback is not dead code: `mountDocVoice` runs once per session
 * from `main()`, before the router has resolved anything, and a shell without
 * a toolbar (a stripped embed, a future surface) should still get a mic rather
 * than none.
 */
import { type User } from '@feedback/core';
import { docIdFromPathOrNull } from './doc-path.ts';
import { MIC_ICON } from './icons.ts';
import { type VoiceAck, createVoiceCapture, visibleHeadingIn } from './voice-capture.ts';

/** The docId of the doc the page is showing, or null elsewhere. */
function docIdFromPath(): string | null {
  return docIdFromPathOrNull(location.pathname);
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
  button.innerHTML = MIC_ICON;
  const indicator = document.createElement('div');
  indicator.id = 'doc-voice';
  indicator.className = 'voice-indicator hidden';
  indicator.setAttribute('aria-live', 'polite');
  // A wrapper of its own, like the board's `.hub-nav-dock`: it is what carries
  // the divider and the gap that say "this is not one more doc button", and
  // what the readout is positioned against.
  const dock = document.createElement('div');
  dock.className = 'doc-nav-dock';
  dock.setAttribute('role', 'group');
  dock.setAttribute('aria-label', 'Voice');
  dock.append(button, indicator);
  // FIRST in the toolbar, so the mic leads the cluster and the divider falls
  // between it and the doc's own actions — the same "at one end, fenced off"
  // shape the rail's foot has. `prepend` on the toolbar rather than the
  // header: `.doc-crumb` is `flex: 1` with `overflow: hidden` and would clip it.
  const toolbar = document.querySelector('#topbar .toolbar');
  if (toolbar) toolbar.prepend(dock);
  else document.body.append(dock);

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
      // The thread this page was opened AT (`?thread=` — how the review
      // queue lands a reader on an item), so a spoken answer goes to it.
      const threadId = new URLSearchParams(location.search).get('thread') || undefined;
      return {
        surface: 'doc',
        ...(docId !== undefined ? { docId } : {}),
        ...(visibleHeading !== undefined ? { visibleHeading } : {}),
        ...(threadId !== undefined ? { threadId } : {}),
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
      // The wrapper goes too, or a teardown leaves an empty divider in the
      // toolbar.
      dock.remove();
      button.remove();
      indicator.remove();
    },
  };
}
