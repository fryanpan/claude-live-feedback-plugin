/**
 * The gesture that fixes an attribution: tap the name, pick the right voice.
 *
 * A menu rather than a text field, because the answer is always one of a
 * known, short list — the voices this meeting had — and because the thing
 * that tells two anonymous voices apart is not their labels but what they
 * said. Every row carries the last thing that voice said for exactly that
 * reason: "Speaker A" means nothing, "Speaker A — Move the gate." is the
 * person you remember.
 *
 * It is a POPOVER on a pointer and a BOTTOM SHEET on a narrow screen (the
 * stylesheet decides, at 560px). A menu anchored to a word works when the
 * word is next to the cursor; on a phone it lands under a thumb, half
 * off-screen, over the text you are trying to read.
 *
 * Scope is one mention, always — see `speaker-reassign.ts` for why the
 * larger gestures are deliberately absent.
 */

import type { RosterVoice } from '@feedback/core';
import type { Editor } from '@tiptap/core';
import { type SpeakerTagRange, applyReassign, findSpeakerTagAt } from './speaker-reassign.ts';

export interface SpeakerReassignOpts {
  editor: Editor;
  /**
   * The voices to offer. A function rather than a list because a meeting is
   * still going while its notes are being read: the roster is fetched when
   * the menu opens, so a voice that arrived a minute ago is on it.
   */
  loadVoices: () => Promise<RosterVoice[]>;
  /**
   * Whether this reader may write to this doc. NOT the same question as
   * whether the editor is currently editable: view mode is a one-tap UI
   * preference and the default on a phone, and someone reading their own
   * notes in it can still fix an attribution — which is the whole gesture.
   * What must not open the menu is a reader who has no write access at all.
   * Defaults to allowed, so a caller that never had a permission model is
   * not silently given a broken control.
   */
  canWrite?: () => boolean;
  /** Where the menu is attached. Defaults to the document body, so no
   *  `overflow: hidden` in the editor's own layout can clip it. */
  root?: HTMLElement;
}

export interface SpeakerReassignHandle {
  destroy(): void;
}

export function mountSpeakerReassign(opts: SpeakerReassignOpts): SpeakerReassignHandle {
  const { editor, loadVoices } = opts;
  const canWrite = opts.canWrite ?? (() => true);
  const root = opts.root ?? document.body;
  let open: { menu: HTMLElement; scrim: HTMLElement; anchor: HTMLElement } | null = null;
  // Every open gets a number, so a slow roster arriving after the menu was
  // closed and reopened cannot render itself into the newer menu.
  let opened = 0;

  function close(): void {
    if (!open) return;
    open.anchor.setAttribute('aria-expanded', 'false');
    open.menu.remove();
    open.scrim.remove();
    open = null;
  }

  function onKeyDown(ev: KeyboardEvent): void {
    if (ev.key === 'Escape' && open) {
      close();
      // The tag keeps the focus it had: closing a menu should not move a
      // reader somewhere they did not ask to be.
      editor.view.focus();
    }
  }

  function onClick(ev: MouseEvent): void {
    const target = ev.target as HTMLElement | null;
    const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!anchor) return;
    // An ordinary link is somebody's link and is left entirely alone — not
    // even the roster request, which would be a fetch per footnote click.
    if (!anchor.getAttribute('href')?.startsWith('speaker:')) return;
    // Reassigning is writing, and a transaction dispatched from here does
    // not consult anything on its own — so without this a signed-out reader
    // could retag somebody else's notes by tapping a name. Checked before
    // the roster is requested: a menu that cannot act should not appear, and
    // should not cost a fetch to find that out.
    if (!canWrite()) return;
    ev.preventDefault();
    ev.stopPropagation();
    const pos = editor.view.posAtDOM(anchor, 0);
    const tag = findSpeakerTagAt(editor.state, pos);
    if (!tag) return;
    openMenu(anchor, tag);
  }

  function openMenu(anchor: HTMLElement, tag: SpeakerTagRange): void {
    close();
    const mine = ++opened;
    const scrim = document.createElement('div');
    scrim.className = 'speaker-menu-scrim';
    scrim.addEventListener('click', () => close());
    const menu = document.createElement('div');
    menu.className = 'speaker-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Who said this');
    const heading = document.createElement('div');
    heading.className = 'speaker-menu-head';
    heading.textContent = 'Who said this';
    menu.append(heading);
    const list = document.createElement('div');
    list.className = 'speaker-menu-list';
    list.textContent = 'Loading…';
    menu.append(list);
    root.append(scrim, menu);
    anchor.setAttribute('aria-expanded', 'true');
    open = { menu, scrim, anchor };
    place(menu, anchor);

    loadVoices().then(
      (voices) => {
        if (mine !== opened) return;
        renderVoices(list, voices, tag);
      },
      () => {
        if (mine !== opened) return;
        list.textContent = "Couldn't load the voices for this meeting.";
      },
    );
  }

  function renderVoices(list: HTMLElement, voices: RosterVoice[], tag: SpeakerTagRange): void {
    list.textContent = '';
    // Every voice EXCEPT the one this tag already claims would be the tidier
    // list, but the current voice is what tells a reader the menu is about
    // the mention they tapped and not the one above it. It is shown, marked.
    for (const voice of voices) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'speaker-menu-voice';
      row.setAttribute('role', 'menuitemradio');
      row.setAttribute('aria-checked', voice.label === tag.label ? 'true' : 'false');
      const who = document.createElement('span');
      who.className = 'speaker-menu-who';
      who.textContent = voice.name;
      row.append(who);
      if (voice.lastSaid) {
        const said = document.createElement('span');
        said.className = 'speaker-menu-said';
        said.textContent = voice.lastSaid;
        row.append(said);
      }
      row.addEventListener('click', () => {
        applyReassign(editor, tag, voice);
        close();
      });
      list.append(row);
    }
    if (voices.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'speaker-menu-empty';
      empty.textContent = 'No other voices in this capture.';
      list.append(empty);
    }
    const nobody = document.createElement('button');
    nobody.type = 'button';
    nobody.className = 'speaker-menu-nobody';
    nobody.setAttribute('role', 'menuitem');
    nobody.textContent = 'Nobody — this is not a quote';
    nobody.addEventListener('click', () => {
      applyReassign(editor, tag, null);
      close();
    });
    list.append(nobody);
  }

  /** Under the tag, nudged left if it would run off the right edge. The
   *  bottom sheet ignores all of it — at that width the stylesheet pins the
   *  menu to the bottom of the screen, where the thumb is. */
  function place(menu: HTMLElement, anchor: HTMLElement): void {
    const box = anchor.getBoundingClientRect();
    const width = menu.offsetWidth || 260;
    const left = Math.max(8, Math.min(box.left, window.innerWidth - width - 8));
    menu.style.top = `${box.bottom + window.scrollY + 6}px`;
    menu.style.left = `${left + window.scrollX}px`;
  }

  editor.view.dom.addEventListener('click', onClick);
  document.addEventListener('keydown', onKeyDown);

  return {
    destroy(): void {
      close();
      editor.view.dom.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKeyDown);
    },
  };
}
