import type * as Y from 'yjs';
import type { Anchor, ElementAnchor, TextRangeAnchor } from '../types.ts';
import * as TextRange from './text-range.ts';
import * as Element from './element.ts';

export { TextRange, Element };

export interface TextResolveEnv {
  doc: Y.Doc;
  ytext: Y.Text;
}

export interface ElementResolveEnv {
  root: ParentNode;
}

export type TextResolution =
  | { ok: true; start: number; end: number }
  | { ok: false; reason: 'deleted' };

export type ElementResolution =
  | { ok: true; element: HTMLElement; score: number }
  | { ok: false; reason: 'not-found' | 'low-confidence'; score: number };

export function resolveText(anchor: TextRangeAnchor, env: TextResolveEnv): TextResolution {
  return TextRange.resolve(anchor, env);
}

export function resolveElement(anchor: ElementAnchor, env: ElementResolveEnv): ElementResolution {
  return Element.resolve(anchor, env);
}

/** Convenience: classify an anchor as orphan eligible. */
export function isResolvable(anchor: Anchor): boolean {
  return anchor.kind !== 'orphan';
}

export const SCORE_THRESHOLD = 40;
