/**
 * The editing chrome that sits above the document: the format bar, its table
 * popover, and the reading-width toggle the bar's own button drives.
 *
 * These came out of `app.ts` because none of them know what a document is.
 * They take an `EditorHandle` and a `MountScope` and wire DOM that already
 * exists in the shell, so the only things `app.ts` needs back are the two
 * entry points it called before the move.
 */
import type { EditorHandle } from '../editor.ts';
import type { MountScope } from '../mount-scope.ts';
import { type TableMenuItem, tableMenuItems } from '../table-menu.ts';

const WIDTH_PREF_KEY = 'lfb.editor.width';

// In-memory mirror so the toggle still works in private mode (where
// localStorage throws on get and set) — without it, every read would
// fall back to the default and the button wouldn't appear to do anything.
let widthPrefInMemory: 'full' | 'reading' | undefined;

/** Read the persisted width preference. Default is 'full' so wide tables
 *  in attachments aren't squeezed. */
function readWidthPref(): 'full' | 'reading' {
  try {
    const raw = localStorage.getItem(WIDTH_PREF_KEY);
    return raw === 'reading' ? 'reading' : 'full';
  } catch {
    return widthPrefInMemory ?? 'full';
  }
}

export function applyWidthPref(): void {
  const pref = readWidthPref();
  document.body.classList.toggle('is-reading-width', pref === 'reading');
  const btn = document.querySelector<HTMLButtonElement>('#format-bar [data-cmd="width"]');
  if (btn) btn.setAttribute('aria-pressed', String(pref === 'reading'));
}

function toggleWidthPref(): void {
  const next = readWidthPref() === 'reading' ? 'full' : 'reading';
  widthPrefInMemory = next;
  try {
    localStorage.setItem(WIDTH_PREF_KEY, next);
  } catch {
    // localStorage disabled (private mode) — in-memory mirror keeps the toggle alive.
  }
  applyWidthPref();
}

/**
 * Contextual popover for table operations. Insert/edit are powered by
 * @tiptap/extension-table; this renders the item list from tableMenuItems()
 * and dispatches to the matching Tiptap command. Rendered into <body> as a
 * fixed-position element so it escapes the format bar's `overflow:hidden`.
 * Scoped: the appended element + its document listeners are removed on nav.
 */
interface TableMenuController {
  toggle: (anchor: HTMLElement) => void;
  close: () => void;
}

function wireTableMenu(editor: EditorHandle, scope: MountScope): TableMenuController {
  const menu = document.createElement('div');
  menu.className = 'table-menu hidden';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-hidden', 'true');
  document.body.appendChild(menu);
  scope.onCleanup(() => menu.remove());

  let anchorBtn: HTMLElement | null = null;

  const close = () => {
    if (menu.classList.contains('hidden')) return;
    menu.classList.add('hidden');
    menu.setAttribute('aria-hidden', 'true');
    anchorBtn?.setAttribute('aria-expanded', 'false');
    anchorBtn = null;
  };

  const runTableCmd = (cmd: TableMenuItem['cmd']) => {
    const c = editor.editor.chain().focus();
    switch (cmd) {
      case 'insertTable':
        c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
        break;
      case 'addRowBefore':
        c.addRowBefore().run();
        break;
      case 'addRowAfter':
        c.addRowAfter().run();
        break;
      case 'addColumnBefore':
        c.addColumnBefore().run();
        break;
      case 'addColumnAfter':
        c.addColumnAfter().run();
        break;
      case 'deleteRow':
        c.deleteRow().run();
        break;
      case 'deleteColumn':
        c.deleteColumn().run();
        break;
      case 'deleteTable':
        c.deleteTable().run();
        break;
    }
  };

  const open = (anchor: HTMLElement) => {
    anchorBtn = anchor;
    menu.innerHTML = '';
    for (const item of tableMenuItems(editor.editor.isActive('table'))) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `table-menu-item${item.danger ? ' danger' : ''}`;
      b.setAttribute('role', 'menuitem');
      b.textContent = item.label;
      b.addEventListener('click', () => {
        runTableCmd(item.cmd);
        close();
      });
      menu.appendChild(b);
    }
    menu.classList.remove('hidden');
    menu.setAttribute('aria-hidden', 'false');
    anchor.setAttribute('aria-expanded', 'true');
    // Position under the anchor, clamped to the viewport (mobile-safe).
    const r = anchor.getBoundingClientRect();
    menu.style.top = `${r.bottom + 4}px`;
    const mw = menu.offsetWidth;
    let left = Math.min(r.left, window.innerWidth - 8 - mw);
    if (left < 8) left = 8;
    menu.style.left = `${left}px`;
  };

  // Keep the editor selection alive while pressing menu items.
  scope.listen(menu, 'mousedown', (ev) => (ev as MouseEvent).preventDefault());
  scope.listen(document, 'click', (ev) => {
    if (menu.classList.contains('hidden')) return;
    const t = ev.target as Node;
    if (menu.contains(t) || anchorBtn?.contains(t)) return;
    close();
  });
  scope.listen(document, 'keydown', (ev) => {
    if ((ev as KeyboardEvent).key === 'Escape') close();
  });
  document.getElementById('editor')?.addEventListener('scroll', close, {
    passive: true,
    signal: scope.signal,
  });

  return {
    toggle: (anchor) => {
      if (!menu.classList.contains('hidden') && anchorBtn === anchor) close();
      else open(anchor);
    },
    close,
  };
}

export function wireFormatBar(editor: EditorHandle, scope: MountScope): void {
  const bar = document.getElementById('format-bar');
  if (!bar) return;
  const chain = () => editor.editor.chain().focus();
  const tableMenu = wireTableMenu(editor, scope);
  const handlers: Record<string, () => void> = {
    bold: () => chain().toggleBold().run(),
    italic: () => chain().toggleItalic().run(),
    h1: () => chain().toggleHeading({ level: 1 }).run(),
    h2: () => chain().toggleHeading({ level: 2 }).run(),
    h3: () => chain().toggleHeading({ level: 3 }).run(),
    bulletList: () => chain().toggleBulletList().run(),
    orderedList: () => chain().toggleOrderedList().run(),
    blockquote: () => chain().toggleBlockquote().run(),
    code: () => chain().toggleCode().run(),
    codeBlock: () => chain().toggleCodeBlock().run(),
    hr: () => chain().setHorizontalRule().run(),
    width: toggleWidthPref,
    table: () => {
      const btn = bar.querySelector<HTMLElement>('[data-cmd="table"]');
      if (btn) tableMenu.toggle(btn);
    },
    link: () => {
      const existing = editor.editor.getAttributes('link').href as string | undefined;
      const href = prompt('Link URL', existing ?? 'https://');
      if (href === null) return;
      if (href === '') chain().unsetLink().run();
      else chain().setLink({ href }).run();
    },
  };
  scope.listen(bar, 'mousedown', (ev) => {
    const t = ((ev as MouseEvent).target as HTMLElement).closest('button');
    if (t) (ev as MouseEvent).preventDefault();
  });
  scope.listen(bar, 'click', (ev) => {
    const t = ((ev as MouseEvent).target as HTMLElement).closest('button');
    if (!t) return;
    const cmd = t.getAttribute('data-cmd');
    if (cmd && handlers[cmd]) handlers[cmd]();
  });

  const refresh = () => {
    for (const btn of Array.from(bar.querySelectorAll<HTMLButtonElement>('button'))) {
      const cmd = btn.getAttribute('data-cmd');
      let active = false;
      switch (cmd) {
        case 'bold':
          active = editor.editor.isActive('bold');
          break;
        case 'italic':
          active = editor.editor.isActive('italic');
          break;
        case 'h1':
          active = editor.editor.isActive('heading', { level: 1 });
          break;
        case 'h2':
          active = editor.editor.isActive('heading', { level: 2 });
          break;
        case 'h3':
          active = editor.editor.isActive('heading', { level: 3 });
          break;
        case 'bulletList':
          active = editor.editor.isActive('bulletList');
          break;
        case 'orderedList':
          active = editor.editor.isActive('orderedList');
          break;
        case 'blockquote':
          active = editor.editor.isActive('blockquote');
          break;
        case 'code':
          active = editor.editor.isActive('code');
          break;
        case 'codeBlock':
          active = editor.editor.isActive('codeBlock');
          break;
        case 'link':
          active = editor.editor.isActive('link');
          break;
        case 'table':
          active = editor.editor.isActive('table');
          break;
      }
      btn.classList.toggle('active', active);
    }
  };
  editor.editor.on('selectionUpdate', refresh);
  editor.editor.on('transaction', refresh);
}
