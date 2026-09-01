/**
 * The universal `reviewItemId` — one id vocabulary for a review item wherever
 * it lives (Bryan, 2026-08-31: "make sure all review items have unique
 * reviewItemId values and that the tools all work with reviewItemId").
 *
 * A TICKET item already has one: the store mints `r-` + 12 base64url chars
 * when the item is filed, and that string is unique by construction. A
 * DOC-THREAD item never had one — it is a payload on a comment, identified by
 * the triple (docId, threadId, commentId) — so its id is DERIVED from that
 * triple rather than minted and stored. Derived for the reason the ticket's
 * `r-legacy` row's id is: the same item always derives the same id, so
 * nothing has to write into thousands of stored `.ydoc`s to give old items an
 * identity, and a read never becomes a write.
 *
 * The derivation is an encoding, not a hash: the address comes back OUT of
 * the id (`parseThreadReviewItemId`), which is what lets a tool addressed by
 * bare `reviewItemId` find the item without scanning — or hydrating — a
 * corpus of docs. Base64url so the id survives a URL path segment; the `rt-`
 * prefix keeps it disjoint from every minted `r-…` id (those never contain a
 * second dash before their random tail is over — but more simply, `rt-` is
 * checked before anything treats an id as opaque).
 *
 * Pure and dependency-free (TextEncoder/TextDecoder are the platform), like
 * the rest of core: the server derives these into queue rows, the MCP bundle
 * decodes them back into addresses, and the browser may do either.
 */

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function encodeBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64URL[a >> 2];
    out += B64URL[((a & 0x03) << 4) | ((b ?? 0) >> 4)];
    if (b !== undefined) out += B64URL[((b & 0x0f) << 2) | ((c ?? 0) >> 6)];
    if (c !== undefined) out += B64URL[c & 0x3f];
  }
  return out;
}

function decodeBase64Url(s: string): Uint8Array | undefined {
  if (s.length === 0 || s.length % 4 === 1) return undefined;
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of s) {
    const v = B64URL.indexOf(ch);
    if (v < 0) return undefined;
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

const THREAD_ID_PREFIX = 'rt-';

/** The derived id of a review item raised on a doc thread. Deterministic:
 *  derive it wherever the triple is in hand, and the same item answers. */
export function threadReviewItemId(docId: string, threadId: string, commentId: string): string {
  const payload = `${docId}\n${threadId}\n${commentId}`;
  return THREAD_ID_PREFIX + encodeBase64Url(new TextEncoder().encode(payload));
}

export interface ThreadReviewItemAddress {
  docId: string;
  threadId: string;
  commentId: string;
}

/**
 * The address back out of a derived id, or undefined for anything else — a
 * minted ticket id, the fixed `r-legacy`, or bytes that do not decode. The
 * caller treats undefined as "opaque: look it up as a ticket item".
 *
 * Split from the END: `threadId` and `commentId` are server-minted and never
 * contain a newline, while a docId is caller-chosen and just might — so the
 * last two segments are theirs and everything before belongs to the doc.
 */
export function parseThreadReviewItemId(id: string): ThreadReviewItemAddress | undefined {
  if (!id.startsWith(THREAD_ID_PREFIX)) return undefined;
  const bytes = decodeBase64Url(id.slice(THREAD_ID_PREFIX.length));
  if (!bytes) return undefined;
  let payload: string;
  try {
    payload = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  const commentAt = payload.lastIndexOf('\n');
  if (commentAt < 0) return undefined;
  const threadAt = payload.lastIndexOf('\n', commentAt - 1);
  if (threadAt < 0) return undefined;
  const docId = payload.slice(0, threadAt);
  const threadId = payload.slice(threadAt + 1, commentAt);
  const commentId = payload.slice(commentAt + 1);
  if (docId === '' || threadId === '' || commentId === '') return undefined;
  return { docId, threadId, commentId };
}
