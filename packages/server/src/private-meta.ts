import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type DocMeta, getMeta } from '@feedback/core';
import type * as Y from 'yjs';

/**
 * Doc metadata that describes the HOST MACHINE rather than the document.
 *
 * `redactMetaForVisitor` strips these from `GET /api/docs/<id>`, but that only
 * closed half the door: they also lived in the Yjs `meta` map, and the server
 * hands the whole CRDT to anyone who opens `/y/<docId>` — share visitors
 * included. A visitor holding one link could read Bryan's filesystem layout,
 * his private repo names, and which agent produced the doc straight off the
 * sync channel, no matter what REST returned.
 *
 * Yjs can't withhold part of a doc from one peer: sync is a state exchange,
 * not a per-connection projection. So these keys leave the CRDT entirely and
 * live in a sidecar next to the `.ydoc`. Nothing on the client ever read their
 * values (only `code-app.ts` touched `sourceUrl`, as a fallback for picking a
 * syntax-highlighting language — the redacted REST payload supplies a
 * basename `relPath` for exactly that), so the move is server-internal.
 */
export const PRIVATE_META_KEYS = ['sourceUrl', 'owner', 'workspaceRoot', 'producedBy'] as const;

export type PrivateMetaKey = (typeof PRIVATE_META_KEYS)[number];
export type PrivateMeta = Pick<DocMeta, PrivateMetaKey>;

const PRIVATE_SET: ReadonlySet<string> = new Set(PRIVATE_META_KEYS);

export function isPrivateMetaKey(key: string): key is PrivateMetaKey {
  return PRIVATE_SET.has(key);
}

function pathFor(dataDir: string, docId: string): string {
  return join(dataDir, `${docId}.private.json`);
}

/**
 * Where a doc's sidecar lives, given the directory its `.ydoc` is in.
 *
 * Exported because two callers have to move or find the sidecar without going
 * through `readPrivateMeta`: archiving carries it alongside the `.ydoc` into
 * `_archive`, and the backfill looks for it next to whichever file it just
 * read. Both need the naming rule, and neither should re-derive it.
 */
export function privateMetaPath(dir: string, docId: string): string {
  return pathFor(dir, docId);
}

/** Pull the private fields out of a full DocMeta. Absent keys stay absent. */
export function pickPrivateMeta(meta: Partial<DocMeta>): PrivateMeta {
  const out: Record<string, unknown> = {};
  for (const k of PRIVATE_META_KEYS) {
    if (meta[k] !== undefined) out[k] = meta[k];
  }
  return out as PrivateMeta;
}

/**
 * Read a doc's sidecar. A missing or unparseable file yields `{}` rather than
 * throwing: the sidecar is a cache of server-side facts, and losing it must
 * degrade the doc (an unbound file, a vaguer activity event), never prevent it
 * from loading.
 */
export function readPrivateMeta(dataDir: string, docId: string): PrivateMeta {
  const path = pathFor(dataDir, docId);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return {};
    return pickPrivateMeta(parsed as Partial<DocMeta>);
  } catch (err) {
    console.error(`[private-meta] unreadable sidecar for ${docId}:`, err);
    return {};
  }
}

/**
 * Write a doc's sidecar, or remove it when there is nothing private left to
 * store. Called from the same debounced choke point that persists the `.ydoc`
 * so the two can't drift apart.
 */
export function writePrivateMeta(dataDir: string, docId: string, meta: Partial<DocMeta>): void {
  const priv = pickPrivateMeta(meta);
  const path = pathFor(dataDir, docId);
  try {
    if (Object.keys(priv).length === 0) {
      if (existsSync(path)) rmSync(path, { force: true });
      return;
    }
    writeFileSync(path, `${JSON.stringify(priv, null, 2)}\n`);
  } catch (err) {
    console.error(`[private-meta] failed to persist sidecar for ${docId}:`, err);
  }
}

/** Delete a doc's sidecar (doc deletion / workspace cleanup). */
export function deletePrivateMeta(dataDir: string, docId: string): void {
  try {
    rmSync(pathFor(dataDir, docId), { force: true });
  } catch {
    /* best effort — a stray sidecar is inert */
  }
}

/**
 * Migration for every `.ydoc` persisted before this change: read the private
 * keys out of the CRDT and DELETE them from it. Reading alone would not be
 * enough — the values would still be in the doc state the next share visitor
 * syncs. Returns whatever was found so the caller can seed the sidecar.
 */
export function liftPrivateMetaFromYdoc(ydoc: Y.Doc): PrivateMeta {
  const m = getMeta(ydoc);
  const found: Record<string, unknown> = {};
  for (const k of PRIVATE_META_KEYS) {
    const v = m.get(k);
    if (v !== undefined) found[k] = v;
  }
  if (Object.keys(found).length === 0) return {};
  ydoc.transact(() => {
    for (const k of PRIVATE_META_KEYS) m.delete(k);
  }, 'private-meta-migration');
  return found as PrivateMeta;
}
