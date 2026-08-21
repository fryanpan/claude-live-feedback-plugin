/**
 * Every composer is a markdown editor (approved design, review-flow-mock-v1,
 * design point 4) — and "a markdown editor" means the surface the task
 * description already is: you type `**bold**` and the words go bold, `- ` and
 * a bullet appears. Not a box with a cheat sheet over it and a rendering of
 * itself underneath, which is what shipped first and what Bryan rejected:
 * *"the reply and comment inputs should be markdown editors like the task
 * description"*.
 *
 * The editor is the same Tiptap stack the description uses, minus the Yjs
 * room — a composer's words are private until they are posted, so there is
 * nothing to collaborate on and no document to bind to.
 *
 * THE TEXTAREA STAYS. It is hidden once the editor mounts, but it remains the
 * field the caller wired up: `.value` is the markdown, `.disabled` still
 * disables, `data-keep` still marks a draft to carry across a repaint, and
 * `input` still fires as you type. That is what lets five composers — the
 * doc's new-comment box, a thread reply, the task discussion, the walkthrough
 * answer and the Tell-me-more ask — become editors without any of them
 * changing how they send.
 *
 * Loading is lazy, for the reason the description editor is lazy: the hub
 * bundle is a board, and the whole Tiptap/ProseMirror stack measured 22× the
 * board's entry. Until the chunk lands (or if it never does) the plain
 * textarea is on screen and works.
 */

/** A ProseMirror selection, in document positions. */
export interface ComposerSelection {
  from: number;
  to: number;
}

/** Focus scrolls the caret into view by default — `restoreFields` relies on
 *  it, so a composer being typed in wins the scroll back from a centred
 *  thread. The doc composer opts out: on iOS the scroll-to-focus yanks the
 *  page, which is what `preventScroll` was there for. */
export interface ComposerFocusOpts {
  scroll?: boolean;
}

export interface ComposerEditor {
  getMarkdown: () => string;
  /** Replace the content. Never emits an update — a programmatic seed must
   *  not rewrite `ta.value` through the serializer. */
  setMarkdown: (md: string) => void;
  focus: (sel: ComposerSelection | null, opts?: ComposerFocusOpts) => void;
  selection: () => ComposerSelection;
  isFocused: () => boolean;
  setEditable: (on: boolean) => void;
  destroy: () => void;
}

export interface CreateComposerEditorOpts {
  parent: HTMLElement;
  placeholder: string;
  onUpdate: () => void;
}

/** What the lazily-loaded chunk hands back. Types only — the real module is
 *  `./md-composer-chunk.ts`, and nothing here imports it statically. */
export interface ComposerEditorModule {
  createComposerEditor: (opts: CreateComposerEditorOpts) => ComposerEditor;
}

type Loader = () => ComposerEditorModule | Promise<ComposerEditorModule>;

const defaultLoader: Loader = () => import('./md-composer-chunk.ts');
let loader: Loader = defaultLoader;
let cached: ComposerEditorModule | Promise<ComposerEditorModule> | null = null;

/**
 * Swap the chunk loader. The test seam, and the reason it is a module-level
 * setter rather than a parameter: there are five call sites, none of which
 * knows anything about editors, and threading a dependency through all of
 * them to serve the tests would put the seam in the product.
 *
 * A loader that returns the module itself rather than a promise mounts
 * SYNCHRONOUSLY, which is what lets a test assert on the editor in the same
 * tick it built the form.
 */
export function setComposerEditorLoader(next: Loader | null): void {
  loader = next ?? defaultLoader;
  cached = null;
}

interface Field {
  ta: HTMLTextAreaElement;
  wrap: HTMLElement;
  surface: HTMLElement;
  editor: ComposerEditor | null;
  /** Focus asked for before the editor existed — applied on mount. */
  pendingFocus: { sel: ComposerSelection | null; opts: ComposerFocusOpts } | null;
  /** Has this field ever been in the document? Until it has, being detached
   *  means "not appended yet" rather than "thrown away". */
  seen: boolean;
  refresh: () => void;
}

const FIELDS = new WeakMap<HTMLTextAreaElement, Field>();
const LIVE = new Set<Field>();

/**
 * Destroy the editors whose textarea has left the document.
 *
 * The hub's detail panel repaints by `replaceChildren` on every board change
 * and builds a fresh composer each time, so without this every SSE event
 * would leave another ProseMirror view behind. Run on attach and on refresh —
 * both of which a repaint does — so the set never holds more than the
 * generation being replaced.
 */
function reap(): void {
  for (const f of LIVE) {
    if (!f.seen) {
      if (f.ta.isConnected) f.seen = true;
      continue;
    }
    if (f.ta.isConnected) continue;
    f.editor?.destroy();
    LIVE.delete(f);
  }
}

/**
 * Turn a composer's textarea into a live markdown editor.
 *
 * Returns a refresh function for the one path typing cannot cover: a send
 * that empties the box in code (`ta.value = ''`) fires no event, so the
 * sender calls this right after — same for a restore that puts refused words
 * back, and for `restoreFields` refilling a draft after a repaint.
 *
 * IDEMPOTENT, because not every composer is built fresh for its caller: the
 * doc's new-comment box is shell DOM that outlives each document, while
 * `mountReviewChrome` runs once per navigation. Re-attaching returns a
 * refresh for the field that is already there.
 */
export function attachMarkdownComposer(ta: HTMLTextAreaElement): () => void {
  reap();
  const existing = FIELDS.get(ta);
  if (existing) return existing.refresh;

  const wrap = document.createElement('div');
  wrap.className = 'md-composer';
  // Carry the box's asked-for height onto the editor, so a 3-row answer box
  // is still three rows tall once it is an editor.
  wrap.style.setProperty('--md-rows', String(Math.max(1, ta.rows || 2)));
  const surface = document.createElement('div');
  surface.className = 'md-composer-surface';

  // Take the textarea's place in the form, then adopt it — the wrapper is the
  // flex child now, so the row composers (field and Send side by side) keep
  // their shape.
  ta.replaceWith(wrap);
  wrap.append(ta, surface);

  const field: Field = {
    ta,
    wrap,
    surface,
    editor: null,
    pendingFocus: null,
    seen: ta.isConnected,
    refresh: () => {
      reap();
      field.editor?.setMarkdown(ta.value);
    },
  };
  FIELDS.set(ta, field);
  LIVE.add(field);

  // Enter and Escape belong to the composer that wired them up — Enter sends
  // in a thread reply, Escape closes the doc composer — and those listeners
  // are on the textarea, which no longer receives the keystroke. Re-dispatch
  // so they fire, and honour their answer: a handler that consumed the key
  // stops it reaching the editor, one that ignored it (Shift+Enter, a
  // composer with no Enter contract) lets the editor have it.
  //
  // The proxy does NOT bubble. Ancestor handlers already see the real event
  // on its way up from the editor; a bubbling proxy would deliver it twice.
  surface.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== 'Escape') return;
    const proxy = new KeyboardEvent('keydown', {
      key: ev.key,
      code: ev.code,
      shiftKey: ev.shiftKey,
      ctrlKey: ev.ctrlKey,
      metaKey: ev.metaKey,
      altKey: ev.altKey,
      isComposing: ev.isComposing,
      bubbles: false,
      cancelable: true,
    });
    if (!ta.dispatchEvent(proxy)) {
      ev.preventDefault();
      ev.stopPropagation();
    }
  });

  // `ta.disabled = true` is how every composer says "sending" — mirror it
  // rather than making five call sites learn a new verb for it.
  const disabledWatch = new MutationObserver(() => {
    field.editor?.setEditable(!ta.disabled);
    wrap.classList.toggle('md-composer-disabled', ta.disabled);
  });
  disabledWatch.observe(ta, { attributes: true, attributeFilter: ['disabled'] });

  const mod = cached ?? (cached = loader());
  if (isThenable(mod)) {
    void mod.then((m) => mount(field, m)).catch(() => giveUp(field));
  } else {
    try {
      mount(field, mod);
    } catch {
      giveUp(field);
    }
  }
  return field.refresh;
}

function isThenable(v: unknown): v is Promise<ComposerEditorModule> {
  return typeof (v as { then?: unknown } | null)?.then === 'function';
}

function mount(field: Field, mod: ComposerEditorModule): void {
  const { ta, surface, wrap } = field;
  field.editor = mod.createComposerEditor({
    parent: surface,
    placeholder: ta.placeholder,
    // The textarea is still the value every caller reads, so the serializer's
    // output has to land there on every keystroke — before any Send can be
    // pressed. `input` goes with it: it is what the box was firing before,
    // and something is listening (the "write something first" note clears on
    // the next thing typed).
    onUpdate: () => {
      ta.value = field.editor?.getMarkdown() ?? ta.value;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    },
  });
  field.editor.setMarkdown(ta.value);
  field.editor.setEditable(!ta.disabled);
  // Only now does the textarea go away: until the chunk lands there has been
  // a working box on screen the whole time.
  wrap.classList.add('md-composer-live');
  if (field.pendingFocus) {
    field.editor.focus(field.pendingFocus.sel, field.pendingFocus.opts);
    field.pendingFocus = null;
  }
}

/** The chunk never arrived. Leave the plain textarea — it is already on
 *  screen and it already works; markdown typed into it posts the same. */
function giveUp(field: Field): void {
  field.surface.remove();
  LIVE.delete(field);
  // Forgotten entirely, not merely left un-mounted: this box is a plain
  // textarea again, and every caller that asks — focus, caret, refresh —
  // should be told so rather than handed a composer that will never mount.
  FIELDS.delete(field.ta);
}

/** Re-seed a field from its textarea, for callers that hold the element
 *  rather than the refresh (`restoreFields`). No-op on a plain textarea. */
export function refreshMarkdownComposer(ta: HTMLTextAreaElement): void {
  FIELDS.get(ta)?.refresh();
}

/**
 * What this box currently is. Three states rather than a boolean because the
 * middle one behaves like neither of the others: `pending` is a composer
 * whose chunk is still in flight, so the textarea is what is on screen (read
 * its caret, not the editor's) but a focus asked for now must be REMEMBERED
 * rather than applied to a control about to be hidden.
 */
export function composerState(ta: HTMLTextAreaElement): 'none' | 'pending' | 'live' {
  const field = FIELDS.get(ta);
  if (!field) return 'none';
  return field.editor ? 'live' : 'pending';
}

/** Where the caret is, or null when this box is not a live editor — which is
 *  also the signal to snapshot a plain textarea's own selection instead. */
export function composerSelection(ta: HTMLTextAreaElement): ComposerSelection | null {
  return FIELDS.get(ta)?.editor?.selection() ?? null;
}

/** Whether the reader is typing in this box, asked of whichever surface is
 *  actually on screen. */
export function isComposerFocused(ta: HTMLTextAreaElement): boolean {
  const editor = FIELDS.get(ta)?.editor;
  if (!editor) return ta === ta.ownerDocument.activeElement;
  return editor.isFocused();
}

/**
 * Put the caret in this box. Works before the editor exists — a focus asked
 * for while the chunk is in flight is applied the moment it mounts, which is
 * the case `restoreFields` hits on the first repaint of a page load.
 */
export function focusMarkdownComposer(
  ta: HTMLTextAreaElement,
  sel?: ComposerSelection | null,
  opts: ComposerFocusOpts = {},
): void {
  const field = FIELDS.get(ta);
  if (!field) {
    ta.focus({ preventScroll: opts.scroll === false });
    return;
  }
  if (field.editor) {
    field.editor.focus(sel ?? null, opts);
    return;
  }
  field.pendingFocus = { sel: sel ?? null, opts };
}
