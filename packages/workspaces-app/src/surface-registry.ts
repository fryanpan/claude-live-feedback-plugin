import type { MountFn } from './mount-context.ts';

/**
 * Late-bound handle to the full markdown surface (mountMarkdown, defined in
 * app.ts). redline-app mounts it for the editable File view of a `.md` diff
 * member — importing it directly would make app.ts ⇄ redline-app a module
 * cycle, so app.ts registers it at boot instead.
 */
let markdownMount: MountFn | null = null;

export function registerMarkdownMount(fn: MountFn): void {
  markdownMount = fn;
}

export function getMarkdownMount(): MountFn | null {
  return markdownMount;
}
