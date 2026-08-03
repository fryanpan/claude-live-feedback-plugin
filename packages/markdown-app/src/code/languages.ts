import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { java } from '@codemirror/lang-java';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';
import { StreamLanguage } from '@codemirror/language';
import { c, cpp, kotlin, objectiveC, objectiveCpp } from '@codemirror/legacy-modes/mode/clike';
import { less, sCSS } from '@codemirror/legacy-modes/mode/css';
import { groovy } from '@codemirror/legacy-modes/mode/groovy';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { ruby } from '@codemirror/legacy-modes/mode/ruby';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { standardSQL } from '@codemirror/legacy-modes/mode/sql';
import { swift } from '@codemirror/legacy-modes/mode/swift';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import type { Extension } from '@codemirror/state';

/**
 * Map a file path (or bare extension) to a CodeMirror language extension.
 *
 * Coverage target: the file types typical of Android, iOS, and web
 * frontend/backend projects — first-party packs where they exist, legacy
 * stream modes for the rest (degraded-but-useful highlighting).
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
    case 'xml':
    case 'xsd':
    case 'xsl':
    case 'svg':
    case 'plist': // iOS property lists are XML on disk
      return xml();
    case 'html':
    case 'htm':
      return html();
    case 'css':
      return css();
    case 'scss':
    case 'sass':
      return StreamLanguage.define(sCSS);
    case 'less':
      return StreamLanguage.define(less);
    case 'yaml':
    case 'yml':
      return yaml();
    case 'md':
    case 'markdown':
      return markdown();
    case 'swift':
      return StreamLanguage.define(swift);
    case 'm':
      return StreamLanguage.define(objectiveC);
    case 'mm':
      return StreamLanguage.define(objectiveCpp);
    case 'c':
    case 'h':
      return StreamLanguage.define(c);
    case 'cc':
    case 'cpp':
    case 'cxx':
    case 'hpp':
      return StreamLanguage.define(cpp);
    case 'groovy':
    case 'gradle': // build.gradle / settings.gradle
      return StreamLanguage.define(groovy);
    case 'rb':
    case 'podfile': // extensionless Podfile — extOf falls through to the basename
    case 'gemfile':
      return StreamLanguage.define(ruby);
    case 'sh':
    case 'bash':
    case 'zsh':
      return StreamLanguage.define(shell);
    case 'properties': // gradle.properties, local.properties
    case 'pro': // proguard-rules.pro reads fine as key/value + comments
      return StreamLanguage.define(properties);
    case 'toml':
      return StreamLanguage.define(toml);
    case 'sql':
      return StreamLanguage.define(standardSQL);
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
