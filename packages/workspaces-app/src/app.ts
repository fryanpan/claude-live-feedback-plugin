import type { FeedbackClient, User } from '@feedback/core';
import type { BootLocation, BootStorage, BootWindow } from './boot-env.ts';
import { mountCode } from './code/code-app.ts';
import { fetchDocMeta } from './doc-meta.ts';
import { el, showToast } from './doc/chrome-dom.ts';
import { wireThreadRangeClicks } from './doc/chrome-panels.ts';
import { type CommentPillHandle, mountCommentPill } from './doc/doc-comment-pill.ts';
import { mountDocFloats } from './doc/doc-floats.ts';
import { wireDocGates } from './doc/doc-gates.ts';
import { mountDocMargin } from './doc/doc-margin.ts';
import { mountDocMeeting } from './doc/doc-meeting-mount.ts';
import { mountPointerPillLayer } from './doc/doc-pointer-pill.ts';
import { wireDocReady } from './doc/doc-ready.ts';
import { mountDocSaveState } from './doc/doc-save-state.ts';
import { mountDocSetNav } from './doc/doc-set-nav.ts';
import { wireEditViewport } from './edit-viewport.ts';
import { type EditorHandle, createEditor } from './editor.ts';
import { wantsHuddleStart } from './huddle-entry.ts';
import { ensureUserIdentity } from './identity-prompt.ts';
import { wireKeyboardInset } from './keyboard-inset.ts';
import type { LeadBanner } from './lead-banner.ts';
import type { MeetingLiveZone } from './meeting-live-zone.ts';
import type { MountContext } from './mount-context.ts';
import { startReadingTracker } from './reading-tracker.ts';
import { mountRedline } from './redline/redline-app.ts';
import { type ReviewChrome, mountReviewChrome } from './review-chrome.ts';
import { navigateTo, startRouter } from './router.ts';
import { fetchWriteAccess, installWriteGateNotice, showSignInBar } from './signin/write-gate.ts';
import { mountSpeakerReassign } from './speaker-reassign-menu.ts';
import { loadDocVoices } from './speaker-voices.ts';
import { installStaleClientNotice } from './stale-client.ts';
import { registerMarkdownMount } from './surface-registry.ts';

/**
 * Everything the document editor's boot reaches outside its own module.
 *
 * The page passes the real globals at the bottom of this file; a test passes a
 * throwaway document, a synthetic address, a Map-backed store and a fake
 * socket. `mountMarkdown` below is NOT part of this: it is a per-document mount
 * the router runs, and it keeps reading the ambient DOM it renders into.
 */
export interface AppBootEnv {
  document: Document;
  location: BootLocation;
  localStorage: BootStorage;
  window: BootWindow;
  connect: (url: string) => FeedbackClient;
}

/**
 * One-time app bootstrap: the persistent shell (keyboard inset, doc-switcher)
 * plus the router. Everything document-specific is a per-doc mount the router
 * runs; navigation swaps mounts in place with no reload.
 *
 * Nothing here runs on import any more — the one call at the bottom of this
 * file starts the page. The destructure re-binds each injected thing to the
 * name it had as a global, so the sequence reads as it did and what changed is
 * only where those names come from.
 */
export async function bootApp(env: AppBootEnv): Promise<void> {
  const { document, location, localStorage, window, connect } = env;

  const DEFAULT_WS_PATH = (docId: string, type: string) =>
    `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/y/${encodeURIComponent(docId)}?type=${encodeURIComponent(type)}`;

  /**
   * Wire the topbar doc-switcher dropdown ONCE (shell-level, doc-independent).
   * The dropdown's CONTENTS are repopulated per navigation by the sidebar
   * renderers; only the open/close behaviour lives here.
   */
  function wireDocSwitcher(): void {
    const docMenu = document.getElementById('doc-menu');
    const docSwitcher = document.getElementById('doc-switcher') as HTMLButtonElement | null;
    if (!docSwitcher || !docMenu) return;
    const close = () => {
      docMenu.classList.add('hidden');
      docMenu.setAttribute('aria-hidden', 'true');
      docSwitcher.setAttribute('aria-expanded', 'false');
    };
    docSwitcher.addEventListener('click', (ev) => {
      if (!document.body.classList.contains('has-set')) return;
      ev.stopPropagation();
      const isOpen = !docMenu.classList.contains('hidden');
      docMenu.classList.toggle('hidden', isOpen);
      docMenu.setAttribute('aria-hidden', String(isOpen));
      docSwitcher.setAttribute('aria-expanded', String(!isOpen));
    });
    document.addEventListener('click', (ev) => {
      if (docMenu.classList.contains('hidden')) return;
      if (!docMenu.contains(ev.target as Node) && !docSwitcher.contains(ev.target as Node)) close();
    });
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && !docMenu.classList.contains('hidden')) close();
    });
    // Auto-close on scroll. The dropdown overlays the doc, and on mobile the
    // user reaching the content is the strongest "I'm done with the nav" signal.
    const closeOnScroll = () => {
      if (!docMenu.classList.contains('hidden')) close();
    };
    document.getElementById('editor')?.addEventListener('scroll', closeOnScroll, { passive: true });
    window.addEventListener('scroll', closeOnScroll, { passive: true });
  }

  // Before anything can write: a refused write raises a sign-in prompt
  // wherever it happened, rather than a "try again" this person can never
  // satisfy. See signin/write-gate.ts.
  installWriteGateNotice();
  wireKeyboardInset();
  wireDocSwitcher();
  const asParam = new URL(location.href).searchParams.get('as');
  // May this browser write at all? Asked BEFORE the name prompt, because the
  // answer decides whether that prompt should be shown: where the server
  // requires a session, "what shall we call you?" is a modal that blocks boot
  // to collect a name the server will not accept, in place of the one
  // question this person actually has to answer.
  const writeAccess = await fetchWriteAccess();
  if (!writeAccess.canWrite) showSignInBar();
  // First arrival with no stored name shows the name prompt; this awaits the
  // user's answer (or skip) before anything connects, so awareness, comments,
  // and edits all carry the chosen identity from the first packet.
  const user: User = await ensureUserIdentity(
    asParam,
    {
      get: (k) => localStorage.getItem(k),
      set: (k, v) => localStorage.setItem(k, v),
    },
    writeAccess.canWrite ? {} : { suppressNamePrompt: true },
  );
  registerMarkdownMount(mountMarkdown);
  startRouter({
    user,
    // The answer is already in hand — every mount gets it as a value rather
    // than asking again. A mount that re-asks is editable while it waits.
    canWrite: writeAccess.canWrite,
    fetchMeta: fetchDocMeta,
    connectFor: (docId, docType) => {
      const client = connect(DEFAULT_WS_PATH(docId, docType));
      installStaleClientNotice(client);
      return client;
    },
    mountFor: (ctx) => {
      // A MARKDOWN file in a diff review reads as prose → Word-style redline;
      // other code/diff docs → CodeMirror source; everything else → Tiptap.
      // (redline falls back to code when the base text is unavailable.)
      if (ctx.docType === 'diff' && ctx.relPath.toLowerCase().endsWith('.md')) {
        return mountRedline(ctx);
      }
      if (ctx.docType === 'code' || ctx.docType === 'diff') return mountCode(ctx);
      return mountMarkdown(ctx);
    },
  });
}

/** Per-document mount for the markdown (Tiptap) surface.
 *
 *  What is left here is the ORDER, and only the order: connect, editor,
 *  chrome, margin, floats, selection affordances, navigation, gates. Each
 *  phase is a module under `doc/` that takes an explicit context, so this
 *  function reads as the sequence a document boots in rather than as the
 *  sum of everything a document does.
 *
 *  Two things stay here on purpose. The forward refs — `chrome`, `pill`,
 *  `editViewport` — because the editor's callbacks can fire during the first
 *  Yjs application, before the phase that owns them has run. And the reads of
 *  the ADDRESS (`?huddle=`, `?thread=`), because the address is what this
 *  mount was opened at; the modules act on what it says.
 *
 *  Every listener is bound to `ctx.scope`; the router disposes the scope on
 *  navigation, which tears down the editor, chrome, listeners, and (via the
 *  router) the client. */
async function mountMarkdown(ctx: MountContext): Promise<void> {
  const { docId, client, user, scope } = ctx;
  // Which docId the sidebar marks active — differs from `docId` only for the
  // editable File view of a .md diff member (see MountContext.navDocId).
  const navDocId = ctx.navDocId ?? docId;
  const { ydoc, awareness } = client;
  awareness.setLocalStateField('user', { name: user.name, color: user.color });

  // The thread panel / composer / thread-view / drawer elements are owned
  // by the shared review chrome; only the markdown-specific elements are here.
  const editorMount = el<HTMLElement>('editor');
  const composer = el<HTMLElement>('composer');
  const commentPill = el<HTMLButtonElement>('comment-pill');
  // The pill's markup says "Add comment" because that is all it ever did, and
  // on a huddle doc that is now all it leads to as well. It was relabelled
  // "Turn this line into work" here while a range selection grew a pill
  // offering Research and Create Task (see doc/doc-pointer-pill.ts); those
  // went on 2026-09-04, so the label goes with them rather than promising a
  // menu of work that no longer opens.
  const huddle = ctx.huddle === true;
  const formatBar = el<HTMLElement>('format-bar');
  const toggleFormat = el<HTMLButtonElement>('toggle-format');
  const toggleEditMode = el<HTMLButtonElement>('toggle-edit-mode');
  // Declared beside the edit toggle, not down in the Suggesting section
  // that wires it: the write gate locks BOTH, and it runs first.
  const toggleSuggestMode = el<HTMLButtonElement>('toggle-suggest-mode');
  /**
   * Whether the server will accept writes from this browser.
   *
   * One flag, read by BOTH toggles — either one of them makes the document
   * editable and it only takes one to lose a person's writing — and by the
   * chrome that describes what this surface IS. Declared this high because
   * the save-state chip reads it, and that renders long before the toggles
   * are wired.
   *
   * The server's answer, carried in on the MountContext — not a hopeful
   * `true` narrowed later. It used to start `true` and be corrected one
   * round trip after the mount, and everything this flag guards was open
   * for the length of that trip.
   */
  const canWrite = ctx.canWrite;

  // Forward ref: the chrome is mounted right after the editor, but editor
  // callbacks can fire during initial Yjs application — guard until set.
  // biome-ignore lint/style/useConst: assigned after createEditor so its callbacks can close over it
  let chrome: ReviewChrome | undefined;
  // Same forward-ref shape as `chrome`: the editor's selection callback fires
  // during the first Yjs application, before the pill phase has run.
  // biome-ignore lint/style/useConst: assigned in the selection-affordance phase below
  let pill: CommentPillHandle | undefined;
  // Same shape again: the chrome's selection callback can fire before the
  // meeting strip has mounted and the viewport is wired.
  // biome-ignore lint/style/useConst: assigned after the meeting strip mounts
  let editViewport: ReturnType<typeof wireEditViewport> | undefined;
  // Forward ref, same shape as `chrome`: the zone is created down where the
  // meeting strip mounts (it only exists on docs that can hold a meeting),
  // but the wash extension must be declared at editor construction.
  let liveZone: MeetingLiveZone | undefined;
  const editor: EditorHandle = createEditor({
    parent: editorMount,
    ydoc,
    awareness,
    onSelectionChange: () => pill?.refreshSelection(),
    onUpdate: () => chrome?.redrawThreads(),
    user: { name: user.name, color: user.color },
    // Workspace members (folder binds, diff File views — ctx spreads through
    // mountEditableFileView) get in-app navigation for relative sibling links.
    docLink: ctx.workspaceId
      ? { workspaceId: ctx.workspaceId, relPath: ctx.relPath, navigate: navigateTo }
      : undefined,
    // Inert until the zone exists AND a meeting is (recently) live; the
    // zone's bot fallback rides the same signal.
    settleWash: {
      isLive: () => liveZone?.washActive() ?? false,
      onNotesInsert: () => liveZone?.clearSettled(),
    },
  });
  // Editor teardown runs before the client closes (LIFO — client.close was
  // registered first by the router), so the y-prosemirror binding detaches
  // before its ydoc is destroyed.
  scope.onCleanup(() => editor.destroy());

  chrome = mountReviewChrome({
    docId,
    user,
    ydoc,
    surface: editor,
    whenSynced: (cb) => client.onReady(cb),
    scope,
    canWrite,
    labelHint: ctx.sourceUrl || ctx.relPath || undefined,
    selectHint: 'Select some text first to leave a comment.',
    reanchorHint: 'Select new text first, then click Re-anchor.',
    // The pill controller's cached selection covers iOS blurring the editor
    // between the pill appearing and being tapped. `currentSelection` already
    // encodes a resolved range (from PM in edit mode, or from the raw DOM
    // selection in view mode) — don't also require a non-empty PM selection,
    // which is always empty in view mode even with a live DOM selection and
    // would wrongly block iOS long-press commenting.
    getSelection: () => pill?.currentSelection() ?? editor.getSelectionRel(),
    onComposerOpened: () => pill?.onComposerOpened(),
    onPosted: () => {
      // Drop focus so no caret blinks in the doc after posting.
      editor.editor.commands.blur();
      (document.activeElement as HTMLElement | null)?.blur?.();
    },
    hidePill: () => pill?.hide(),
    // The markdown surface mounts the balloon margin unconditionally below.
    hasBalloonMargin: true,
  });
  const reviewChrome = chrome;

  // Everything that reports on comments the reader is not looking at: the
  // balloon margin, the doc-level suggestions badge, and the off-screen
  // comment hints — one loop, redrawn together on every editor transaction.
  const margin = mountDocMargin({
    docId,
    ydoc,
    scope,
    editor,
    editorMount,
    chrome: reviewChrome,
  });

  // Interaction-bounded reading-session capture (doc_open + read_session).
  // The #editor element is the scroll container on the markdown surface.
  scope.onCleanup(startReadingTracker({ docId, user, scrollEl: editorMount }));

  // Opened by the Board's "Make a plan" / "Have a meeting": the address carries
  // a flag, and the strip asks for the mic at once instead of waiting for a
  // press. Read ONCE, here, because the strip block below takes the flag back
  // out of the address — and the edit-mode decision that also needs it runs
  // much later, by which time `location.search` no longer says anything.
  const startedHuddleHere = wantsHuddleStart(location.search);
  // The lead banner's read and stream, handed to the floats below so their
  // receipts can say "no lead attached" off the same answer. Set only
  // on a huddle doc; the floats read as before without it.
  let watchLeadPresence: LeadBanner['watch'] | undefined;
  // Live-meeting transcript strip along the bottom of the editor pane — the
  // whole surface (strip, live zone, bot client, lead banner) mounts together
  // in doc/doc-meeting-mount.ts. Bound to this scope, so navigating away
  // closes the audio socket and releases the microphone.
  //
  // Ordinary markdown docs only. A `.md` diff member's File view mounts this
  // same surface over a companion doc (that is what `navDocId` marks), and a
  // review of somebody's branch is not a place a meeting is recorded.
  const meetingStripEl = document.getElementById('meeting-strip');
  if (meetingStripEl && ctx.docType === 'markdown' && ctx.navDocId === undefined) {
    const meeting = mountDocMeeting({
      docId,
      stripEl: meetingStripEl,
      scope,
      editor,
      editorMount,
      user,
      awareness,
      huddleStart: startedHuddleHere,
      huddle,
    });
    liveZone = meeting.liveZone;
    watchLeadPresence = meeting.watchLeadPresence;
  }

  // The two always-in-view floats — Approve (the plan gate) and Review.
  // Same rule (and reason) as the meeting strip above: a review of somebody's
  // branch, or a companion doc under `navDocId`, is not a plan a person
  // approves.
  if (ctx.docType === 'markdown' && ctx.navDocId === undefined) {
    mountDocFloats({
      docId,
      root: editorMount,
      ydoc,
      user,
      canWrite,
      scope,
      ...(watchLeadPresence ? { watchLeadPresence } : {}),
    });
  }

  // Tapping a speaker tag in the notes offers the voices this doc's meetings
  // had. Mounted whatever the doc type, and independent of the strip: notes
  // outlive the meeting that produced them, and correcting an attribution a
  // week later is the ordinary case rather than the exotic one.
  const reassign = mountSpeakerReassign({
    editor: editor.editor,
    loadVoices: () => loadDocVoices(docId),
    // Permission, not mode: a reader in view mode may still fix an
    // attribution, and a reader without write access may not.
    canWrite: () => canWrite,
  });
  scope.onCleanup(() => reassign.destroy());

  // Editing under an on-screen keyboard: the meeting strip gives its grid row
  // back while a phone-width editor has focus, and the caret is kept above
  // whatever the keyboard is covering. See edit-viewport.ts for both rules.
  editViewport = wireEditViewport({
    roots: () => [editorMount, composer],
    scroller: () => editorMount,
    strip: () => meetingStripEl,
    caretRect: () => {
      const view = editor.editor.view;
      // View mode never focuses the editor; there is no caret to follow and
      // no keyboard that could be covering one.
      if (!view.dom.contains(document.activeElement)) return null;
      try {
        const c = view.coordsAtPos(view.state.selection.head);
        return { top: c.top, bottom: c.bottom };
      } catch {
        // A head position that has not been rendered yet (a fresh mount, a
        // remote edit mid-frame) throws rather than returning coordinates.
        return null;
      }
    },
    listen: (t, type, h, o) => scope.listen(t, type, h, o),
    onCleanup: (fn) => scope.onCleanup(fn),
  });

  // ---- Selection affordances ----
  // Two modules, wired in the order they depend on each other: the pointer
  // pill a huddle doc grows over a range (doc-pointer-pill), and the round
  // comment pill that owns the cached selection it reads (doc-comment-pill).
  //
  // There was a third — `createSpinoffRunner`, which turned a selection into
  // a board row or a research section. Nothing calls it from here as of
  // 2026-09-04: the pill offers only Comment, and the ask is made in the
  // comment. `doc/doc-spinoff.ts` and the routes behind it are untouched.
  const pointer = mountPointerPillLayer({
    huddle,
    editor,
    editorMount,
    scope,
    getSelection: () => pill?.currentSelection() ?? null,
    hideAll: () => pill?.hide(),
    openComposer: () => reviewChrome.openComposer(),
  });
  pill = mountCommentPill({
    huddle,
    editor,
    editorMount,
    composer,
    commentPill,
    scope,
    pointer,
    openComposer: () => reviewChrome.openComposer(),
    follow: () => editViewport?.follow(),
  });

  // Tap-on-highlight in the editor → focus the thread.
  //   • A visible balloon for it → scroll the balloon into view.
  //   • Mobile: full-screen thread view (Notion pattern — gives the
  //     conversation space without the doc competing for it).
  //   • Desktop: open the side drawer and highlight the thread.
  wireThreadRangeClicks({
    editorMount,
    chrome: reviewChrome,
    surface: editor,
    scope,
    revealBalloon: (id) => margin.revealThreadBalloon(id),
  });

  // The sidebar and topbar dropdown for the set this doc belongs to — a diff
  // review, a bound folder, or a legacy hand-grouped set.
  const setNav = mountDocSetNav({ docId, navDocId, ydoc, scope });

  // `?thread=<id>` — arrive AT the comment, not at the document that contains
  // it. The board's review queue links here, and "it drops me on the doc and I
  // scroll looking for it" is the thing that link exists to remove. Read from
  // the address here, like the huddle flag above, and run once on the first
  // sync: threads don't exist before the ydoc arrives, and re-revealing on
  // every later sync would yank the reader back mid-read.
  function revealLinkedThread(): void {
    const wanted = new URLSearchParams(location.search).get('thread');
    if (!wanted) return;
    // Only when it's really there — a stale link leaves the reader on the doc
    // rather than pulsing at nothing, and SAYS so: threads all ride the ydoc
    // that just synced, so absent now is gone (resolved away, or a stale
    // paste), not still loading. A silent nothing reads as a broken link.
    if (!reviewChrome.collectThreads().some((t) => t.id === wanted)) {
      showToast('That comment thread is gone from this doc — the link may be outdated.');
      return;
    }
    reviewChrome.revealThread(wanted);
  }

  // What every meta tick redraws, and what only the first sync may do.
  wireDocReady({
    client,
    ydoc,
    scope,
    chrome: reviewChrome,
    editor,
    workspaceId: ctx.workspaceId,
    renderSetNav: () => setNav.render(),
    onFirstSync: revealLinkedThread,
  });

  // The #save-state chip: "All changes saved" / "Unsaved changes" /
  // "Reconnecting…", and the teardown that blanks it for the next document.
  mountDocSaveState({ client, ydoc, canWrite, scope });

  // Last, because it speaks for the whole surface: the format bar, the
  // view/edit and Suggesting interlock, and the read-only lock that overrides
  // both when the server will not accept writes.
  wireDocGates({
    editor,
    scope,
    els: { toggleEditMode, toggleSuggestMode, formatBar, toggleFormat },
    docId,
    user,
    canWrite,
    justStarted: startedHuddleHere,
  });
}
