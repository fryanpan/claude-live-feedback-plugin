import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import mermaid from 'mermaid';

let mermaidReady = false;

function ensureMermaid(): void {
  if (mermaidReady) return;
  mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'loose' });
  mermaidReady = true;
}

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: false })
  .use(rehypeStringify);

export async function renderMarkdown(md: string, target: HTMLElement): Promise<void> {
  const html = String(await processor.process(md));
  target.innerHTML = html;
  await renderMermaid(target);
}

async function renderMermaid(target: HTMLElement): Promise<void> {
  ensureMermaid();
  const blocks = target.querySelectorAll<HTMLElement>('code.language-mermaid');
  let i = 0;
  for (const code of Array.from(blocks)) {
    const pre = code.parentElement;
    const source = code.textContent ?? '';
    const id = `mermaid-${Date.now()}-${i++}`;
    const container = document.createElement('div');
    container.className = 'mermaid-block';
    try {
      const { svg } = await mermaid.render(id, source);
      container.innerHTML = svg;
    } catch (err) {
      container.textContent = `mermaid render error: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (pre?.parentElement) pre.parentElement.replaceChild(container, pre);
  }
}
