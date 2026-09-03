import { describe, expect, it } from 'vitest';
import { renderCommentMarkdown, renderCommentMarkdownInline } from '../src/comment-markdown.ts';

describe('renderCommentMarkdown', () => {
  it('escapes HTML — no XSS passthrough', () => {
    const out = renderCommentMarkdown('<img src=x onerror=alert(1)><script>alert(2)</script>');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<script');
    expect(out).toContain('&lt;img');
    expect(out).toContain('&lt;script');
  });

  it('renders bold, italic, code, strike', () => {
    expect(renderCommentMarkdown('**bold**')).toContain('<strong>bold</strong>');
    expect(renderCommentMarkdown('*it*')).toContain('<em>it</em>');
    expect(renderCommentMarkdown('_it_')).toContain('<em>it</em>');
    expect(renderCommentMarkdown('`code`')).toContain('<code>code</code>');
    expect(renderCommentMarkdown('~~s~~')).toContain('<del>s</del>');
  });

  it('renders http/https/mailto links, refuses javascript: urls', () => {
    const a = renderCommentMarkdown('[a](https://x.com/p)');
    expect(a).toContain('<a href="https://x.com/p" target="_blank" rel="noopener noreferrer">');
    expect(a).toContain('>a</a>');
    const js = renderCommentMarkdown('[a](javascript:alert(1))');
    expect(js).not.toContain('<a '); // no anchor created for an unsafe scheme
  });

  it('renders bullet lists', () => {
    const out = renderCommentMarkdown('- one\n- two');
    expect(out).toContain('<ul class="cm-list">');
    expect(out).toContain('<li>one</li>');
    expect(out).toContain('<li>two</li>');
  });

  it('keeps inline-code content literal (snake_case is not italicized)', () => {
    expect(renderCommentMarkdown('`estimated_effort_h`')).toContain(
      '<code>estimated_effort_h</code>',
    );
  });

  it('splits blank-line-separated paragraphs and keeps single newlines as <br>', () => {
    const out = renderCommentMarkdown('line1\nline2\n\npara2');
    expect(out).toContain('line1<br>line2');
    expect(out.match(/<p>/g)?.length).toBe(2);
  });

  /* tiptap-markdown serializes a hard line break as backslash-newline, so a
     dictated multi-line comment arrives as "line\" plus a lone "\" line —
     and the backslashes rendered literally. Backslash-newline IS a markdown
     hard break; the renderer absorbs it as one. */
  it('absorbs hard-break backslashes instead of rendering them', () => {
    const out = renderCommentMarkdown('rate at $100\\\n\\\nArgue with me about why');
    expect(out).not.toContain('\\');
    expect(out.match(/<p>/g)?.length).toBe(2); // the doubled break reads as a paragraph
  });

  it('keeps the line break a single backslash-break asked for', () => {
    const out = renderCommentMarkdown('one\\\ntwo');
    expect(out).toContain('one<br>two');
    expect(out).not.toContain('\\');
  });
});

/**
 * A payload battery, kept because this renderer is the ONE place untrusted
 * text reaches `innerHTML` (threads.ts: `body.innerHTML =
 * renderCommentMarkdown(c.text)`), and anyone with a review link can post a
 * comment. Author names go through `textContent` and are not at risk.
 *
 * The assertion is on what the renderer EMITS, not on what the text contains.
 * A first pass at this grepped the output for `onerror=` / `javascript:` and
 * reported ten holes that did not exist — `&lt;img src=x onerror=alert(1)&gt;`
 * is inert text, and a rejected link is left as literal markdown. Checking the
 * emitted markup instead is what makes the result mean anything.
 */
describe('renderCommentMarkdown — XSS payload battery', () => {
  const ALLOWED = new Set(['p', 'br', 'ul', 'li', 'code', 'strong', 'em', 'del', 'a']);

  /** Tags outside the allowlist, inline event handlers, executable hrefs. */
  function findings(out: string): string[] {
    const bad: string[] = [];
    for (const m of out.matchAll(/<(\/?)([a-zA-Z][^\s/>]*)([^>]*)>/g)) {
      const tag = (m[2] ?? '').toLowerCase();
      if (!ALLOWED.has(tag)) bad.push(`tag <${tag}>`);
      if (/\son[a-z]+\s*=/i.test(m[3] ?? '')) bad.push(`handler <${tag}${m[3]}>`);
    }
    for (const m of out.matchAll(/href="([^"]*)"/g)) {
      const v = (m[1] ?? '').toLowerCase().trim();
      if (!/^(https?:|mailto:)/.test(v)) bad.push(`href ${m[1]}`);
    }
    return bad;
  }

  it('has a detector that can actually see a problem', () => {
    // Without this the battery below would pass on a blind detector.
    expect(
      findings('<img src=x onerror=alert(1)><a href="javascript:alert(1)">x</a>').length,
    ).toBeGreaterThanOrEqual(2);
    expect(findings('<p><strong>ok</strong></p>')).toEqual([]);
  });

  const PAYLOADS = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<svg/onload=alert(1)>',
    "<a href='javascript:alert(1)'>x</a>",
    '[click](javascript:alert(1))',
    '[click](JaVaScRiPt:alert(1))',
    `[click](java${String.fromCharCode(9)}script:alert(1))`,
    `[click](java${String.fromCharCode(10)}script:alert(1))`,
    '[click](data:text/html;base64,PHN2Zz4=)',
    '[click](vbscript:msgbox(1))',
    '[x](%6a%61%76%61script:alert(1))',
    '[x](  javascript:alert(1))',
    '[x](jAvAsCrIpT&colon;alert(1))',
    '[`code`](javascript:alert(1))',
    // Attribute-breakout attempts against the href we do emit.
    '[x](http://a" onmouseover="alert(1))',
    '[x](http://a onclick=alert(1))',
    '[x](https://ok.example.com"onmouseover="alert(1))',
    '[x](https://a.example/?q=<script>)',
    // Payloads wrapped in each transform, in case escaping order slips.
    '`<script>alert(1)</script>`',
    '**<img src=x onerror=alert(1)>**',
    '~~<img src=x onerror=alert(1)>~~',
    '- <script>alert(1)</script>',
  ];

  for (const payload of PAYLOADS) {
    it(`neutralises ${JSON.stringify(payload)}`, () => {
      expect(findings(renderCommentMarkdown(payload))).toEqual([]);
    });
  }

  it('still renders the markup it is supposed to', () => {
    // The cheapest way to pass the battery would be to emit nothing at all.
    const out = renderCommentMarkdown('**hi** [a](https://example.com) `c`');
    expect(out).toContain('<strong>hi</strong>');
    expect(out).toContain('href="https://example.com/"');
    expect(out).toContain('<code>c</code>');
  });
});

/**
 * The INLINE renderer feeds innerHTML sinks for USER-SUPPLIED text — the
 * answered record's quoted words in the doc panel (threads.ts) and on the hub
 * (hub-render.ts). It is escape-first by construction, but that property was
 * unpinned: only the block renderer had a battery, so a refactor that
 * reordered or dropped the escape would have gone green.
 */
describe('renderCommentMarkdownInline — untrusted input', () => {
  const ALLOWED = new Set(['code', 'strong', 'em', 'del', 'a']);

  function findings(out: string): string[] {
    const bad: string[] = [];
    for (const m of out.matchAll(/<(\/?)([a-zA-Z][^\s/>]*)([^>]*)>/g)) {
      const tag = (m[2] ?? '').toLowerCase();
      if (!ALLOWED.has(tag)) bad.push(`tag <${tag}>`);
      if (/\son[a-z]+\s*=/i.test(m[3] ?? '')) bad.push(`handler <${tag}${m[3]}>`);
    }
    for (const m of out.matchAll(/href="([^"]*)"/g)) {
      const v = (m[1] ?? '').toLowerCase().trim();
      if (!/^(https?:|mailto:)/.test(v)) bad.push(`href ${m[1]}`);
    }
    return bad;
  }

  it('escapes a hostile answer to inert text, yielding no element at all', () => {
    const out = renderCommentMarkdownInline('<img src=x onerror=alert(1)>');
    expect(out).toContain('&lt;img');
    // DOM-level: what an innerHTML sink would actually instantiate.
    const holder = document.createElement('span');
    holder.innerHTML = out;
    expect(holder.querySelector('*')).toBeNull();
    expect(holder.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  const PAYLOADS = [
    '<script>alert(1)</script>',
    '<svg/onload=alert(1)>',
    "<a href='javascript:alert(1)'>x</a>",
    '[click](javascript:alert(1))',
    '**<img src=x onerror=alert(1)>**',
    '`<script>alert(1)</script>`',
    '[x](http://a" onmouseover="alert(1))',
  ];
  for (const payload of PAYLOADS) {
    it(`neutralises ${JSON.stringify(payload)}`, () => {
      expect(findings(renderCommentMarkdownInline(payload))).toEqual([]);
    });
  }

  it('still renders the inline markup it is supposed to', () => {
    // The cheapest way to pass the battery is to emit nothing at all.
    const out = renderCommentMarkdownInline('**hi** [a](https://example.com) `c`');
    expect(out).toContain('<strong>hi</strong>');
    expect(out).toContain('href="https://example.com/"');
    expect(out).toContain('<code>c</code>');
  });
});

/**
 * Decision bodies are REQUIRED to be heading-structured — the create API
 * refuses one without `## Question` / `## Stakes` / `## Options` — and the
 * walkthrough is where a person reads them. Without heading support every
 * decision card printed the literal characters `## Question`.
 */
describe('renderCommentMarkdown — headings', () => {
  it('renders an ATX heading as a heading, demoted below the card title', () => {
    const out = renderCommentMarkdown('## Question\nShip it blue or green?');
    expect(out).toContain('<h4 class="cm-h">Question</h4>');
    expect(out).not.toContain('##');
  });

  it('keeps every level distinct and clamps at h6', () => {
    expect(renderCommentMarkdown('# A')).toContain('<h3 class="cm-h">A</h3>');
    expect(renderCommentMarkdown('### A')).toContain('<h5 class="cm-h">A</h5>');
    expect(renderCommentMarkdown('###### A')).toContain('<h6 class="cm-h">A</h6>');
  });

  it('marks up inside a heading, and escapes it', () => {
    expect(renderCommentMarkdown('## **bold** head')).toContain('<strong>bold</strong>');
    expect(renderCommentMarkdown('## <img src=x onerror=alert(1)>')).not.toContain('<img');
  });

  it('leaves a hash that is not a heading alone', () => {
    // No space after the hashes, so it is a tag or an issue number, not a head.
    expect(renderCommentMarkdown('#4 is the one')).toContain('<p>#4 is the one</p>');
    expect(renderCommentMarkdown('a # b')).toContain('<p>a # b</p>');
  });

  it('closes an open list and paragraph before the next heading', () => {
    const out = renderCommentMarkdown('- one\n## Next');
    expect(out).toBe('<ul class="cm-list"><li>one</li></ul><h4 class="cm-h">Next</h4>');
  });
});

describe('renderCommentMarkdown — fenced code', () => {
  it('renders a fenced block as one <pre><code>, escaped, with no prose rules applied inside', () => {
    // An agent's turn note routinely carries a fence; each line used to go
    // through the prose rules, so `# comment` became a heading and `- x` a
    // bullet, with the fence markers left as literal text.
    const out = renderCommentMarkdown(
      'Ran:\n```ts\nfunction retry() {\n  # not python\n  - a dash line\n  a < b && **x**\n}\n```\nDone.',
    );
    expect(out).toBe(
      '<p>Ran:</p><pre class="cm-code"><code>function retry() {\n  # not python\n  - a dash line\n  a &lt; b &amp;&amp; **x**\n}</code></pre><p>Done.</p>',
    );
    expect(out).not.toContain('```');
    expect(out).not.toContain('cm-h');
    expect(out).not.toContain('<strong>');
  });
  it('accepts ~~~ fences and closes an unterminated fence at the end', () => {
    expect(renderCommentMarkdown('~~~\nx\n~~~')).toBe('<pre class="cm-code"><code>x</code></pre>');
    expect(renderCommentMarkdown('```\nx\ny')).toBe('<pre class="cm-code"><code>x\ny</code></pre>');
  });
  it('keeps blank lines inside the block', () => {
    expect(renderCommentMarkdown('```\na\n\n\nb\n```')).toBe(
      '<pre class="cm-code"><code>a\n\n\nb</code></pre>',
    );
  });
});

describe('renderCommentMarkdownInline — hard-break backslashes', () => {
  it('absorbs a backslash-newline as the space it collapses to', () => {
    const out = renderCommentMarkdownInline('one\\\ntwo');
    expect(out).toBe('one two');
  });
});
