/**
 * The build id an open tab compares itself against (see stale-client.ts).
 *
 * It is derived from the bytes actually served, not from the clock. Prod
 * rebuilds the client on every restart — so a timestamp id changes when
 * nothing changed, and every plain restart would tell every open tab a new
 * version is available. That is the nag the notice exists to avoid.
 *
 * Content-derived, the property comes out right in both directions: a restart
 * that rebuilds identical bytes is silent, and any change to any served asset
 * — bundle, stylesheet, html shell — moves the id.
 */
import { createHash } from 'node:crypto';

export interface BuildAsset {
  /** Stable name, so reordering the inputs can't change the id. */
  name: string;
  bytes: Uint8Array | string;
}

export function computeBuildId(assets: BuildAsset[]): string {
  const h = createHash('sha256');
  // Sort by name and length-prefix each part: without this, ('ab','c') and
  // ('a','bc') would hash identically.
  for (const a of [...assets].sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))) {
    const bytes = typeof a.bytes === 'string' ? Buffer.from(a.bytes, 'utf8') : Buffer.from(a.bytes);
    h.update(`${a.name}:${bytes.length}:`);
    h.update(bytes);
  }
  return h.digest('hex').slice(0, 16);
}
