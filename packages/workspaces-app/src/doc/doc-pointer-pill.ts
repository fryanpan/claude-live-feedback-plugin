/**
 * The pointer pill over a huddle document: Comment, grown just to the right
 * of the point where the finger or mouse let go.
 *
 * It offered three actions until 2026-09-04 (Comment / Research / Create
 * Task). Bryan cut it to the one: what the other two did is asked for in the
 * comment itself, so the pill no longer makes a reader choose a verb before
 * they have said anything. Pressing it opens the composer on the selection
 * and puts the caret in the box in the SAME tick — see `openComposer` in
 * `doc/review-composer.ts`, whose focus used to be 30ms out. iOS raises the
 * keyboard only for a focus that happens inside the gesture that asked for
 * it, so on the iPad this pill is mostly used from, a deferred focus meant a
 * second tap.
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
import { POINTER_PILL_ACTIONS, type PointerPillActionId } from '../spinoff-menu.ts';
import type { ChromeSelection } from './anchor-body.ts';

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
  /**
   * Open the comment composer on the standing selection AND put the caret in
   * it, synchronously. Called straight out of the button's click handler with
   * nothing awaited in between, because that is the only thing iOS accepts as
   * grounds for raising the keyboard.
   */
  openComposer: () => void;
}

export function mountPointerPillLayer(opts: PointerPillLayerOptions): PointerPillLayer {
  const { huddle, editor, editorMount, scope, getSelection, hideAll, openComposer } = opts;

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

  const pointerPill = huddle
    ? mountPointerPill<PointerPillActionId>({
        actions: POINTER_PILL_ACTIONS,
        // Not the component's default ("Turn this line into work") — that
        // named a toolbar of spin-offs, and this one comments.
        ariaLabel: 'Comment on the selected text',
        onPick: () => {
          hideAll();
          // The composer anchors to the selection that is standing, so it
          // stays: the same path the round pill takes everywhere else. And
          // `openComposer` focuses the box before this handler returns —
          // nothing may be awaited or deferred between the click and the
          // focus, or iOS declines to raise the keyboard.
          openComposer();
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
    // No selection, no pill: the composer would have nothing to anchor to,
    // and would only toast "select some text first" at a person who did.
    if (!getSelection()) {
      pointerPill.hide();
      return;
    }
    pointerPill.show(anchor, rects, bounds);
  }

  return {
    show,
    hide: () => pointerPill?.hide(),
  };
}
