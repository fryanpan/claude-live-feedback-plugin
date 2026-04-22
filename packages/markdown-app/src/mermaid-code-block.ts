import type { NodeViewRendererProps } from '@tiptap/core';
import CodeBlock from '@tiptap/extension-code-block';

/**
 * CodeBlock override that renders a Mermaid diagram above the source
 * for code blocks with `language = "mermaid"`. Everything else behaves
 * like the standard CodeBlock. The schema is unchanged — still stored
 * as `codeBlock` with a `language` attribute, so round-tripping to the
 * .md file on disk as ` ```mermaid … ``` ` works out of the box.
 *
 * Mermaid.js is loaded lazily on the first mermaid block we see so the
 * library (~1.5 MB) doesn't bloat the initial bundle for docs without
 * diagrams. Subsequent edits re-render with a 400ms debounce.
 */

type MermaidModule = {
  default: {
    initialize: (o: unknown) => void;
    render: (id: string, src: string) => Promise<{ svg: string }>;
  };
};

let mermaidPromise: Promise<MermaidModule> | null = null;
function loadMermaid(): Promise<MermaidModule> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => {
      // startOnLoad=false: we drive rendering manually per block.
      // securityLevel=loose: allow the diagram to use inline styles.
      m.default.initialize({
        startOnLoad: false,
        theme: 'neutral',
        securityLevel: 'loose',
        fontFamily: 'inherit',
      });
      return m as unknown as MermaidModule;
    });
  }
  return mermaidPromise;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return map[c] ?? c;
  });
}

export const MermaidCodeBlock = CodeBlock.extend({
  addNodeView() {
    return ({ node: initial }: NodeViewRendererProps) => {
      let node = initial;

      const wrapper = document.createElement('div');
      wrapper.className = 'cm-codeblock';

      // Rendered diagram — only visible for mermaid blocks.
      const rendered = document.createElement('div');
      rendered.className = 'cm-diagram';
      rendered.setAttribute('contenteditable', 'false');
      wrapper.appendChild(rendered);

      // Source <pre><code> — Tiptap puts the editable text here.
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      const lang = (node.attrs.language as string | null) ?? '';
      if (lang) code.className = `language-${lang}`;
      pre.appendChild(code);
      wrapper.appendChild(pre);

      let lastSource = '';
      let pending: ReturnType<typeof setTimeout> | null = null;

      const scheduleRender = () => {
        const language = (node.attrs.language as string | null) ?? '';
        if (language !== 'mermaid') {
          rendered.style.display = 'none';
          return;
        }
        rendered.style.display = '';
        const source = node.textContent;
        if (source === lastSource) return;
        lastSource = source;

        if (!source.trim()) {
          rendered.innerHTML = '';
          return;
        }

        if (pending) clearTimeout(pending);
        pending = setTimeout(async () => {
          try {
            const mermaid = (await loadMermaid()).default;
            const id = `mermaid-${Math.random().toString(36).slice(2, 9)}`;
            const { svg } = await mermaid.render(id, source);
            rendered.innerHTML = svg;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            rendered.innerHTML = `<div class="cm-diagram-error">Mermaid error: ${escapeHtml(msg)}</div>`;
          }
        }, 400);
      };

      scheduleRender();

      return {
        dom: wrapper,
        contentDOM: code,
        update(newNode) {
          if (newNode.type !== node.type) return false;
          node = newNode;
          // Keep the language class in sync if the block's language attr changed.
          const newLang = (newNode.attrs.language as string | null) ?? '';
          code.className = newLang ? `language-${newLang}` : '';
          scheduleRender();
          return true;
        },
        destroy() {
          if (pending) clearTimeout(pending);
        },
      };
    };
  },
});
