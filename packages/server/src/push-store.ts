/**
 * Where push state lives: the server's VAPID identity and the set of
 * subscriptions to deliver to.
 *
 * Both files sit under the runtime data dir and both are mode 600. The VAPID
 * private key is the obvious secret; the subscription file is the less
 * obvious one, and it is not less sensitive — an endpoint plus its auth
 * secret is a standing capability to put arbitrary text on the owner's lock
 * screen. `data/` is gitignored, which is what keeps either of them out of
 * this public repo.
 *
 * Removal is soft, per the project rule. A row that unsubscribes or whose
 * endpoint the push service has retired keeps its record with `disabledAt`
 * set: the question "which of my devices did I ever turn this on for" stays
 * answerable, and re-subscribing the same endpoint revives the row rather
 * than minting a second one.
 */

import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type VapidKeys, generateVapidKeys, importVapidKeys } from './push-crypto.ts';

export const VAPID_FILENAME = 'push-vapid.json';
export const SUBSCRIPTIONS_FILENAME = 'push-subscriptions.json';
const FORMAT_VERSION = 1;
/** Owner read/write only. Both files. */
const SECRET_MODE = 0o600;

/**
 * The server's push identity, minted once and then never again.
 *
 * Never re-mint on a bad read. A browser binds its subscription to the public
 * key it was given at subscribe time, so a fresh keypair silently invalidates
 * every subscription in the field — and it fails as a push-service rejection
 * on a device the operator is not holding, which is the least visible place a
 * failure could land. A corrupt file is therefore an error to surface, not a
 * state to recover from by guessing.
 */
export async function loadOrCreateVapidKeys(dataDir: string): Promise<VapidKeys> {
  const path = join(dataDir, VAPID_FILENAME);
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<VapidKeys>;
    if (typeof parsed?.publicKey !== 'string' || typeof parsed?.privateKey !== 'string') {
      throw new Error(`${path} is missing publicKey/privateKey`);
    }
    const keys = { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
    // Prove the pair is usable now, while the operator can still read the
    // error, rather than at send time as an opaque 401 from a push service.
    await importVapidKeys(keys);
    return keys;
  }
  const keys = await generateVapidKeys();
  writeFileSync(path, `${JSON.stringify(keys, null, 2)}\n`, { mode: SECRET_MODE });
  chmodSync(path, SECRET_MODE);
  return keys;
}

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface StoredSubscription extends PushSubscriptionInput {
  /** Who this device belongs to, as the hub knows them. */
  userId: string;
  userName: string;
  createdAt: number;
  updatedAt: number;
  /** Set means soft-deleted: out of the active set, still on the record. */
  disabledAt?: number;
  disabledReason?: string;
}

interface FileShape {
  version: number;
  subscriptions: Record<string, StoredSubscription>;
}

export interface PushStoreOptions {
  dataDir: string;
  now?: () => number;
}

/**
 * Validate before storing rather than before sending. A row that cannot be a
 * real subscription should be refused at the door with a message the caller
 * can act on, not persisted and then skipped on every send forever.
 */
function checkSubscription(input: PushSubscriptionInput): void {
  let url: URL;
  try {
    url = new URL(input?.endpoint ?? '');
  } catch {
    throw new Error('push subscription endpoint is not a URL');
  }
  // The server will POST here on its own initiative. Anything but https is
  // either a downgrade or a way to aim the server at a non-push scheme.
  if (url.protocol !== 'https:') {
    throw new Error('push subscription endpoint must be https');
  }
  if (!input.keys?.p256dh || !input.keys?.auth) {
    throw new Error('push subscription is missing keys.p256dh / keys.auth');
  }
}

function readRow(value: unknown, fallbackNow: number): StoredSubscription | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  const keys = r.keys as Record<string, unknown> | undefined;
  if (typeof r.endpoint !== 'string' || !keys || typeof keys !== 'object') return null;
  if (typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') return null;
  return {
    endpoint: r.endpoint,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
    userId: typeof r.userId === 'string' ? r.userId : '',
    userName: typeof r.userName === 'string' ? r.userName : '',
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : fallbackNow,
    updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : fallbackNow,
    ...(typeof r.disabledAt === 'number' ? { disabledAt: r.disabledAt } : {}),
    ...(typeof r.disabledReason === 'string' ? { disabledReason: r.disabledReason } : {}),
  };
}

export class PushStore {
  private readonly path: string;
  private readonly now: () => number;
  private state: FileShape;
  /** Set when the file on disk was unreadable and was moved aside. */
  readonly loadError: string | null = null;

  constructor(opts: PushStoreOptions) {
    this.path = join(opts.dataDir, SUBSCRIPTIONS_FILENAME);
    this.now = opts.now ?? Date.now;
    this.state = { version: FORMAT_VERSION, subscriptions: {} };
    if (!existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<FileShape>;
      if (!parsed || typeof parsed !== 'object' || typeof parsed.subscriptions !== 'object') {
        throw new Error('missing "subscriptions" object');
      }
      // One bad row must not cost the other devices their subscriptions —
      // whole-file strictness here would take the whole set out over a single
      // hand-edit. A row that cannot be read is dropped and the rest load.
      for (const [endpoint, raw] of Object.entries(parsed.subscriptions ?? {})) {
        const row = readRow(raw, this.now());
        if (row) this.state.subscriptions[endpoint] = row;
      }
    } catch (err) {
      const aside = `${this.path}.corrupt-${this.now()}`;
      try {
        renameSync(this.path, aside);
      } catch {
        // Nothing better is available; loadError still names the problem.
      }
      this.state = { version: FORMAT_VERSION, subscriptions: {} };
      this.loadError = `${(err as Error).message} (moved aside to ${aside})`;
    }
  }

  /** Every subscription that should receive the next notification. */
  active(): StoredSubscription[] {
    return Object.values(this.state.subscriptions).filter((s) => s.disabledAt === undefined);
  }

  /** Including the soft-deleted — for a settings surface that wants history. */
  all(): StoredSubscription[] {
    return Object.values(this.state.subscriptions);
  }

  get(endpoint: string): StoredSubscription | undefined {
    return this.state.subscriptions[endpoint];
  }

  /**
   * Register a device, or update the one already registered at this endpoint.
   *
   * The endpoint IS the identity: the browser mints one per (origin, device)
   * and hands back the same string until it rotates. Keying on anything else
   * accumulates a row per page load.
   */
  save(
    input: PushSubscriptionInput,
    who: { userId: string; userName: string },
  ): StoredSubscription {
    checkSubscription(input);
    const ts = this.now();
    const existing = this.state.subscriptions[input.endpoint];
    const row: StoredSubscription = {
      endpoint: input.endpoint,
      keys: { p256dh: input.keys.p256dh, auth: input.keys.auth },
      userId: who.userId,
      userName: who.userName,
      createdAt: existing?.createdAt ?? ts,
      updatedAt: ts,
    };
    // Re-subscribing is how a device comes BACK — clearing the disabled marks
    // is the revival, and keeping createdAt is what makes it the same device
    // rather than a new one.
    this.state.subscriptions[input.endpoint] = row;
    this.persist();
    return row;
  }

  /**
   * Soft delete. Called when the owner turns notifications off, and when a
   * push service reports the endpoint gone (404/410).
   */
  disable(endpoint: string, reason: string): void {
    const existing = this.state.subscriptions[endpoint];
    if (!existing || existing.disabledAt !== undefined) return;
    existing.disabledAt = this.now();
    existing.disabledReason = reason;
    existing.updatedAt = existing.disabledAt;
    this.persist();
  }

  private persist(): void {
    writeFileSync(this.path, `${JSON.stringify(this.state, null, 2)}\n`, { mode: SECRET_MODE });
    // `mode` on writeFileSync applies at CREATE only; an existing file keeps
    // whatever mode it had, so a file created before this rule stays loose
    // without the explicit chmod.
    chmodSync(this.path, SECRET_MODE);
  }
}
