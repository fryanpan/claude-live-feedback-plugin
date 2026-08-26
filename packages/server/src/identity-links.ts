import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { linkIdentity } from './activity.ts';

/**
 * `<dataDir>/identity-links.json` — explicit "this actor id IS that identity"
 * links, read at server construction and at the top of a backfill run.
 *
 * WHY A FILE RATHER THAN LITERALS. The ids it maps are minted by browsers:
 * every new profile, private window, or cleared cookie jar produces another
 * `anon-*` id for the same person. Hardcoding them would mean a code change
 * and a release each time somebody opens a doc from a new device, which is
 * exactly the maintenance nobody performs — so the map lives beside the data
 * it describes, and adding an id is one line in a JSON file.
 *
 * It is NOT tracked in the repo: the real file names a person's session ids,
 * and this repo is public. The repo carries the mechanism and synthetic
 * fixtures; the deployment carries the seed.
 *
 * Two shapes are accepted, because the file is hand-edited:
 *
 *   { "links": { "anon-xxxxxx": "known-bryan" } }
 *   { "links": [ { "from": "anon-xxxxxx", "to": "known-bryan", "note": "…" } ] }
 *
 * The array form exists so an entry can carry a `note` saying which device or
 * month it came from — a bare id is unreviewable a year later.
 */
export const IDENTITY_LINKS_FILE = 'identity-links.json';

/** Where the link file lives inside a data dir. */
export function identityLinksPath(dataDir: string): string {
  return join(dataDir, IDENTITY_LINKS_FILE);
}

export interface LoadIdentityLinksResult {
  /** How many links were registered. */
  loaded: number;
  /**
   * Why fewer loaded than the file intended. Present ONLY on a real problem —
   * a missing file is the normal state and reports nothing. The caller is
   * expected to log this: a file that fails to parse and an absent one both
   * end with an empty map, and the whole point of the map is that its absence
   * is invisible downstream (an owner-activity view that reads a little low,
   * with nothing anywhere saying why).
   */
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Pull `{from, to}` pairs out of whichever shape the file used. Unusable
 * entries are dropped individually rather than failing the whole file — one
 * mistyped line should not silently un-link every other id in it.
 */
function pairsFrom(links: unknown): { pairs: Array<[string, string]>; badShape: boolean } {
  const pairs: Array<[string, string]> = [];
  if (Array.isArray(links)) {
    for (const entry of links) {
      if (!isRecord(entry)) continue;
      const { from, to } = entry;
      if (typeof from === 'string' && typeof to === 'string') pairs.push([from, to]);
    }
    return { pairs, badShape: false };
  }
  if (isRecord(links)) {
    for (const [from, to] of Object.entries(links)) {
      if (typeof to === 'string') pairs.push([from, to]);
    }
    return { pairs, badShape: false };
  }
  return { pairs, badShape: true };
}

/**
 * Read the link file and register everything in it. A missing file is normal
 * and yields `{ loaded: 0 }`; a broken one yields `{ loaded: 0, error }` and
 * never throws — this runs at boot, and an unreadable config file must not be
 * able to take the server down with it.
 */
export function loadIdentityLinks(dataDir: string): LoadIdentityLinksResult {
  const path = identityLinksPath(dataDir);
  if (!existsSync(path)) return { loaded: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return { loaded: 0, error: `${path}: unreadable (${(err as Error).message})` };
  }
  if (!isRecord(parsed)) {
    return { loaded: 0, error: `${path}: expected a JSON object` };
  }
  // A bare map at the top level is accepted too — it is what somebody writes
  // when they have not read the doc comment, and rejecting it would fail in
  // the silent direction.
  const links = 'links' in parsed ? parsed.links : parsed;
  const { pairs, badShape } = pairsFrom(links);
  if (badShape) {
    return { loaded: 0, error: `${path}: "links" must be an object map or an array of {from,to}` };
  }
  let loaded = 0;
  for (const [from, to] of pairs) {
    if (!from.trim() || !to.trim() || from.trim() === to.trim()) continue;
    linkIdentity(from, to);
    loaded++;
  }
  return { loaded };
}
