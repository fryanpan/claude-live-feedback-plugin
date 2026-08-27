/**
 * The Open Props files vendored into the served `/app/tokens.css` (board task
 * t-9Ujf8EcjSpbR — a bounded TRIAL of Open Props as the design-token layer,
 * not a wholesale migration).
 *
 * A subset on purpose: the full `open-props.min.css` is ~29.5KB and most of
 * it (animations, easings, gradients, masks, zindex, every unused hue) maps
 * to nothing this app's tokens name. Each file here is present because
 * `src/tokens.css` reads a var it defines — `tokens-css.test.ts` fails if a
 * mapping reads a var no file on this list ships, which is otherwise a
 * SILENT failure: `var(--dropped-hue-7)` computes to the invalid initial
 * value with no build error anywhere.
 *
 * `scripts/build.ts` concatenates these (in order) with `src/tokens.css`
 * into `dist/tokens.css`, served at `/app/tokens.css`. Mockups served by
 * `bind_mock` are same-origin, so a mockup gets the app's palette with one
 * line: `<link rel="stylesheet" href="/app/tokens.css">`.
 */
export const OPEN_PROPS_FILES = [
  'gray.min.css',
  'blue.min.css',
  'orange.min.css',
  'red.min.css',
  'green.min.css',
  'borders.min.css',
  'shadows.min.css',
] as const;
