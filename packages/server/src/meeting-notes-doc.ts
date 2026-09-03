/**
 * Where composed meeting notes LAND: a named section inside the meeting's
 * own doc, plus the server-side glue that joins the composer to the doc and
 * the project to the composer.
 *
 * THE WRITE GOES THROUGH THE FRAGMENT, NEVER THE FILESYSTEM. A meeting doc
 * is a live bound doc: a file write would be clobbered by the next flush
 * (see the editing-review-docs contract), while a Yjs transaction is an
 * ordinary agent edit — every open browser sees it within a tick, and the
 * write-back observer flushes it to disk like any other.
 *
 * THE SECTION IS FOUND BY ITS HEADING, EVERY TIME. The composer returns the
 * whole notes, so each update must revise the previous section rather than
 * grow the doc — and an anchor or offset would rot the moment a human edits
 * around it. The heading is re-located per write, so the section survives
 * being moved.
 *
 * WHAT REACHES THE DOC IS A MERGE, NOT A REPLACE. `replaceNotesSection`
 * below deletes the section and re-inserts the composed string; run every
 * pause tick, that is the note-taker destroying what the person typed while
 * it was composing, which is exactly what the owner reported. The live sink
 * goes through `mergeNotesSection` instead: it changes only the items the
 * agent itself last wrote, and where the composer wants different words in a
 * person's line it proposes them as a suggestion. `replaceNotesSection` is
 * kept for the first write of a section and for callers that own the whole
 * span; see `meeting-notes-merge.ts` for the invariant and its reasoning.
 *
 * A RENAME REWRITES THE NOTES ALREADY WRITTEN, and does it as a TARGETED
 * replacement rather than a section rewrite (owner, 2026-08-29: "rewrite
 * them" — he does not want the same person reading as "Speaker B" above a
 * rename and by name below it). `relabelNotesSection` replaces only the
 * exact token the composer put there ("Speaker B"), only inside the notes
 * section, and touches nothing else in the doc.
 *
 * It deliberately does NOT go through `replaceNotesSection`, for the same
 * reason the notes sink no longer does: that path replaces the whole section
 * with a string this module composed, discarding whatever the human had
 * typed into it. A rename is a two-word correction and must cost no more
 * than two words. It edits IN PLACE, under the agent's hand, so the sink
 * hands it `reclaimAfterInPlaceEdit` — the ledger has to learn the new
 * wording of its own lines, or the rename would hand every line it touched
 * to the person and the notes would freeze there.
 *
 * A SPOKEN CORRECTION IS THE SAME SHAPE AND A DIFFERENT SUBJECT. "No, I said
 * Thursday" fixes the WORDS of a note rather than the name of a voice, and it
 * arrives from the capture pass rather than from a gesture — but it is the
 * same two-phrase, in-place, ledger-reclaiming edit, so it runs the same way
 * (`applyNotesCorrection`). What it adds is the question a rename never has
 * to ask: whose note is this? A rename can safely sweep everybody's text
 * because it is fixing a name the agent itself wrote; a correction is
 * changing what a note SAYS, so it may rewrite only the agent's own and must
 * propose on anybody else's. That resolution lives in
 * `meeting-notes-correction.ts`.
 *
 * AND THE ENGINE'S OWN LATE CORRECTION IS A THIRD KIND OF EDIT.
 * `reattributeNotesSection` does not change a name; it moves a MENTION from
 * one voice to another, because AssemblyAI's end-of-session pass decided a
 * turn belonged to somebody else. Which mentions move is read off each tag's
 * own provenance rather than off the voice, and — unlike a rename — the walk
 * is scoped to the items the LEDGER still claims. What a voice is called is
 * true wherever it is written; a second thought about who spoke does not get
 * to edit a sentence a person has taken over.
 */

import { type DocType, contentKind } from '@feedback/core';
import * as Y from 'yjs';
import { correctNotesSection } from './meeting-notes-correction.ts';
import {
  type NotesOwnership,
  agentOwnedElements,
  createNotesOwnership,
  mergeNotesSection,
  readNotesSection,
  reclaimAfterInPlaceEdit,
} from './meeting-notes-merge.ts';
import {
  type MeetingNotesDeps,
  type MeetingNotesOptions,
  type NotesCorrection,
  type NotesCorrectionResult,
  type NotesProjectContext,
  type NotesReattribution,
  type NotesRelabel,
  type NotesSectionState,
  type NotesUpdate,
} from './meeting-notes.ts';
import {
  type ResearchFiled,
  type ReviewAsk,
  type TaskCaptureBoard,
  type TaskCaptureLookup,
  normalizedTitle,
  runTaskCapture,
} from './meeting-task-capture.ts';
import { dropLegacyTranscriptSection } from './notes-legacy-transcript.ts';
import {
  MEETING_NOTES_HEADINGS,
  appendResearchPlaceholder,
  reattributeNotesSection,
  relabelNotesSection,
  retagSpeakerInNotes,
} from './notes-section-write.ts';

/**
 * The section writers moved to `notes-section-write.ts`; the names stay on
 * this module's surface, so no caller and no test moved with them.
 */
/** Enough names to inform the composer; few enough that a thousand-row board
 *  cannot flood the prompt. */
const MAX_CONTEXT_TASKS = 30;

export {
  type RelabelNotesResult,
  type ReplaceNotesResult,
  MEETING_NOTES_HEADING,
  MEETING_NOTES_HEADINGS,
  appendResearchPlaceholder,
  reattributeNotesSection,
  relabelNotesSection,
  replaceNotesSection,
  retagSpeakerInNotes,
} from './notes-section-write.ts';

/** The slice of `Rooms` the notes sink needs — narrow so the tests hand in a
 *  map instead of a server. */
export interface NotesDocRooms {
  get(
    docId: string,
  ): { ydoc: Y.Doc; meta: { type: DocType; title?: string; setId?: string } } | undefined;
}

/** The slice of `TaskStore` the context gatherer needs. */
export interface NotesContextTasks {
  listTasks(workspaceId: string): Array<{ title: string; status: string; kind?: 'task' | 'goal' }>;
}

/**
 * One ownership record per meeting doc — what the agent wrote into that
 * doc's notes section, and the ONLY thing separating the agent's own bullets
 * from a person's writing.
 *
 * Per DOC, but its CLAIMS live per meeting: `beginMeeting` releases them when
 * a new session starts on the doc. The ledger used to outlive a meeting so a
 * second meeting could revise the first one's notes — and that is exactly the
 * stop-and-restart data loss the owner reported ("recording replaces all
 * existing notes"): the new session's first tick composes from scratch, so
 * the merge deleted every prior-meeting item the ledger still claimed. Once
 * a recording stops, its notes are written; the next one appends after them
 * and may only SUGGEST on them (owner's call, 2026-08-31: "a stop-and-restart
 * never replaces what is already written").
 *
 * In memory only, so a restarted server claims nothing — which the merge
 * reads as "everything in this section is somebody else's". That is the safe
 * direction: after a restart the note-taker adds and stops replacing, rather
 * than guessing that prose it has never seen is its own.
 */
export interface NotesLedger {
  forDoc(docId: string): NotesOwnership;
  /** A new meeting is starting on this doc: release every claim, so nothing
   *  a previous recording wrote can be replaced by this one. */
  beginMeeting(docId: string): void;
}

export function createNotesLedger(): NotesLedger {
  const byDoc = new Map<string, NotesOwnership>();
  return {
    forDoc(docId) {
      const existing = byDoc.get(docId);
      if (existing) return existing;
      const created = createNotesOwnership();
      byDoc.set(docId, created);
      return created;
    },
    beginMeeting(docId) {
      byDoc.get(docId)?.release();
    },
  };
}

/**
 * Write one composed update into its meeting doc, keeping every item the
 * agent did not write. False — never a throw — when the doc is gone or is
 * not prose: a meeting on a vanished doc still has its transcript file, and
 * a flat doc is not a notepad.
 */
export function applyNotesUpdate(
  rooms: NotesDocRooms,
  update: NotesUpdate,
  ledger: NotesLedger,
): boolean {
  const room = rooms.get(update.docId);
  if (!room) return false;
  if (contentKind(room.meta.type) !== 'prose') return false;
  // NO TRANSCRIPT IN THIS DOC (owner, 2026-09-03). A tick used to append the
  // meeting's own words here under `## Raw transcript`. It does not any more:
  // the notes are the shorter record a person has reviewed and edited, and
  // that is what both people and agents should be reading. A transcript is
  // unreviewed raw material, kept only to check exactly who said what and to
  // improve how we transcribe, so it belongs in the `-raw-transcript.md`
  // sister file beside the meeting's data dir. This call takes the section
  // back out of any doc that received one while the writer shipped; the words
  // are in that sister file already, so the removal loses nothing.
  const legacy = dropLegacyTranscriptSection(room.ydoc);
  if (legacy === 'kept') {
    console.log(
      `[meeting-notes] legacy transcript section left in ${update.docId}: ` +
        'somebody has written in it',
    );
  }
  return mergeNotesSection(room.ydoc, update.notes, MEETING_NOTES_HEADINGS, {
    ownership: ledger.forDoc(update.docId),
    ...(update.basedOn ? { basedOn: update.basedOn } : {}),
  }).ok;
}

/** The notes section as it currently reads, for the composer's `previous`. */
export function readNotesState(
  rooms: NotesDocRooms,
  ids: { docId: string; meetingId: string },
  ledger: NotesLedger,
): NotesSectionState | null {
  const room = rooms.get(ids.docId);
  if (!room) return null;
  if (contentKind(room.meta.type) !== 'prose') return null;
  return readNotesSection(room.ydoc, MEETING_NOTES_HEADINGS, ledger.forDoc(ids.docId));
}

/**
 * Carry a rename into the notes already written in the meeting's doc.
 * Same tolerances as `applyNotesUpdate`: a doc that has gone away or was
 * never prose is not an error, it is a meeting whose notes are elsewhere.
 * Returns how many mentions moved — zero when the voice was never written
 * about, which is ordinary.
 *
 * TWO PASSES, AND THE ORDER IS NOT ARBITRARY. The tags go first and always:
 * they name the voice by label, so they are right whatever anybody is
 * called. The plain-text sweep runs second and only when the relabel says it
 * may — it is what reaches notes composed before tags existed, and it is
 * also the pass that cannot tell two voices with one name apart. Running it
 * second means a mention that was already retagged is no longer spelled the
 * old way, so the sweep has nothing left to find there and cannot touch it
 * twice.
 */
export function applyNotesRelabel(
  rooms: NotesDocRooms,
  relabel: NotesRelabel,
  ledger: NotesLedger,
): number {
  const room = rooms.get(relabel.docId);
  if (!room) return 0;
  if (contentKind(room.meta.type) !== 'prose') return 0;
  // Through the reclaim wrapper, not straight at the doc: the rename edits
  // the agent's own lines in place, and the ledger has to come out the other
  // side still recognising them. See `reclaimAfterInPlaceEdit`.
  return reclaimAfterInPlaceEdit(
    room.ydoc,
    MEETING_NOTES_HEADINGS,
    ledger.forDoc(relabel.docId),
    () => {
      // The untagged sweep runs FIRST, and the order is load-bearing. It
      // looks for the old display name on word boundaries, and an extension
      // rename leaves that name inside the new one — retag first and the
      // sweep finds "Devi" inside the "@Devi Raman" it has just written, and
      // makes it "@Devi Raman Raman". Sweeping first, the sweep sees only the
      // old spelling everywhere it appears, and the retag that follows
      // canonicalises every tag for this voice — including any the sweep had
      // no way to reach, and including the ones it has just corrected, where
      // it finds the right text already there and does nothing.
      const swept = relabel.rewriteUntagged
        ? relabelNotesSection(room.ydoc, relabel.from, relabel.to).replaced
        : 0;
      return swept + retagSpeakerInNotes(room.ydoc, relabel.label, relabel.to).replaced;
    },
  );
}

/**
 * Carry a spoken correction into the note it fixes.
 *
 * Same tolerances as `applyNotesUpdate` and `applyNotesRelabel`: a doc that
 * has gone away or was never prose is not an error, it is a meeting whose
 * notes are somewhere this cannot reach. `'none'` covers all of those and the
 * ordinary case besides — a correction whose words are in no note.
 *
 * THROUGH THE RECLAIM WRAPPER, for the reason the rename is: the revision
 * edits the agent's own bullet IN PLACE, so the ledger's record of that
 * bullet's wording goes stale the moment it lands. Without the wrapper the
 * correction would hand every note it fixed to the person — the next tick
 * could only propose on it — and the notes would freeze at the correction.
 * The wrapper re-records only lines the ledger ALREADY claimed, so a note the
 * person had made theirs stays theirs.
 */
export function applyNotesCorrection(
  rooms: NotesDocRooms,
  correction: NotesCorrection,
  ledger: NotesLedger,
): NotesCorrectionResult {
  const room = rooms.get(correction.docId);
  if (!room) return 'none';
  if (contentKind(room.meta.type) !== 'prose') return 'none';
  const ownership = ledger.forDoc(correction.docId);
  const outcome = reclaimAfterInPlaceEdit(room.ydoc, MEETING_NOTES_HEADINGS, ownership, () =>
    correctNotesSection(room.ydoc, MEETING_NOTES_HEADINGS, ownership, correction),
  );
  if (outcome.applied === 'revised') return 'revised';
  if (outcome.applied === 'suggested') return 'suggested';
  return 'none';
}

/**
 * Carry the engine's late correction of who spoke into the meeting's doc.
 * Same tolerances as `applyNotesRelabel`, and the same reclaim wrapper: this
 * edits the agent's own lines in place, so the ledger has to come out the
 * other side still recognising them.
 */
export function applyNotesReattribution(
  rooms: NotesDocRooms,
  reattribution: NotesReattribution,
  ledger: NotesLedger,
): number {
  const room = rooms.get(reattribution.docId);
  if (!room) return 0;
  if (contentKind(room.meta.type) !== 'prose') return 0;
  const ownership = ledger.forDoc(reattribution.docId);
  // Read BEFORE the edit, for the same reason `reclaimAfterInPlaceEdit`
  // snapshots there: ownership is element AND text, and the edit changes the
  // text. Afterwards the ledger would no longer claim the very lines this is
  // allowed to touch.
  const owned = agentOwnedElements(room.ydoc, MEETING_NOTES_HEADINGS, ownership);
  if (owned.size === 0) return 0;
  return reclaimAfterInPlaceEdit(
    room.ydoc,
    MEETING_NOTES_HEADINGS,
    ownership,
    () => reattributeNotesSection(room.ydoc, reattribution, owned).replaced,
  );
}

/**
 * Wire caller options into the deps a meeting session runs on: the doc write
 * becomes the sink (a caller `onNotes` observes after it), and the context
 * resolver reads the doc's title and its board's open task titles at meeting
 * start — the "informed, not generic" half of the notes agent.
 *
 * `rooms` / `tasks` are thunks because `createServer` builds the relay before
 * either exists; a meeting can only start once both do.
 */
export function withServerNotesSinks(
  options: MeetingNotesOptions,
  deps: {
    rooms: () => NotesDocRooms;
    tasks: () => NotesContextTasks;
    /** The store the capture pipeline writes through. A thunk like `tasks`,
     *  and only read when `taskExtractor` is present. */
    captureBoard?: () => TaskCaptureBoard;
    /** Where a "pull that in" ask looks: the board's docs and their past
     *  meetings. Absent, lookups resolve to nothing and the notes are as
     *  they were. */
    lookup?: TaskCaptureLookup;
    /** The lead wake for a captured task judged clear enough to start —
     *  wired to the ready-nudge channel by the server. */
    onTaskReady?: (wake: { workspaceId: string; taskId: string; title: string }) => void;
    /**
     * The board a doc's meeting files onto. A huddle doc has no `setId` —
     * it is HELD by a hub workspace, not owned by one — so scoping capture
     * on `meta.setId` alone silently returned nothing for exactly the docs
     * meetings run on. Absent, `meta.setId` is the whole answer.
     */
    boardOf?: (docId: string) => string | undefined;
    /** Observes a research row after the doc's placeholder is written. */
    onResearchFiled?: (filed: ResearchFiled) => void;
    /** Files a spoken review ask the way the Review float's press is filed —
     *  only `createServer` holds the comment + stamp path. Deduped here per
     *  meeting so a question repeated across ticks opens one thread. */
    onReviewAsk?: (ask: ReviewAsk) => void | Promise<void>;
    /** Tests: an ownership ledger they can seed or read back. */
    ledger?: NotesLedger;
  },
): MeetingNotesDeps {
  const extractor = options.taskExtractor;
  const captureBoard = deps.captureBoard;
  // One ledger per wiring, i.e. per server: it is keyed by doc and meeting,
  // and a meeting is the life of one notes section.
  const ledger = deps.ledger ?? createNotesLedger();
  const boardOf = (docId: string): string | undefined => {
    const room = deps.rooms().get(docId);
    return room?.meta.setId ?? deps.boardOf?.(docId);
  };
  // Review asks already filed this meeting, by normalized question. The
  // capture's own dedupe covers a request seen twice in one tick's window;
  // this covers "ask the team whether X" said again ten minutes later.
  const reviewAsked = new Map<string, Set<string>>();
  const captureIntents: MeetingNotesDeps['captureIntents'] =
    options.captureIntents ??
    (extractor && captureBoard
      ? async ({ docId, turns, priorTurns }) => {
          // The doc's board is the capture's scope: a meeting on a doc no
          // workspace owns or holds has no board to find or create on.
          const room = deps.rooms().get(docId);
          const workspaceId = boardOf(docId);
          if (!room || !workspaceId) return { tasks: [], docs: [] };
          return runTaskCapture(
            {
              board: captureBoard(),
              extractor,
              ...(deps.lookup ? { lookup: deps.lookup } : {}),
              ...(deps.onTaskReady ? { onTaskReady: deps.onTaskReady } : {}),
              onResearchFiled: (filed) => {
                const target = deps.rooms().get(filed.docId);
                if (target) {
                  const wrote = appendResearchPlaceholder(target.ydoc, filed.title, filed.url);
                  if (!wrote.ok) {
                    console.error(`[meeting-tasks] research placeholder failed: ${wrote.error}`);
                  }
                }
                deps.onResearchFiled?.(filed);
              },
              ...(deps.onReviewAsk
                ? {
                    onReviewAsk: async (ask: ReviewAsk) => {
                      const key = normalizedTitle(ask.question);
                      let seen = reviewAsked.get(ask.docId);
                      if (!seen) {
                        seen = new Set();
                        reviewAsked.set(ask.docId, seen);
                      }
                      if (seen.has(key)) return;
                      seen.add(key);
                      await deps.onReviewAsk?.(ask);
                    },
                  }
                : {}),
              onError: (message) => console.error(`[meeting-tasks] ${message}`),
            },
            {
              workspaceId,
              docId,
              ...(room.meta.title !== undefined ? { docTitle: room.meta.title } : {}),
              turns,
              priorTurns,
            },
          );
        }
      : undefined);
  return {
    ...options,
    ...(captureIntents ? { captureIntents } : {}),
    onSessionStart: (ids): void => {
      // A new recording on this doc: whatever the previous one wrote is
      // finished writing. Releasing the claims is what makes stop-and-restart
      // append instead of replace — the reported data-loss bug.
      ledger.beginMeeting(ids.docId);
      reviewAsked.delete(ids.docId);
      options.onSessionStart?.(ids);
    },
    resolveContext: (docId: string): NotesProjectContext | undefined => {
      const gathered: NotesProjectContext = {};
      try {
        const room = deps.rooms().get(docId);
        if (room?.meta.title) gathered.docTitle = room.meta.title;
        const workspaceId = boardOf(docId);
        if (workspaceId) {
          gathered.workspaceId = workspaceId;
          const titles = deps
            .tasks()
            .listTasks(workspaceId)
            .filter((t) => t.kind !== 'goal' && t.status !== 'done')
            .slice(0, MAX_CONTEXT_TASKS)
            .map((t) => t.title);
          if (titles.length > 0) gathered.taskTitles = titles;
        }
      } catch (err) {
        // Context is an enhancement to the notes, never a dependency: a
        // store that cannot answer must not cost the meeting its notes.
        console.error('[meeting-notes] context gather failed:', err);
      }
      // Caller-supplied context wins field-by-field: whoever wired the
      // server said something more specific than what we can gather.
      const supplied = options.resolveContext?.(docId) ?? options.context;
      const merged = { ...gathered, ...supplied };
      return Object.keys(merged).length > 0 ? merged : undefined;
    },
    readSection: (ids: { docId: string; meetingId: string }): NotesSectionState | null => {
      try {
        return readNotesState(deps.rooms(), ids, ledger);
      } catch (err) {
        // A section we cannot read costs the compose its awareness of the
        // person's writing, never its notes.
        console.error('[meeting-notes] section read failed:', err);
        return null;
      }
    },
    onNotes: (update: NotesUpdate): void => {
      try {
        if (!applyNotesUpdate(deps.rooms(), update, ledger)) {
          console.error(`[meeting-notes] doc write skipped for ${update.docId}`);
        }
      } catch (err) {
        // The session chain treats an onNotes throw as a failed compose and
        // carries the words — wrong for notes that DID compose. Contain it.
        console.error('[meeting-notes] doc write failed:', err);
      }
      options.onNotes?.(update);
    },
    onRelabel: (relabel: NotesRelabel): void => {
      try {
        applyNotesRelabel(deps.rooms(), relabel, ledger);
      } catch (err) {
        // A rename that cannot reach the doc leaves a stale label, which is
        // a blemish; letting it reach the compose chain as a rejection would
        // cost the meeting its next notes, which is not.
        console.error('[meeting-notes] relabel failed:', err);
      }
      options.onRelabel?.(relabel);
    },
    onCorrection: (correction: NotesCorrection): NotesCorrectionResult => {
      try {
        const result = applyNotesCorrection(deps.rooms(), correction, ledger);
        options.onCorrection?.(correction);
        return result;
      } catch (err) {
        // A correction that cannot reach the doc leaves a note reading the
        // way the room already said it does not; letting the throw reach the
        // compose chain would cost the meeting its next notes, which is
        // worse. Same containment as the relabel above.
        console.error('[meeting-notes] correction failed:', err);
        return 'none';
      }
    },
    onReattribute: (reattribution: NotesReattribution): void => {
      try {
        applyNotesReattribution(deps.rooms(), reattribution, ledger);
      } catch (err) {
        // Same containment as the relabel above: an attribution left stale
        // is a blemish, and a rejection reaching the compose chain would
        // cost the meeting its next notes.
        console.error('[meeting-notes] reattribution failed:', err);
      }
      options.onReattribute?.(reattribution);
    },
  };
}
