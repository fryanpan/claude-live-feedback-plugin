import { beforeEach, describe, expect, it } from 'vitest';
import { createAnchor, createFingerprint, scoreMatch } from '../src/anchor/element.ts';
import { resolve } from '../src/anchor/element.ts';

function setDom(html: string) {
  document.body.innerHTML = html;
}

describe('element anchor', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('creates a fingerprint with tag, id, text, path', () => {
    setDom('<main><form><button id="submit" aria-label="Go">Submit</button></form></main>');
    const el = document.getElementById('submit') as HTMLElement;
    const fp = createFingerprint(el);
    expect(fp.tag).toBe('BUTTON');
    expect(fp.id).toBe('submit');
    expect(fp.text).toBe('Submit');
    expect(fp.stableAttrs['aria-label']).toBe('Go');
    expect(fp.path).toContain('BUTTON[0]');
  });

  it('resolves the same element exactly', () => {
    setDom(
      '<main><form><button id="submit" aria-label="Go" class="btn primary">Submit</button></form></main>',
    );
    const el = document.getElementById('submit') as HTMLElement;
    const anchor = createAnchor(el);
    const r = resolve(anchor, { root: document });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.element).toBe(el);
      expect(r.score).toBeGreaterThanOrEqual(80);
    }
  });

  it('resolves to the best match when id is removed but other attrs remain', () => {
    setDom(
      '<main><form><button id="submit" aria-label="Go" class="btn primary">Submit</button></form></main>',
    );
    const el = document.getElementById('submit') as HTMLElement;
    const anchor = createAnchor(el);
    // remove id to simulate a refactor; aria-label + text + path should still carry
    el.removeAttribute('id');
    const r = resolve(anchor, { root: document });
    expect(r.ok).toBe(true);
  });

  it('orphans when the element is removed entirely', () => {
    setDom(
      '<main><form><button id="submit" aria-label="Go" class="btn primary">Submit</button></form></main>',
    );
    const el = document.getElementById('submit') as HTMLElement;
    const anchor = createAnchor(el);
    el.remove();
    const r = resolve(anchor, { root: document });
    expect(r.ok).toBe(false);
  });

  it('scoreMatch returns 0 for different tags', () => {
    setDom('<button id="b">Hi</button><div id="d">Hi</div>');
    const btn = document.getElementById('b') as HTMLElement;
    const div = document.getElementById('d') as HTMLElement;
    const fp = createFingerprint(btn);
    expect(scoreMatch(fp, div)).toBe(0);
  });

  it('low confidence → not ok', () => {
    setDom(
      '<main><form><button id="submit" aria-label="Go" class="btn primary">Submit</button></form></main>',
    );
    const el = document.getElementById('submit') as HTMLElement;
    const anchor = createAnchor(el);
    setDom('<nav><section><button class="unrelated">Cancel</button></section></nav>');
    const r = resolve(anchor, { root: document });
    expect(r.ok).toBe(false);
  });

  it('resolves among many similar siblings using path index', () => {
    setDom(`
      <ul>
        <li><button class="del">x</button></li>
        <li><button class="del">x</button></li>
        <li><button class="del" id="third">x</button></li>
      </ul>
    `);
    const target = document.getElementById('third') as HTMLElement;
    const a = createAnchor(target);
    const r = resolve(a, { root: document });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.element).toBe(target);
  });
});
