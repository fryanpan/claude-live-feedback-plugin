# Mobile Design Guidelines

How any UI in this repo (markdown editor, widget, landing page) should behave on the two screens Bryan actually reviews on. Based on real failure modes he reported on iPhone 16 Pro Max (430px viewport), with the explicit constraint that things must still read well for a 50-60-year-old developer on a smaller phone.

**Read the next section before assuming this doc is only about phones.** Most of the rules below are phone rules (≤720px), but the device Bryan uses *most* is an iPad in landscape, which no phone rule reaches and which is constrained on a different axis.

## Breakpoints

Three tiers (Bryan, 2026-08-19: *"have a mobile breakpoint, a tablet/laptop
breakpoint for anything up to 1920 and then 4k monitor"*):

| Width | Tier | What changes |
|---|---|---|
| **≥1921px** | **Large / 4K monitor** — Bryan's desktop | Doc-list sidebar defaults OPEN; everything else as below |
| **1101–1920px** | **Tablet / laptop** — iPad landscape (1180 Air, 1194 Pro 11", 1366 Pro 12.9"), every MacBook (1470–1728), and small desktop windows | Doc-list sidebar defaults CLOSED, topbar toggle offered; threads pane fixed at right |
| **≤1100px** | **Mobile** | Sidebar unavailable, topbar dropdown is the whole nav; comment cards go inline |

Two sub-boundaries live inside the mobile tier and predate this split:

| Width | What changes |
|---|---|
| **721–900px** | Threads pane drawer-ifies (overlay, not a fixed column) |
| **≤720px** | All phone rules below — the canonical `@media (max-width: 720px)` |

**A MacBook is in the same tier as an iPad here, deliberately.** Bryan:
*"MacBook also shouldn't have the sidebar for diff reviews — it's too much
space."* The tier boundary is not asking what hardware this is; it is asking
whether a 320px column costs the prose anything. Below 1921px it does.

### Width cannot identify a device — page zoom moves it

This is why the tiers are about available room and not about devices at all.
**Page zoom scales the layout viewport**: a 1366px iPad Pro at 85% zoom reports
**1607px** to CSS. So any gate set high enough to exclude that iPad also
excludes a 1512px MacBook, and a reviewer who pinches lands in a different tier
without changing device.

Measured, not theorised: PR #267 hid the sidebar below 1367px specifically to
exclude iPads, and Bryan defeated it the same day by zooming out — *"I actually
zoom out a bit and the panel is back on my iPad."* Anything that must be true
per-device cannot be expressed as a width. The doc-list sidebar stopped trying:
visibility is now a stored per-reviewer choice (`lf:set-pane`), width only picks
the default and decides whether the toggle is offered at all.

The sidebar only ever appears for a review SET (diff review or folder bind).
An individual doc has no `setId`/`workspaceId`, so it has never shown one at
any width — measured, not assumed.

Use `@media (max-width: 720px)` as the canonical phone breakpoint.

## The primary device is an iPad in landscape, and its scarce axis is HEIGHT

Bryan, 2026-08-19: *"assume I'm using my iPad most of the time with the keyboard attachment in landscape"*.

That width — 1180px on an iPad Air, 1366px on a 12.9" Pro — is far above every phone rule in this file, and the 430px verification step below never reaches it. Until 2026-08-19 it was also above every breakpoint, so it got the full desktop layout: for months the viewport he uses most was the one nothing here told anyone to open.

**It is not a narrow screen. It is a short one.** 1180×820 has more horizontal room than most laptops in a split window, and about 750px of usable height once browser chrome is subtracted — roughly half a desktop monitor. So the failure mode is not overflow, it is **vertical budget**: chrome that costs a row, headers that label what is already visible, padding stacked above the content.

That reframes complaints that sound horizontal. The `In this review` sidebar header was removed for costing ~36px of vertical space (PR #267) — on a 1440px-tall desktop nobody would ever have noticed, and at 430px the sidebar is not even rendered. It was only ever a problem in this band.

Practical consequences:

- **Spend width, save height.** Prefer a wider row to a taller one. A label that can sit inline next to its control should not sit above it.
- **Don't pay for a heading that repeats its contents.** A titled pane whose items already say what they are is one row of pure cost.
- **A hardware keyboard is attached**, so keyboard shortcuts are reachable and there is no on-screen keyboard eating the viewport — but also no hover, and touch targets still apply (see Tap targets).
- **Sticky/fixed chrome compounds.** Two fixed bars at 48px each are 13% of the usable height here versus 6% on a desktop.

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

- **Sidebars are opt-in above the mobile tier, and unavailable inside it.** On mobile a sidebar would take the whole screen above the content (vertical stack in a single-column grid), so the topbar dropdown replaces it outright. Above 1100px the sidebar is offered as a toggle and defaults closed below 4K — the reviewer's choice is stored, not re-derived from the viewport on every load.
- **Auto-open the dropdown on first paint when there's something to discover.** If the doc has a `setId` and the user is on mobile, open the set dropdown by default — don't make them discover the tap target.
- **Dropdown auto-closes on scroll.** Reaching the content is the strongest "done with the nav" signal — don't make the user tap-to-dismiss before reading. Listen on both `#editor` scroll and window scroll, passive.
- **Outside-click and Escape also close.** Standard expectations.

## Tap targets

Minimum 36×36px for any interactive element. The format-bar buttons drop to icon-only at narrow widths (Code / Code block / Link / HR all hide below 560px).

## Verifying mobile changes

**Check both viewports. They fail differently and neither substitutes for the other** — a change can be clean at 430px (where the element is not rendered at all) and cost real estate at 1180×820.

**Add a third check at ≥1921px whenever the change behaves differently per tier** (anything gated on the 4K boundary, like the doc-list sidebar's default). A tier with no verification step is a tier where the default is whatever the code happened to do.

### iPad landscape — 1180×820 (and 1366×1024 on a 12.9" Pro), the primary device

Chrome cannot be resized to an exact viewport reliably, so load the page inside a same-origin **1180×820 iframe** and drive that. Check: nothing is fixed or sticky that did not need to be, the primary content starts within the first screen, and no row exists purely to label the row under it. Measure with `getBoundingClientRect()` rather than eyeballing a screenshot — 36px is invisible to the eye and is 5% of the usable height.

### Phone — 430px

1. Resize the browser to 430px wide (matches iPhone 16 Pro Max viewport).
2. Open a markdown doc with a `setId` (so the dropdown logic is exercised) and inline code or long file paths in the content (so wrap behavior is exercised). Currently `a partner project-2433-plan` works.
3. Check: no horizontal overflow at any scroll position, dropdown opens by default, scrolling closes it, headings fit within viewport.
4. Hard reload (Cmd+Shift+R) — the markdown-app bundle and CSS are cached aggressively.

If you can't easily get to a real iPhone, using Chrome DevTools' device toolbar at iPhone 16 Pro Max preset is acceptable for a first pass; ship-then-confirm for the real-device case.

## Why these rules exist

Three iterations of the same mobile-overflow bug shipped before the root cause (CSS Grid `1fr`) was understood. Bryan does meaningful review on his phone — the editor's mobile UX is load-bearing, not nice-to-have.

The iPad section was added 2026-08-19, after a change was verified at 430px and on a wide desktop window and shipped a regression visible at neither. Two verification widths that both miss the primary device look exactly like thorough coverage.
