/**
 * The pointer pill over a huddle document: Comment / Research / Create Task,
 * grown just to the right of the point where the finger or mouse let go.
 *
 * The release point is the whole reason this is a module rather than a call.
 * A pill anchored to the selection's box lands in the wrong place on a
 * multi-line selection, and a pill anchored to a fixed viewport point walks
 * away the moment the doc scrolls — so what is kept is the OFFSET from the
 * box to the release, re-derived only when the selection or the release
 * changes. Recording that release means listening on the window through the
 * whole mount, which is state with a lifetime, and lifetimes are what
 * modules are for.
 *
 * The layer is mounted on every markdown doc, not only a huddle: the release
 * listeners cost nothing and ran unconditionally before, and `show()` is a
 * no-op wherever there is no pill.
 */
import type { EditorHandle } from '../editor.ts';
import type { MountScope } from '../mount-scope.ts';
import { mountPointerPill } from '../pointer-pill.ts';
import type { ChromeSelection } from '../review-chrome.ts';
import {
  POINTER_PILL_ACTIONS,
  type PointerPillActionId,
  type SpinoffTaskId,
} from '../spinoff-menu.ts';

export interface PointerPillLayer {
  /** Grow the pill over the selection `from`..`to`. No-op off a huddle doc. */
  show: (from: number, to: number) => void;
  hide: () => void;
}

export interface PointerPillLayerOptions {
  /** True on a huddle doc — the only place the pill exists. */
  huddle: boolean;
  editor: EditorHandle;
  /** The `#editor` element, whose visible box clamps the pill. */
  editorMount: HTMLElement;
  scope: MountScope;
  /** The selection the pill acts on: the editor's own, or the cached one the
   *  comment-pill controller kept when iOS blurred the editor. */
  getSelection: () => ChromeSelection | null;
  /** Hide BOTH pills — picking an action ends the round pill too. */
  hideAll: () => void;
  openComposer: () => void;
  takeSpinoff: (
    action: SpinoffTaskId,
    sel: ChromeSelection,
    range: { from: number; to: number } | null,
  ) => void;
}

export function mountPointerPillLayer(opts: PointerPillLayerOptions): PointerPillLayer {
  const { huddle, editor, editorMount, scope, getSelection, hideAll, openComposer, takeSpinoff } =
    opts;

  /** Where the last selection gesture let go, in viewport coordinates. A
   *  release ON the pill is not recorded: it would walk the anchor up by one
   *  gap every tap. Touch is remembered too, because a fingertip needs 44px
   *  of clearance where a mouse cursor needs 12. */
  let lastRelease: { x: number; y: number; touch: boolean; at: number } | null = null;
  function recordRelease(x: number, y: number, touch: boolean, target: EventTarget | null): void {
    if (pointerPill && target instanceof Node && pointerPill.el.contains(target)) return;
    lastRelease = { x, y, touch, at: Date.now() };
  }
  scope.listen(
    window,
    'pointerup',
    (ev) => {
      const e = ev as PointerEvent;
      recordRelease(e.clientX, e.clientY, e.pointerType !== 'mouse', e.target);
    },
    { capture: true, passive: true },
  );
  // iOS hands a long-press to its own selection UI and delivers a
  // `pointercancel`, never a `pointerup`, so the release point has to come
  // from the touch event underneath.
  scope.listen(
    window,
    'touchend',
    (ev) => {
      const t = (ev as TouchEvent).changedTouches[0];
      if (t) recordRelease(t.clientX, t.clientY, true, ev.target);
    },
    { capture: true, passive: true },
  );

  /** The selection the pill was shown for, captured when it appeared: on iOS
   *  the tap on a button blurs the editor before the click lands, and by
   *  then there is nothing left to write the task's link beside. */
  let pointerPillCtx: {
    sel: ChromeSelection;
    range: { from: number; to: number } | null;
  } | null = null;
  const pointerPill = huddle
    ? mountPointerPill<PointerPillActionId>({
        actions: POINTER_PILL_ACTIONS,
        onPick: (action) => {
          const captured = pointerPillCtx;
          pointerPillCtx = null;
          hideAll();
          if (action === 'comment') {
            // The composer anchors to the selection that is standing, so
            // it stays: the same path the round pill takes everywhere else.
            openComposer();
            return;
          }
          // The selection has done its job. Left standing, the next
          // `positionPill` — the release of this very tap, or the edit
          // that writes the link — would grow the pill straight back over
          // words that have already become a row.
          window.getSelection()?.removeAllRanges();
          editor.editor.commands.blur();
          if (captured) takeSpinoff(action, captured.sel, captured.range);
        },
        onDismiss: () => hideAll(),
      })
    : null;
  scope.onCleanup(() => pointerPill?.destroy());

  /** The anchor as an OFFSET from the selection's box rather than a fixed
   *  viewport point, so a scroll carries the pill along with the words it is
   *  about instead of leaving it where the finger was. Re-derived whenever
   *  the selection or the release changes, held steady otherwise. */
  let pillAnchorKey = '';
  let pillAnchorOffset = { dx: 0, dy: 0, touch: false };

  function show(from: number, to: number): void {
    if (!pointerPill) return;
    const winSel = window.getSelection();
    const rects: { left: number; top: number; right: number; bottom: number }[] = [];
    if (winSel && winSel.rangeCount > 0 && !winSel.isCollapsed) {
      for (const r of Array.from(winSel.getRangeAt(0).getClientRects())) {
        if (r.width > 0 && r.height > 0) {
          rects.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
        }
      }
    }
    if (rects.length === 0) {
      const c = editor.editor.view.coordsAtPos(to);
      rects.push({ left: c.left, top: c.top, right: c.right + 1, bottom: c.bottom });
    }
    const box = {
      left: Math.min(...rects.map((r) => r.left)),
      top: Math.min(...rects.map((r) => r.top)),
      right: Math.max(...rects.map((r) => r.right)),
      bottom: Math.max(...rects.map((r) => r.bottom)),
    };
    const key = `${from}:${to}:${lastRelease?.at ?? 0}`;
    if (key !== pillAnchorKey) {
      pillAnchorKey = key;
      // A release counts only when it is NEAR the selection. A keyboard
      // selection (shift+arrow) has no release of its own, and the last one
      // may be a click seconds ago somewhere else on the page; anchoring on
      // that would put the pill over nothing.
      const slack = 80;
      const near =
        lastRelease !== null &&
        Date.now() - lastRelease.at < 10_000 &&
        lastRelease.x >= box.left - slack &&
        lastRelease.x <= box.right + slack &&
        lastRelease.y >= box.top - slack &&
        lastRelease.y <= box.bottom + slack;
      if (near && lastRelease) {
        pillAnchorOffset = {
          dx: lastRelease.x - box.left,
          dy: lastRelease.y - box.top,
          touch: lastRelease.touch,
        };
      } else {
        // No usable release: the end of the selection's last line stands in.
        const last = rects[rects.length - 1] ?? box;
        pillAnchorOffset = {
          dx: last.right - box.left,
          dy: last.bottom - box.top,
          touch: window.matchMedia?.('(pointer: coarse)').matches ?? false,
        };
      }
    }
    const anchor = {
      x: box.left + pillAnchorOffset.dx,
      y: box.top + pillAnchorOffset.dy,
      touch: pillAnchorOffset.touch,
    };
    // The editor's visible box, cut down by the on-screen keyboard the same
    // way the comment pill's clamp is (see `positionPill`).
    const er = editorMount.getBoundingClientRect();
    const vv = window.visualViewport;
    const vvTop = vv?.offsetTop ?? 0;
    const vvHeight = vv?.height ?? window.innerHeight;
    const bounds = {
      left: Math.max(er.left, 0) + 6,
      right: Math.min(er.right, window.innerWidth) - 6,
      top: Math.max(er.top, vvTop) + 6,
      bottom: Math.min(er.bottom, vvTop + vvHeight) - 6,
    };
    const sel = getSelection();
    if (!sel) {
      pointerPill.hide();
      return;
    }
    pointerPillCtx = { sel, range: from < to ? { from, to } : null };
    pointerPill.show(anchor, rects, bounds);
  }

  return {
    show,
    hide: () => pointerPill?.hide(),
  };
}
