/**
 * De-dupes a repeat `POST /api/docs/:id/threads` that carries the same
 * client-generated `requestId` as one this server already turned into a
 * thread, within a short window.
 *
 * This is the belt to the composer's suspenders (`review-chrome.ts`
 * `submitComposer`'s in-flight guard). The client guard stops the request
 * from being sent twice in the first place — but it protects one call site,
 * and it protects nothing against a request that DID land but looked like a
 * failure to the browser (a dropped response, a retry after a timeout), or
 * two requests that are GENUINELY concurrent (arrive close enough together
 * that a naive check-then-create still lets both through). This is what
 * makes "one thread per comment" true regardless of which client, or which
 * future bug in one, sent the repeat.
 *
 * Measured 2026-08-29: a double submit on the doc composer created two
 * threads, same text, same anchor, 343ms apart — a tap and a keyboard Enter
 * both reaching the one submit handler before the first request had a
 * response back.
 *
 * `dedupe` reserves the (docId, requestId) key SYNCHRONOUSLY, in the same
 * tick as the decision to create — before `create` is ever awaited. A first
 * version of this checked for an existing thread, then called `create`, then
 * recorded the result: a caller could check before an earlier caller had
 * recorded anything, race straight through, and (for this route) run the
 * review-item side effects a second time. Reserving with the in-flight
 * PROMISE, not just its eventual result, is what closes that: a concurrent
 * second call finds the reservation already in place and awaits the SAME
 * promise, so `create` — and everything inside it — runs exactly once no
 * matter how many duplicate requests arrive while it is running.
 *
 * In-memory, and the create's text + identity (anchor AND any declared
 * review — see `identityKey` below) are checked again on a repeat: a caller
 * that reuses an id for a genuinely different comment gets a fresh thread,
 * not a collision with someone else's. Deliberately NOT persisted — a
 * requestId is only ever replayed within the few seconds of one submit
 * attempt's own retries, never across a restart.
 *
 * `identityKey` is caller-built (see `server.ts`'s POST /threads handler) and
 * MUST fold in every field a repeat could plausibly change on purpose: not
 * just the anchor, but the declared `review` payload too. Codex review
 * caught this once already — an earlier version keyed on anchor alone, so
 * reusing a requestId with the same text/anchor but a CORRECTED review
 * declaration (e.g. filling in a missing `detail`) silently returned the
 * stale thread instead of ever persisting the correction.
 */

const DEFAULT_TTL_MS = 10_000;

interface Entry<T> {
  text: string;
  identityKey: string;
  ts: number;
  promise: Promise<T>;
}

export class ThreadRequestDedup<T> {
  private readonly seen = new Map<string, Entry<T>>();

  constructor(private readonly ttlMs = DEFAULT_TTL_MS) {}

  private key(docId: string, requestId: string): string {
    return `${docId} ${requestId}`;
  }

  private prune(now: number): void {
    for (const [k, e] of this.seen) {
      if (now - e.ts > this.ttlMs) this.seen.delete(k);
    }
  }

  /**
   * A matching in-flight or completed create's promise, if there is one —
   * a pure read, reserves nothing. This is the escape hatch for a route
   * whose validation reads MUTABLE state a successful create itself
   * changes: `POST /threads`'s review-item branch refuses a second ask
   * while the item is already `waiting`, a state the first request's own
   * side effect sets — so a retry with the same requestId must be caught
   * HERE, before that validation runs, or it never reaches `dedupe` at all
   * and the retry this class exists to support gets a stale-state error
   * instead of the thread it already made.
   */
  lookup(
    docId: string,
    requestId: string | undefined,
    text: string,
    identityKey: string,
  ): Promise<T> | undefined {
    if (!requestId) return undefined;
    this.prune(Date.now());
    const existing = this.seen.get(this.key(docId, requestId));
    return existing && existing.text === text && existing.identityKey === identityKey
      ? existing.promise
      : undefined;
  }

  /**
   * Run `create` for this comment, or — if a request with the same
   * (docId, requestId, text, identityKey) is already in flight or completed
   * within the window — await ITS result instead of running `create` again.
   * `create` should perform the write and every side effect that must not
   * happen twice; a deduped caller never runs it.
   *
   * A `null`/`undefined` result is treated as a failed create and is not
   * remembered past this call — a genuine retry (same requestId, same
   * comment, after the first attempt failed) gets a fresh attempt rather
   * than a cached failure for the rest of the window.
   */
  async dedupe(
    docId: string,
    requestId: string | undefined,
    text: string,
    identityKey: string,
    create: () => Promise<T>,
  ): Promise<{ value: T; deduped: boolean }> {
    const existing = this.lookup(docId, requestId, text, identityKey);
    if (existing) return { value: await existing, deduped: true };
    if (!requestId) return { value: await create(), deduped: false };
    const now = Date.now();
    // Reserved before `create` is awaited — nothing here yields to the event
    // loop between `lookup` above and this write, so a request arriving
    // while `create` is still running always finds this entry.
    const key = this.key(docId, requestId);
    const entry: Entry<T> = { text, identityKey, ts: now, promise: create() };
    this.seen.set(key, entry);
    try {
      const value = await entry.promise;
      if (value == null && this.seen.get(key) === entry) this.seen.delete(key);
      return { value, deduped: false };
    } catch (err) {
      // A rejection is a failed create too — unreserve it so a retry gets a
      // fresh attempt instead of the same rejected promise for the rest of
      // the TTL. A caller that was already awaiting THIS promise (a genuine
      // concurrent duplicate) still sees the same rejection; only a later
      // lookup is affected by the delete.
      if (this.seen.get(key) === entry) this.seen.delete(key);
      throw err;
    }
  }
}
