/**
 * Build-time stand-in for `lib0/environment` in the widget bundle.
 *
 * The bundle reads exactly two things from it: `getVariable`, which yjs calls
 * once to decide whether it is in dev mode (`node_env === 'development'`, which
 * gates a `deepFreeze` on `ContentAny`), and `isBrowser`, which `lib0/buffer`
 * uses to pick a base64 implementation. The real module carries CLI-argument
 * and environment-variable parsing, and pulls in `lib0/storage` and
 * `lib0/conditions` to do it — machinery a script tag on a host page has no
 * environment to read.
 *
 * `getVariable` returning null keeps the widget on yjs's production path, which
 * is what a bundle built with `target: 'browser'` and shipped to host pages was
 * already getting. `isBrowser` keeps its real runtime test rather than a
 * hard-coded true, so the value is still computed the way lib0 computes it.
 */
export const isNode = false;
export const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';
export const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
export const hasParam = () => false;
export const getParam = (_name, defaultVal) => defaultVal;
export const getVariable = () => null;
export const getConf = () => null;
export const ensureConf = (name) => {
  throw new Error(`Expected configuration ${name.toUpperCase()}`);
};
export const hasConf = () => false;
export const production = false;
export const supportsColor = false;
