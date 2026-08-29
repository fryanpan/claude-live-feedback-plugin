/**
 * A huddle's identity on the server: what it is called, where its file
 * lives, and what its first bytes are.
 *
 * A huddle is a live conversation over a doc, started from the Board before
 * there is a task. Everything about it that is a DOC — the room, the file
 * binding, the board filing, the listing — is the ordinary doc machinery;
 * this module is only the handful of pure decisions the huddle route makes
 * before handing over to it, kept out of `server.ts` so they can be read and
 * tested without a server.
 */

import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

/** Longer than this and it is a paragraph, not a topic. */
export const HUDDLE_TOPIC_MAX = 200;

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * "Huddle 2026-08-29 14:05" — the clock, to the minute, in the SERVER's
 * local time. The server is the box on Bryan's desk, so its clock is the
 * room's clock; a browser-supplied zone would be one more thing to get
 * wrong for a title that only has to read naturally to the people in it.
 */
export function huddleTitle(at: number): string {
  const d = new Date(at);
  return `Huddle ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * The readable name the doc is created under — `huddle-20260829-1405-x7q2`.
 * The doc's ADDRESS is the id `createForCaller` mints; this is the alias
 * that name resolves through, and it needs a random tail because two
 * huddles in one minute are two docs.
 */
export function huddleAlias(at: number): string {
  const d = new Date(at);
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `huddle-${stamp}-${randomBytes(3)
    .toString('base64url')
    .replace(/[^A-Za-z0-9]/g, 'x')}`;
}

/**
 * The topic, if the caller sent one that can be a heading. `undefined` is
 * the bare button press and is fine; a non-string or an over-long one is the
 * caller's mistake and is refused rather than truncated — a title cut mid-word
 * is a worse first line than a 400.
 */
export function parseHuddleTopic(raw: unknown): { ok: true; topic?: string } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true };
  if (typeof raw !== 'string') return { ok: false };
  const topic = raw.trim().replace(/\s+/g, ' ');
  if (topic.length === 0) return { ok: true };
  if (topic.length > HUDDLE_TOPIC_MAX) return { ok: false };
  return { ok: true, topic };
}

/** The file's first bytes: the topic as the first heading, else nothing. */
export function huddleSeedMarkdown(topic?: string): string {
  return topic ? `# ${topic}\n` : '';
}

/**
 * Where the huddle's markdown lives. Under the data dir rather than in any
 * repo: a huddle has no project file to be bound to, and the doc IS the
 * record — the file is the write-back's target so the record survives the
 * `.ydoc`, same as every other bound doc. The id is server-minted
 * (`d-…`), so it is filename-safe by construction.
 */
export function huddleFilePath(dataDir: string, docId: string): string {
  return join(dataDir, 'huddles', `${docId}.md`);
}
