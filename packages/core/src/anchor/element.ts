import type { ElementAnchor, ElementFingerprint } from '../types.ts';
import type { ElementResolution, ElementResolveEnv } from './index.ts';
import { SCORE_THRESHOLD } from './index.ts';

const STABLE_ATTR_NAMES = ['role', 'aria-label', 'name', 'data-testid'] as const;
const SNIPPET_MAX = 80;
const TEXT_MAX = 60;

export function createFingerprint(el: HTMLElement): ElementFingerprint {
  return {
    id: el.id || undefined,
    tag: el.tagName.toUpperCase(),
    stableAttrs: readStableAttrs(el),
    classes: readClasses(el),
    text: extractText(el),
    path: computePath(el),
    dataAttrs: readDataAttrs(el),
    rect: readRect(el),
  };
}

export function createAnchor(el: HTMLElement): ElementAnchor {
  const fp = createFingerprint(el);
  return {
    kind: 'element',
    fingerprint: fp,
    snippet: {
      text: fp.text ? truncate(fp.text, SNIPPET_MAX) : `<${fp.tag.toLowerCase()}>`,
      rect: fp.rect,
    },
  };
}

export function resolve(anchor: ElementAnchor, env: ElementResolveEnv): ElementResolution {
  const fp = anchor.fingerprint;
  const root = env.root as ParentNode & Pick<Document, 'getElementById'>;

  // fast path: id match
  if (fp.id) {
    const byId = typeof root.getElementById === 'function' ? root.getElementById(fp.id) : null;
    if (byId instanceof HTMLElement) {
      const score = scoreMatch(fp, byId);
      if (score >= SCORE_THRESHOLD) return { ok: true, element: byId, score };
    }
  }

  // otherwise search all elements with matching tag
  const candidates = Array.from(root.querySelectorAll<HTMLElement>(fp.tag.toLowerCase()));
  let best: { el: HTMLElement; score: number } | null = null;
  for (const c of candidates) {
    const s = scoreMatch(fp, c);
    if (!best || s > best.score) best = { el: c, score: s };
  }
  if (!best) return { ok: false, reason: 'not-found', score: 0 };
  if (best.score < SCORE_THRESHOLD)
    return { ok: false, reason: 'low-confidence', score: best.score };
  return { ok: true, element: best.el, score: best.score };
}

/**
 * Score 0..100 of how well an element matches a fingerprint.
 * Weights roughly mirror the tested health-tool algorithm.
 *
 *   tag match (required): 0 if wrong
 *   id match:             +30
 *   stable attrs match:   +5 each (max +20)
 *   data-testid:          +20
 *   class overlap:        up to +10
 *   text similarity:      up to +20
 *   path match:           up to +20
 */
export function scoreMatch(fp: ElementFingerprint, el: HTMLElement): number {
  if (el.tagName.toUpperCase() !== fp.tag) return 0;
  let score = 0;
  if (fp.id && fp.id === el.id) score += 30;

  let attrHits = 0;
  for (const name of STABLE_ATTR_NAMES) {
    const want = fp.stableAttrs[name];
    if (!want) continue;
    if (el.getAttribute(name) === want) attrHits++;
  }
  score += Math.min(attrHits * 5, 20);

  if (
    fp.stableAttrs['data-testid'] &&
    el.getAttribute('data-testid') === fp.stableAttrs['data-testid']
  ) {
    score += 20;
  }

  // class overlap
  const elClasses = new Set(Array.from(el.classList));
  const shared = fp.classes.filter((c) => elClasses.has(c));
  if (fp.classes.length > 0) {
    score += Math.min((shared.length / fp.classes.length) * 10, 10);
  }

  // text similarity: simple token-overlap ratio on leading 60 chars
  const elText = extractText(el);
  if (fp.text && elText) {
    score += Math.min(tokenOverlap(fp.text, elText) * 20, 20);
  }

  // path match score
  score += Math.min(pathMatchScore(fp.path, computePath(el)) * 20, 20);

  return Math.round(score);
}

function readStableAttrs(el: HTMLElement): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of STABLE_ATTR_NAMES) {
    const v = el.getAttribute(name);
    if (v) out[name] = v;
  }
  const named = el.getAttribute('name');
  if (named) out.name = named;
  return out;
}

function readClasses(el: HTMLElement): string[] {
  return Array.from(el.classList)
    .filter((c) => !c.startsWith('hover:') && !c.includes(':'))
    .sort();
}

function readDataAttrs(el: HTMLElement): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of Array.from(el.attributes)) {
    if (a.name.startsWith('data-') && a.name !== 'data-feedback-widget') {
      out[a.name] = a.value;
    }
  }
  return out;
}

function extractText(el: HTMLElement): string {
  const raw = (el.textContent ?? '').trim().replace(/\s+/g, ' ');
  return truncate(raw, TEXT_MAX);
}

function computePath(el: HTMLElement): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  let depth = 0;
  while (cur && depth < 5) {
    const parent: Element | null = cur.parentElement;
    let idx = 0;
    if (parent) {
      const siblings = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
      idx = siblings.indexOf(cur);
    }
    parts.push(`${cur.tagName.toUpperCase()}[${idx}]`);
    cur = parent;
    depth++;
  }
  return parts.reverse().join(' > ');
}

function readRect(el: HTMLElement): ElementFingerprint['rect'] {
  if (typeof el.getBoundingClientRect !== 'function') return undefined;
  const r = el.getBoundingClientRect();
  const vw = typeof window !== 'undefined' ? window.innerWidth || 1 : 1;
  const vh = typeof window !== 'undefined' ? window.innerHeight || 1 : 1;
  return {
    x: +(r.left / vw).toFixed(3),
    y: +(r.top / vh).toFixed(3),
    w: +(r.width / vw).toFixed(3),
    h: +(r.height / vh).toFixed(3),
  };
}

function tokenOverlap(a: string, b: string): number {
  if (!a || !b) return 0;
  const sa = new Set(a.toLowerCase().split(/\W+/).filter(Boolean));
  const sb = new Set(b.toLowerCase().split(/\W+/).filter(Boolean));
  if (sa.size === 0 || sb.size === 0) return 0;
  let hit = 0;
  for (const t of sa) if (sb.has(t)) hit++;
  const union = new Set([...sa, ...sb]).size;
  return union > 0 ? hit / union : 0;
}

/** How similar two index-based paths are (0..1). */
function pathMatchScore(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const aParts = a.split(' > ');
  const bParts = b.split(' > ');
  let hits = 0;
  const max = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < max; i++) {
    const pa = aParts[aParts.length - 1 - i];
    const pb = bParts[bParts.length - 1 - i];
    if (pa && pb && pa === pb) hits++;
  }
  return hits / max;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}
