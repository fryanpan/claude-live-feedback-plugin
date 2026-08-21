/**
 * Delivering a review item to whatever device the reviewer is holding.
 *
 * Two halves that fail differently, kept apart for that reason. Shaping the
 * notification is pure and exact — it decides what a person reads on a lock
 * screen with no other context. Delivery is a conversation with a push
 * service that can refuse in several ways, and the ways mean different
 * things: `410 Gone` retires a device forever, `429` is the service having a
 * bad minute, and treating the second as the first quietly unenrolls a
 * working phone.
 *
 * Nothing here throws at its caller. A review item is the durable thing and
 * the notification is a courtesy; a push outage that failed the create would
 * lose the actual work to protect the announcement of it.
 */

import { b64urlDecode, encryptPushPayload, vapidAuthorization } from './push-crypto.ts';
import type { VapidKeys } from './push-crypto.ts';
import type { PushStore, StoredSubscription } from './push-store.ts';

/**
 * How long a push service should hold an undelivered message. A review item
 * is worth waking up to a few hours late — the reviewer's phone is often
 * asleep — but a day-old "someone needs you" is noise by the time it lands.
 */
export const PUSH_TTL_SECONDS = 4 * 60 * 60;

/** Leaves the title readable while keeping the whole record inside one
 *  4096-byte AES-GCM frame even when both fields arrive at their maximum. */
const TITLE_MAX = 120;
const BODY_MAX = 200;

export interface ReviewNotification {
  title: string;
  body: string;
  /** Where the click lands. Absolute, so the service worker can just open it. */
  url: string;
  /** Replaces an earlier notification about the same item instead of stacking. */
  tag: string;
  timestamp: number;
}

function clip(text: string, max: number): string {
  const s = text.trim().replace(/\s+/g, ' ');
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

export interface ReviewNotificationInput {
  /** The question itself — the review item's headline, or the comment's ask. */
  ask: string;
  /** What it is about: the ticket's title, or the document's label. */
  context: string;
  askedBy: string;
  url: string;
  /** Stable per item, so a resend replaces. `taskId:reviewItemId` or `docId:threadId`. */
  key: string;
  now?: number;
}

/**
 * Shape one review item into the thing a person sees.
 *
 * The QUESTION is the title. A notification is read at a glance on a lock
 * screen, and leading with the container ("Review item notifications") spends
 * that glance on the folder rather than the decision — the reviewer still has
 * to open the app to find out what is being asked. Who asked and what it is
 * about go in the body, where there is room for them.
 */
export function reviewItemNotification(input: ReviewNotificationInput): ReviewNotification {
  const ask = clip(input.ask, TITLE_MAX);
  const context = clip(input.context, BODY_MAX);
  const by = clip(input.askedBy, 60);
  return {
    // An empty ask is possible (a declaration whose headline did not survive
    // a projection); a notification titled "" is unreadable, so say something.
    title: ask || 'Something needs your review',
    body: by ? `${context} — from ${by}` : context,
    url: input.url,
    tag: input.key,
    timestamp: input.now ?? Date.now(),
  };
}

export interface PushSendResult {
  sent: number;
  failed: number;
  /** Devices retired by this send because the service said the endpoint is gone. */
  disabled: number;
}

/**
 * Only the call shape this module makes.
 *
 * `typeof fetch` would drag in the Request-object and Bun-specific overloads
 * that nothing here uses, and a test stub then cannot be written without a
 * cast — which is a cast standing between the test and the contract it means
 * to pin.
 */
export type PushFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: Uint8Array<ArrayBuffer> },
) => Promise<Response>;

export interface PushNotifierOptions {
  store: PushStore;
  keys: VapidKeys;
  /** RFC 8292 `sub` — who a push service should contact about this sender. */
  subject: string;
  fetch?: PushFetch;
  now?: () => number;
  log?: (message: string) => void;
}

/** The endpoint is permanently unroutable — the browser dropped it, or the
 *  user cleared site data. Any other status is the service, not the device. */
const GONE = new Set([404, 410]);
const DELIVERED = new Set([200, 201, 202]);

export class PushNotifier {
  private readonly store: PushStore;
  private readonly keys: VapidKeys;
  private readonly subject: string;
  private readonly fetchImpl: PushFetch;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(opts: PushNotifierOptions) {
    this.store = opts.store;
    this.keys = opts.keys;
    this.subject = opts.subject;
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
  }

  /** The key the browser needs to subscribe against this server. */
  publicKey(): string {
    return this.keys.publicKey;
  }

  /**
   * Deliver to every enrolled device. Fans out in parallel — one slow push
   * service must not hold up the others, and there are only ever a handful.
   */
  async send(notification: ReviewNotification): Promise<PushSendResult> {
    const targets = this.store.active();
    const result: PushSendResult = { sent: 0, failed: 0, disabled: 0 };
    if (targets.length === 0) return result;

    const payload = new TextEncoder().encode(JSON.stringify(notification));
    const outcomes = await Promise.all(targets.map((t) => this.deliver(t, payload)));
    for (const outcome of outcomes) result[outcome]++;
    return result;
  }

  private async deliver(
    target: StoredSubscription,
    payload: Uint8Array,
  ): Promise<'sent' | 'failed' | 'disabled'> {
    try {
      const body = await encryptPushPayload({
        plaintext: payload,
        uaPublic: b64urlDecode(target.keys.p256dh),
        authSecret: b64urlDecode(target.keys.auth),
      });
      const authorization = await vapidAuthorization({
        // Per device: the token's audience is the push SERVICE, and two
        // browsers on the same account are two different services.
        endpoint: target.endpoint,
        keys: this.keys,
        subject: this.subject,
        now: this.now(),
      });

      const res = await this.fetchImpl(target.endpoint, {
        method: 'POST',
        headers: {
          Authorization: authorization,
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          TTL: String(PUSH_TTL_SECONDS),
          Urgency: 'normal',
        },
        body,
      });

      if (DELIVERED.has(res.status)) return 'sent';
      if (GONE.has(res.status)) {
        this.store.disable(target.endpoint, `push service returned ${res.status}`);
        return 'disabled';
      }
      // Everything else — 429, 5xx, an unexpected 4xx — is the service's
      // problem or ours, not the device's. Keep the subscription.
      this.log(`push to ${host(target.endpoint)} failed: HTTP ${res.status}`);
      return 'failed';
    } catch (err) {
      // A throw is a network fault or a malformed stored key. Neither is the
      // push service telling us the device is gone, so nothing is retired.
      this.log(`push to ${host(target.endpoint)} threw: ${(err as Error).message}`);
      return 'failed';
    }
  }
}

/** The endpoint's origin — safe to log. The path is a bearer capability. */
function host(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return 'unknown';
  }
}
