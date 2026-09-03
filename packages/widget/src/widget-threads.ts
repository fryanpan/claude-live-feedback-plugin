import {
  type ElementAnchor,
  STATUS_COLORS,
  type Thread,
  anchors,
  cssColor,
  escapeHtml as escape,
  formatTime,
  listThreads,
} from '@feedback/core';
import { IGNORE_ATTR } from './widget-picker.ts';
import type { FeedbackWidgetEl } from './widget.ts';

const { contextMatches } = anchors;

/**
 * Threads, pins and the popover — everything that renders a comment back onto
 * the page and into the panel.
 *
 * Third and last of B7's extractions. `renderThreads` is the one entry point
 * the element's render loop calls; `positionPins` is the cheap
 * position-only path the scroll, resize and rAF handlers call. The rest is
 * reached from inside this file.
 *
 * `threadSnippet` and `capitalize` come along because nothing outside these
 * six functions ever read them.
 */

/**
 * The line a thread row shows above its latest comment.
 *
 * A subject anchor points at the PAGE rather than into it — `create_thread`
 * with no `find` makes one on any doc — so it names that instead of quoting
 * something. Without this the row would read a snippet that isn't there.
 */
function threadSnippet(anchor: Thread['anchor']): string {
  if (anchor.kind === 'orphan') return anchor.original.snippet.text;
  if (anchor.kind === 'subject') return 'About this page';
  return (anchor as ElementAnchor).snippet.text;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function renderThreadsInto(el: FeedbackWidgetEl): void {
  if (!el.client) return;
  const threads = listThreads(el.client.ydoc);
  // pin layer
  el.threadPositions.clear();
  const pinLayer = el.pinLayer;
  if (!pinLayer) return; // disconnectedCallback fired between schedule and render
  pinLayer.innerHTML = '';
  const annotated: {
    thread: Thread;
    status: 'open' | 'resolved' | 'orphan';
    el: HTMLElement | null;
  }[] = [];
  for (const t of threads) {
    // A subject thread has nothing on the page to pin, but the panel is the
    // one place it can ever appear — dropping it here is how a comment ends
    // up in the store with no surface able to show it.
    if (t.anchor.kind === 'subject') {
      annotated.push({
        thread: t,
        status: t.status === 'resolved' ? 'resolved' : 'open',
        el: null,
      });
      continue;
    }
    if (t.anchor.kind !== 'element' && t.anchor.kind !== 'orphan') continue;
    const statusBase: 'open' | 'resolved' | 'orphan' =
      t.status === 'resolved' ? 'resolved' : 'open';
    if (t.anchor.kind === 'orphan') {
      annotated.push({ thread: t, status: 'orphan', el: null });
      continue;
    }
    // Pin only when the anchor's captured context matches the current
    // page / view. Legacy anchors with no context show everywhere
    // (back-compat). Off-context threads still flow into the side
    // panel via listThreads — they're just not overlaid on the doc.
    if (!contextMatches(t.anchor.context, el.currentContext)) {
      annotated.push({ thread: t, status: statusBase, el: null });
      continue;
    }
    const res = anchors.Element.resolve(t.anchor, { root: document });
    if (!res.ok) {
      annotated.push({ thread: t, status: 'orphan', el: null });
      continue;
    }
    annotated.push({ thread: t, status: statusBase, el: res.element });
    // Hide pins for resolved threads by default — they pile up visual
    // noise on the page during iteration. The thread still flows into
    // the panel list (where it's collapsed under a "Show resolved (N)"
    // toggle), so reopening is one click away.
    if (statusBase === 'resolved' && !el.showResolved) continue;
    const pin = document.createElement('div');
    pin.setAttribute(IGNORE_ATTR, '');
    pin.className = 'cfw-pin';
    pin.dataset.threadId = t.id;
    pin.dataset.status = statusBase;
    pin.style.cssText = [
      'position:absolute',
      'pointer-events:auto',
      'width:24px',
      'height:24px',
      'border-radius:50%',
      `background:${statusBase === 'resolved' ? STATUS_COLORS.resolved : STATUS_COLORS.open}`,
      'color:#fff',
      'font:600 12px system-ui',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'cursor:pointer',
      'box-shadow:0 2px 6px rgba(0,0,0,0.25)',
      'transform:translate(-50%,-100%)',
    ].join(';');
    const idx = annotated.filter((a) => a.status !== 'orphan').length;
    pin.textContent = String(idx);
    pin.title = t.comments[0]?.text ?? 'open thread';
    pin.addEventListener('click', (ev) => {
      showThreadPopover(el, t, ev.clientX, ev.clientY);
    });
    pinLayer.appendChild(pin);
    el.threadPositions.set(t.id, { el: res.element, status: statusBase });
  }
  positionPins(el);
  const badge = el.shadow.querySelector('.fab-list .count') as HTMLElement | null;
  if (badge) {
    const open = annotated.filter((a) => a.status === 'open').length;
    badge.textContent = String(open);
    badge.hidden = open === 0;
  }
  renderPanelList(el, annotated);
}

export function positionPins(el: FeedbackWidgetEl): void {
  if (!el.pinLayer) return;
  for (const pin of Array.from(el.pinLayer.children)) {
    const id = (pin as HTMLElement).dataset.threadId;
    if (!id) continue;
    const pos = el.threadPositions.get(id);
    if (!pos) continue;
    const rect = pos.el.getBoundingClientRect();
    (pin as HTMLElement).style.left = `${rect.right - 6}px`;
    (pin as HTMLElement).style.top = `${rect.top + 6}px`;
  }
}

function renderPanelList(
  el: FeedbackWidgetEl,
  entries: { thread: Thread; status: 'open' | 'resolved' | 'orphan' }[],
): void {
  const list = el.shadow.querySelector('.panel-threads') as HTMLElement | null;
  if (!list) return;
  list.innerHTML = '';
  const groups: Record<'open' | 'orphan' | 'resolved', typeof entries> = {
    open: entries.filter((e) => e.status === 'open'),
    orphan: entries.filter((e) => e.status === 'orphan'),
    resolved: entries.filter((e) => e.status === 'resolved'),
  };
  if (entries.length === 0) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = 'No comments yet. Tap the bubble, then click anything on the page.';
    list.appendChild(e);
    return;
  }
  for (const key of ['open', 'orphan'] as const) {
    const group = groups[key];
    if (!group.length) continue;
    const h = document.createElement('div');
    h.className = 'section-heading';
    h.textContent = `${capitalize(key)} (${group.length})`;
    list.appendChild(h);
    for (const { thread, status } of group) {
      list.appendChild(renderThreadRow(el, thread, status));
    }
  }
  if (groups.resolved.length) {
    const toggle = document.createElement('button');
    toggle.className = 'resolved-toggle';
    toggle.textContent = el.showResolved
      ? `Hide resolved (${groups.resolved.length})`
      : `Show resolved (${groups.resolved.length})`;
    toggle.addEventListener('click', () => {
      el.showResolved = !el.showResolved;
      localStorage.setItem('cfw:showResolved', el.showResolved ? '1' : '0');
      // Rerender to flip pins on/off and the resolved group visibility
      el.scheduleRender();
    });
    list.appendChild(toggle);
    if (el.showResolved) {
      for (const { thread, status } of groups.resolved) {
        list.appendChild(renderThreadRow(el, thread, status));
      }
    }
  }
}

function renderThreadRow(
  el: FeedbackWidgetEl,
  t: Thread,
  status: 'open' | 'resolved' | 'orphan',
): HTMLElement {
  const row = document.createElement('div');
  row.className = `thread status-${status}`;
  if (el.activeThread === t.id) row.classList.add('active');

  const snippet = threadSnippet(t.anchor);
  const last = t.comments[t.comments.length - 1];
  row.innerHTML = `
    <div class="meta">
      <span class="dot"></span>
      <span class="author-name">${escape(t.createdBy.name)}</span>
      <span class="time">${formatTime(last?.ts ?? 0)}</span>
    </div>
    <div class="snippet">${escape(snippet)}</div>
    <div class="last">${escape(last?.text ?? '')}</div>
  `;
  row.addEventListener('click', () => {
    const pos = el.threadPositions.get(t.id);
    if (pos?.el) pos.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.activeThread = t.id;
    showThreadPopoverForThread(el, t);
  });
  return row;
}

function showThreadPopoverForThread(el: FeedbackWidgetEl, t: Thread): void {
  if (t.anchor.kind === 'element') {
    const res = anchors.Element.resolve(t.anchor, { root: document });
    if (res.ok) {
      const r = res.element.getBoundingClientRect();
      showThreadPopover(el, t, r.right, r.top);
      return;
    }
  }
  showThreadPopover(el, t, window.innerWidth / 2, 80);
}

export function showThreadPopover(el: FeedbackWidgetEl, t: Thread, cx: number, cy: number): void {
  const existing = el.shadow.querySelector('.thread-popover');
  existing?.remove();
  const pop = document.createElement('div');
  pop.className = 'thread-popover';
  pop.style.left = `${Math.min(cx + 6, window.innerWidth - 340)}px`;
  pop.style.top = `${Math.min(cy + 6, window.innerHeight - 240)}px`;
  const snippet = threadSnippet(t.anchor);
  const status = t.anchor.kind === 'orphan' ? 'orphan' : t.status;
  pop.innerHTML = `
    <header>
      <span class="tag tag-${status}">${status}</span>
      <button class="icon-btn close">×</button>
    </header>
    <div class="snippet">${escape(snippet)}</div>
    <div class="comments"></div>
    <div class="actions">
      <textarea rows="2" placeholder="Reply as ${escape(el.user?.name ?? 'Anon')}…"></textarea>
      <button class="primary submit">Reply</button>
      ${
        status === 'resolved'
          ? `<button class="reopen">Reopen</button>`
          : status === 'open'
            ? `<button class="resolve">Resolve</button>`
            : ''
      }
    </div>
  `;
  const cList = pop.querySelector('.comments') as HTMLElement;
  for (const c of t.comments) {
    const row = document.createElement('div');
    row.className = 'comment';
    row.innerHTML = `
      <div class="author"><span class="swatch" style="background:${cssColor(c.author.color)}"></span>${escape(c.author.name)} <span class="time">${formatTime(c.ts)}</span></div>
      <div class="body">${escape(c.text)}</div>
    `;
    cList.appendChild(row);
  }
  el.shadow.appendChild(pop);
  pop.querySelector('.close')?.addEventListener('click', () => pop.remove());
  pop.querySelector('.submit')?.addEventListener('click', async () => {
    const ta = pop.querySelector('textarea') as HTMLTextAreaElement;
    const text = ta.value.trim();
    if (!text) return;
    if (!(await el.postReply(t.id, text))) return;
    pop.remove();
  });
  pop.querySelector('.resolve')?.addEventListener('click', async () => {
    await el.setStatus(t.id, 'resolved');
    pop.remove();
  });
  pop.querySelector('.reopen')?.addEventListener('click', async () => {
    await el.setStatus(t.id, 'open');
    pop.remove();
  });
}
