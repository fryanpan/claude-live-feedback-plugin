import { java } from '@codemirror/lang-java';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { python } from '@codemirror/lang-python';
import { StreamLanguage } from '@codemirror/language';
import { kotlin } from '@codemirror/legacy-modes/mode/clike';
import type { Extension } from '@codemirror/state';

/**
 * Map a file path (or bare extension) to a CodeMirror language extension.
 *
 * STATIC imports only — every supported language pack is bundled into the
 * app. This keeps chunk-serving simple (no `splitting:true` / hashed lazy
 * chunks under the `/app/*` static route) at the cost of a slightly larger
 * bundle. The set of languages is small and fixed.
 *
 * Returns `null` for anything unmapped → the surface renders as plain text
 * (no highlighting), which is the correct degraded behavior.
 */
export function languageExtensionFor(pathOrExt: string): Extension | null {
  const ext = extOf(pathOrExt);
  switch (ext) {
    case 'ts':
    case 'mts':
    case 'cts':
    case 'tsx':
      return javascript({ typescript: true, jsx: ext.endsWith('x') });
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'jsx':
      return javascript({ jsx: ext.endsWith('x') });
    case 'java':
      return java();
    case 'py':
    case 'pyi':
      return python();
    case 'json':
    case 'jsonc':
      return json();
    case 'kt':
    case 'kts':
      // No first-party Kotlin pack; the legacy clike mode is a
      // degraded-but-acceptable highlight.
      return StreamLanguage.define(kotlin);
    default:
      return null;
  }
}

/** Lowercased final extension of a path or bare extension string. */
function extOf(pathOrExt: string): string {
  const base = pathOrExt.split(/[\\/]/).pop() ?? pathOrExt;
  const dot = base.lastIndexOf('.');
  const ext = dot >= 0 ? base.slice(dot + 1) : base;
  return ext.toLowerCase();
}
