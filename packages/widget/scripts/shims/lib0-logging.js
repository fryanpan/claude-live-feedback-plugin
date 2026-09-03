/**
 * Build-time stand-in for `lib0/logging` in the widget bundle.
 *
 * yjs reaches for this module five times, all of them console diagnostics:
 * `print` for the client-id collision notice and the struct dumps, `warn` for
 * the "Not same Y.Doc" and premature-access notices. The real module exists to
 * render those in colour, and to do it it imports `lib0/dom`, which imports
 * `lib0/schema` — a 6.8 KB runtime type validator the widget never otherwise
 * touches. That chain cost ~9.2 KB raw / ~2.9 KB gzipped of a hard budget.
 *
 * The diagnostics still reach the console; they arrive unstyled. The colour
 * constants become empty strings and are filtered out of the argument list so
 * they do not show up as stray arguments.
 *
 * Every export the real module has is present, because `build.ts` compares the
 * two lists and fails the build when they diverge — a missing export would
 * otherwise ship as a silent `undefined` inside somebody else's library.
 */
export const BOLD = '';
export const UNBOLD = '';
export const BLUE = '';
export const GREY = '';
export const GREEN = '';
export const RED = '';
export const PURPLE = '';
export const ORANGE = '';
export const UNCOLOR = '';

const visible = (args) => args.filter((a) => a !== '');

export const print = (...args) => console.log(...visible(args));
export const warn = (...args) => console.warn(...visible(args));
export const printError = (err) => console.error(err);
export const group = (...args) => console.group(...visible(args));
export const groupCollapsed = (...args) => console.groupCollapsed(...visible(args));
export const groupEnd = () => console.groupEnd();
export const createModuleLogger = () => () => {};

// The rest of lib0/logging's surface renders images, canvases and DOM nodes
// into the console, or mirrors output into an on-page VConsole. Nothing in the
// widget's dependency graph calls them; they exist so the shim's export list
// matches the real module's. Each degrades to plain console output.
export const printDom = (...args) => console.log(...visible(args));
export const printCanvas = (...args) => console.log(...visible(args));
export const printImg = (...args) => console.log(...visible(args));
export const printImgBase64 = (...args) => console.log(...visible(args));
export const vconsoles = new Set();
export class VConsole {
  constructor() {
    this.ccontainer = null;
  }
  group() {}
  groupCollapsed() {}
  groupEnd() {}
  print() {}
  printError() {}
  printImg() {}
  printDom() {}
  destroy() {}
}
export const createVConsole = () => new VConsole();
