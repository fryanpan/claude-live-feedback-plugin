import * as Y from 'yjs';
import type { TextRangeAnchor } from '../types.ts';
import type { TextResolution, TextResolveEnv } from './index.ts';
import { decodeRelativePositionSafe } from './validate.ts';

const SNIPPET_MAX = 80;

export function createFromOffsets(ytext: Y.Text, start: number, end: number): TextRangeAnchor {
  const clamped = clamp(start, end, ytext.length);
  const startRel = Y.createRelativePositionFromTypeIndex(ytext, clamped.start);
  const endRel = Y.createRelativePositionFromTypeIndex(ytext, clamped.end);
  const text = ytext.toString().slice(clamped.start, clamped.end);
  return {
    kind: 'text-range',
    startRel: Y.encodeRelativePosition(startRel),
    endRel: Y.encodeRelativePosition(endRel),
    snippet: { text: truncate(text, SNIPPET_MAX) },
  };
}

export function resolve(anchor: TextRangeAnchor, env: TextResolveEnv): TextResolution {
  // A malformed / undecodable position is reported as 'deleted' rather than
  // thrown: it is indistinguishable from a position that no longer resolves,
  // and every caller already handles that. Throwing here reaches callers
  // running inside Yjs observers, where it becomes an unhandled async error
  // charged to an unrelated request.
  const startRel = decodeRelativePositionSafe(anchor.startRel);
  const endRel = decodeRelativePositionSafe(anchor.endRel);
  if (!startRel || !endRel) {
    return { ok: false, reason: 'deleted' };
  }
  const startAbs = Y.createAbsolutePositionFromRelativePosition(startRel, env.doc);
  const endAbs = Y.createAbsolutePositionFromRelativePosition(endRel, env.doc);
  if (!startAbs || !endAbs) {
    return { ok: false, reason: 'deleted' };
  }
  if (startAbs.type !== env.ytext || endAbs.type !== env.ytext) {
    return { ok: false, reason: 'deleted' };
  }
  const start = Math.min(startAbs.index, endAbs.index);
  const end = Math.max(startAbs.index, endAbs.index);
  if (start === end) {
    // range collapsed — treat as deleted for orphan purposes
    return { ok: false, reason: 'deleted' };
  }
  return { ok: true, start, end };
}

function clamp(start: number, end: number, max: number): { start: number; end: number } {
  const a = Math.max(0, Math.min(start, max));
  const b = Math.max(0, Math.min(end, max));
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}
