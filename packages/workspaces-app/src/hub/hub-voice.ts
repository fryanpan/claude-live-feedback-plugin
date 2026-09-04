/**
 * The board's microphone: where an utterance lands.
 *
 * One responsibility, and it is the anchoring rather than the capture —
 * `voice-capture.ts` owns the hold-to-talk mechanics for every surface. What
 * is here is the board's answer to "what is this person talking ABOUT", which
 * has to be re-derived at the moment they press rather than at boot: the open
 * task panel, or the row their keyboard focus is on, plus the review item the
 * panel is aimed at so "pick the second one" answers THAT one.
 *
 * Exactly ONE capture may be mounted per page — Space is a singleton and two
 * captures would both claim it — so this is a mount, called once from boot,
 * not a render.
 *
 * `HubVoiceDeps` is the whole list of what the mic may reach.
 */
import type { BootLocation } from '../boot-env.ts';
import { type VoiceAck, type VoiceCaptureOpts, createVoiceCapture } from '../voice-capture.ts';
import { type HubState, send } from './hub-actions.ts';
import { voiceHubContext } from './hub-presence-model.ts';

/** Everything the mic needs from `bootHub`, and nothing else. */
export interface HubVoiceDeps {
  /** The board's one projection: what the speaker is looking at. LIVE — read
   *  at press time, never captured at mount. */
  state: HubState;
  /** Who is speaking, stamped on whatever the utterance files. */
  author: { id: string; name: string; kind: string; color?: string };
  /** The board the utterance is addressed to. */
  workspaceId: string;
  /** Read for `document.activeElement` — the focused row is "this ticket"
   *  as much as an open panel is. */
  document: Document;
  /** The address bar: a navigation the ack asks for. */
  location: Pick<BootLocation, 'origin' | 'pathname' | 'assign'>;
  /** `getElementById`, already narrowed — `bootHub`'s own `el`. */
  el(id: string): HTMLElement;
  /** Repaint after an in-place task lookup opened the panel. */
  renderDetail(): void;
  /** Recognition, injectable for the same reason `voice-capture.ts` makes it
   *  injectable: no test environment has SpeechRecognition, and the board's
   *  half of the wiring — what a context names, and where an ack sends the
   *  reader — is only reachable through a completed utterance. Omitted by
   *  `bootHub`, which takes the browser's own. */
  createRecognition?: VoiceCaptureOpts['createRecognition'];
}

/**
 * Mount the board's one voice capture. Call once, from boot.
 */
export function wireHubVoice(deps: HubVoiceDeps): void {
  const { state, author, workspaceId, document, location, el, renderDetail } = deps;

  // Voice (§2.4/§3.8): hold Space or the mic button; the context object sent
  // with each utterance anchors it to wherever the speaker is NOW — the hub
  // board, or the open task detail. Every utterance gets an explicit ack.
  createVoiceCapture({
    button: el('hub-mic'),
    indicator: el('hub-voice'),
    ...(deps.createRecognition ? { createRecognition: deps.createRecognition } : {}),
    // The open detail panel OR the highlighted row — see `voiceHubContext`.
    // Both are "this ticket" to the person holding the mic.
    getContext: () =>
      voiceHubContext(
        state.detailTaskId,
        document.activeElement?.closest<HTMLElement>('.hub-task-row')?.dataset.taskId,
        // The review item the panel is aimed at, so "pick the second one"
        // answers THAT one when the ticket has several.
        state.detailThreadId,
        // Or the ticket's own single review row, when the panel is open on it.
        state.reviewItems,
      ),
    send: async (transcript, context) => {
      const res = await send(`/api/workspaces/${encodeURIComponent(workspaceId)}/voice`, 'POST', {
        transcript,
        context,
        author,
      });
      return res.ok && res.data ? (res.data as unknown as VoiceAck) : null;
    },
    onNavigate: (u) => {
      // A task lookup on this same hub opens the detail in place — the
      // session survives navigation (§3.8); everything else is a page move.
      const url = new URL(u, location.origin);
      const taskParam = url.searchParams.get('task');
      if (taskParam && url.pathname === location.pathname) {
        state.detailTaskId = taskParam;
        renderDetail();
      } else {
        location.assign(u);
      }
    },
  });
}
