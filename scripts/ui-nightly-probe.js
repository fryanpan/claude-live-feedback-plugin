/**
 * The expression `scripts/ui-nightly.ts` hands to `ui:shot --eval-file`.
 *
 * It runs INSIDE the page, in a real layout engine, and it only MEASURES —
 * every verdict is reached back in `ui-nightly-lib.ts`, where it can be unit
 * tested against a recorded payload. Nothing here throws on a bad reading: a
 * measurement that could not be taken comes back as null or an empty list, and
 * the assertions treat that as a failure rather than as a pass, so a probe that
 * stops seeing its subject goes red instead of quiet.
 *
 * Plain JS, not TypeScript, because it is read as text and evaluated by
 * Chrome — there is no build step between this file and the page.
 */
(() => {
  const round = (n) => Math.round(n * 100) / 100;

  /** Hover treatments this repo requires to sit inside `@media (hover: hover)`.
   *  Kept in sync with packages/workspaces-app/test/decide-option-hover-css.test.ts,
   *  which asserts the same thing by reading the stylesheet as text. */
  const HOVER_SELECTORS = ['.board-decide-option:hover', '.thread-item-option:hover'];

  /**
   * Every CSS rule in the page's own stylesheets, paired with the media
   * queries it sits inside and whether each of those currently MATCHES. That
   * last part is the whole reason this runs in a browser: `(hover: hover)` has
   * no answer outside a device.
   */
  function walkRules(rules, media, out) {
    for (const rule of rules) {
      if (rule.media && rule.cssRules) {
        // `CSSMediaRule` has no `matches` of its own — a `MediaList` only
        // carries text. Asking `matchMedia` is what evaluates the condition
        // against THIS device, and it is the whole point of running here.
        const text = rule.conditionText;
        walkRules(
          rule.cssRules,
          media.concat([{ text, matches: window.matchMedia(text).matches }]),
          out,
        );
        continue;
      }
      if (rule.cssRules && !rule.selectorText) {
        walkRules(rule.cssRules, media, out);
        continue;
      }
      if (rule.selectorText) out.push({ selector: rule.selectorText, media });
    }
  }

  function hoverRules() {
    const all = [];
    for (const sheet of document.styleSheets) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        // A cross-origin sheet is unreadable. Record it so the assertion can
        // tell "no such rule" from "could not look".
        all.push({ selector: null, media: [], unreadable: sheet.href || 'inline' });
        continue;
      }
      if (rules) walkRules(rules, [], all);
    }
    return HOVER_SELECTORS.map((selector) => {
      const hits = all.filter((r) => r.selector?.includes(selector));
      return {
        selector,
        found: hits.length,
        // Each occurrence: is it inside a hover-media block, and does that
        // block match on THIS device?
        sites: hits.map((r) => {
          const hover = r.media.filter((m) => String(m.text).includes('hover'));
          return {
            guarded: hover.length > 0,
            matchesHere: hover.length > 0 ? hover.every((m) => m.matches) : null,
          };
        }),
        unreadableSheets: all.filter((r) => r.unreadable).length,
      };
    });
  }

  /** Bottom-bar tabs, and whether a tap on each one's centre reaches it. */
  function navItems() {
    const out = [];
    for (const el of document.querySelectorAll('.board-nav-item')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue; // collapsed at this width
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      out.push({
        label: (el.textContent || '').trim(),
        right: round(r.right),
        hitsSelf: !!(hit && (hit === el || el.contains(hit))),
        hitTag: hit ? hit.tagName.toLowerCase() : null,
      });
    }
    return out;
  }

  /** `#shell`'s grid, as the layout engine resolved it. */
  function shell() {
    const el = document.getElementById('shell');
    if (!el) return null;
    const inFlow = [];
    for (const child of el.children) {
      const cs = getComputedStyle(child);
      if (cs.display === 'none') continue;
      if (cs.position === 'fixed' || cs.position === 'absolute') continue;
      const r = child.getBoundingClientRect();
      inFlow.push({
        id: child.id || `.${String(child.className).split(' ')[0]}`,
        gridRow: cs.gridRowStart,
        top: round(r.top),
        bottom: round(r.bottom),
      });
    }
    const main = document.getElementById('main');
    const mr = main ? main.getBoundingClientRect() : null;
    return {
      bottom: round(el.getBoundingClientRect().bottom),
      tracks: getComputedStyle(el).gridTemplateRows,
      mainTop: mr ? round(mr.top) : null,
      mainBottom: mr ? round(mr.bottom) : null,
      inFlow,
    };
  }

  return {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    // BODY, not documentElement. `body { overflow: hidden }` (styles.css) means
    // the document element never learns about content wider than the window —
    // `document.documentElement.scrollWidth` is pinned to the viewport on every
    // page of this app, so a check written against it cannot fail and was
    // caught doing exactly that. The body's own scrollWidth still reports the
    // extent of what it is clipping, which is the thing that harms the reader:
    // content that is there and unreachable.
    scrollWidth: document.body.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    hoverSupported: window.matchMedia('(hover: hover)').matches,
    navItems: navItems(),
    hoverRules: hoverRules(),
    shell: shell(),
  };
})();
