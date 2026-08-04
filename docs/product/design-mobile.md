# Mobile Design Guidelines

How any UI in this repo (markdown editor, widget, landing page) should behave below 720px wide. Based on real failure modes Bryan reported on iPhone 16 Pro Max (430px viewport), with the explicit constraint that things must still read well for a 50-60-year-old developer on a smaller phone.

## Breakpoints

| Width | Profile | What changes |
|---|---|---|
| **≥1101px** | Desktop, full layout | Set-list sidebar shown if has-set; threads pane fixed at right |
| **901–1100px** | Small desktop / large tablet | Set-list sidebar hidden, dropdown-only nav; threads pane still fixed |
| **721–900px** | Tablet | Threads pane drawer-ifies (overlay, not fixed column) |
| **≤720px** | Phone | All mobile rules below |

Use `@media (max-width: 720px)` as the canonical phone breakpoint.

## Topbar

- **No full file paths.** Show the basename only, derived from `sourceUrl`. Truncate at 32 chars with a leading ellipsis (`…ng-best-practices.md`) so the meaningful end of the filename survives.
- Full path goes in the `title` attribute (tap-and-hold tooltip).
- Hide labels and badges that are nice-to-have but not load-bearing on mobile: `Editing:` prefix, `All changes saved` indicator. The topbar context is implied by being in the editor.
- Keep the back arrow (`←`) and the doc-switcher tappable (≥36px tap target).

## Prose / editor body

- **Font size 16px**, line-height 1.55. Smaller than desktop's 18px is fine — the screen-to-eye distance compensates. Don't go below 15px; it kills readability for older eyes.
- **Padding 16px 14px** (top/bottom 16, sides 14). 40px desktop padding squeezes a 430px viewport into the middle 350px — visible content less than half the screen.
- **Headings scaled down**:
  - h1 1.4rem (was 2rem)
  - h2 1.2rem (was 1.6rem)
  - h3 1.05rem (was 1.3rem)
- **Wrap long unbreakable tokens.** `overflow-wrap: anywhere` + `word-break: break-word` on the prose container. Inline code like `apk-viewer-plugin/` and long file paths must wrap mid-token, not force horizontal scroll.
- **Tables get their own scroll container.** `display: block; overflow-x: auto;` on tables — they can't word-wrap cells, so let them scroll inside their own row instead of pushing the page.

## CSS Grid gotcha — `1fr` vs `minmax(0, 1fr)`

`grid-template-columns: 1fr` is shorthand for `minmax(auto, 1fr)`. The `auto` minimum is content-driven, which means a long unbreakable token inside the column (a URL, a file path, an inline code span) can force the column wider than viewport — even with `overflow: hidden` on the parent.

Use `minmax(0, 1fr)` for any grid column that holds prose. The `0` minimum lets the column shrink past content's intrinsic width, which combined with `overflow-wrap: anywhere` on the content gives correct mobile behavior.

This is a recurring footgun. Search this repo for `1fr` before adding new grid layouts.

## Navigation patterns

- **Sidebars are desktop-only.** On mobile, a sidebar takes the whole screen above the content (vertical stack in a single-column grid). The dropdown in the topbar replaces it.
- **Auto-open the dropdown on first paint when there's something to discover.** If the doc has a `setId` and the user is on mobile, open the set dropdown by default — don't make them discover the tap target.
- **Dropdown auto-closes on scroll.** Reaching the content is the strongest "done with the nav" signal — don't make the user tap-to-dismiss before reading. Listen on both `#editor` scroll and window scroll, passive.
- **Outside-click and Escape also close.** Standard expectations.

## Tap targets

Minimum 36×36px for any interactive element. The format-bar buttons drop to icon-only at narrow widths (Code / Code block / Link / HR all hide below 560px).

## Verifying mobile changes

1. Resize the browser to 430px wide (matches iPhone 16 Pro Max viewport).
2. Open a markdown doc with a `setId` (so the dropdown logic is exercised) and inline code or long file paths in the content (so wrap behavior is exercised). Currently `a partner project-2433-plan` works.
3. Check: no horizontal overflow at any scroll position, dropdown opens by default, scrolling closes it, headings fit within viewport.
4. Hard reload (Cmd+Shift+R) — the markdown-app bundle and CSS are cached aggressively.

If you can't easily get to a real iPhone, using Chrome DevTools' device toolbar at iPhone 16 Pro Max preset is acceptable for a first pass; ship-then-confirm for the real-device case.

## Why these rules exist

Three iterations of the same mobile-overflow bug shipped before the root cause (CSS Grid `1fr`) was understood. Bryan does meaningful review on his phone — the editor's mobile UX is load-bearing, not nice-to-have.
