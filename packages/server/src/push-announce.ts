/**
 * Browser push for "a review item just landed": the subscription store, the
 * VAPID identity behind it, and the one announcement the rest of the server
 * makes.
 *
 * `announceReviewItem` is the seam. It is deliberately fire-and-forget and
 * deliberately silent without a link — the review item is already durable by
 * the time this runs, so making a route's 200 wait on several third-party
 * push services would trade the durable thing for the announcement of it,
 * and a notification the reader cannot click on is not worth sending.
 *
 * WHEN it may be called is not this module's rule: an item that the quality
 * gate held must not be announced, and `review-gate.ts` owns that ordering.
 *
 * Lifted verbatim out of `createServer`; collaborators arrive in a context
 * rather than being captured from that closure.
 */
import { type PushFetch, PushNotifier, reviewItemNotification } from './push-notify.ts';
import { PushStore, loadOrCreateVapidKeys } from './push-store.ts';

/** What the push half reads instead of `createServer`'s closure. */
export interface PushAnnounceContext {
  /** The data dir — the subscription file and the VAPID keys live under it. */
  dataDir: string;
  /** This server's externally reachable origin. The RFC 8292 `sub` claim is
   *  derived from it, and a plain-HTTP one disables the feature. */
  externalBaseUrl: () => string;
  /** The one `ServerOptions` field this module reads. Structural on purpose:
   *  naming `ServerOptions` would import a type out of server.ts, which
   *  imports this module back. */
  opts: { pushFetch?: PushFetch };
}

/** Build the push half once per server. */
export function createPushAnnounce(ctx: PushAnnounceContext): {
  pushStore: PushStore;
  pushNotifier: () => Promise<PushNotifier | null>;
  announceReviewItem: (input: {
    ask: string;
    context: string;
    askedBy: string;
    url: string | undefined;
    key: string;
  }) => void;
} {
  const { dataDir, externalBaseUrl, opts } = ctx;
  // --- Push notifications ---------------------------------------------
  //
  // Devices enrolled for "a review item just landed". The store is cheap and
  // synchronous; the VAPID identity is not (it may have to mint a keypair),
  // so the notifier is built once, lazily, behind a cached promise. Building
  // it eagerly would make `createServer` async for a feature nobody has
  // necessarily turned on.
  const pushStore = new PushStore({ dataDir });
  if (pushStore.loadError) {
    console.error(`[push] ${pushStore.loadError}`);
  }
  let pushNotifierPromise: Promise<PushNotifier | null> | null = null;

  /**
   * The RFC 8292 `sub` claim: who a push service should contact about this
   * sender. This server's own origin is the standard non-email answer.
   *
   * Returns undefined on a plain-HTTP origin, and that disables the whole
   * feature rather than papering over it — a service worker cannot register
   * outside a secure context, so there is nothing on the other end to deliver
   * to. Prod sets CW_PUBLIC_BASE_URL to the HTTPS tailnet name for exactly
   * the reason `public-host.ts` gives about the microphone; the same override
   * is what makes push reachable.
   */
  function pushSubject(): string | undefined {
    const override = process.env.CW_PUSH_SUBJECT?.trim();
    if (override) return override;
    const base = externalBaseUrl();
    return base.startsWith('https://') ? base : undefined;
  }

  function pushNotifier(): Promise<PushNotifier | null> {
    pushNotifierPromise ??= (async () => {
      const subject = pushSubject();
      if (!subject) return null;
      try {
        return new PushNotifier({
          store: pushStore,
          keys: await loadOrCreateVapidKeys(dataDir),
          subject,
          log: (message) => console.error(`[push] ${message}`),
          ...(opts.pushFetch ? { fetch: opts.pushFetch } : {}),
        });
      } catch (err) {
        // A corrupt or unreadable key file. Say so once; the feature stays
        // off rather than re-minting and invalidating every enrolled device.
        console.error(`[push] disabled: ${(err as Error).message}`);
        return null;
      }
    })();
    return pushNotifierPromise;
  }

  /**
   * Announce a review item to every enrolled device.
   *
   * Deliberately fire-and-forget. The review item is already written by the
   * time this runs, and the caller is a route about to answer 200; making
   * that response wait on several third-party push services — or fail
   * because one of them is down — would trade the durable thing for the
   * announcement of it.
   */
  function announceReviewItem(input: {
    ask: string;
    context: string;
    askedBy: string;
    url: string | undefined;
    key: string;
  }): void {
    // No link, nothing to click. Criterion 2 of this feature is the click
    // landing on the item, so a notification without one is not worth sending.
    if (!input.url) return;
    void (async () => {
      try {
        const notifier = await pushNotifier();
        if (!notifier) return;
        await notifier.send(
          reviewItemNotification({ ...input, url: input.url as string, now: Date.now() }),
        );
      } catch (err) {
        console.error(`[push] announce failed: ${(err as Error).message}`);
      }
    })();
  }

  return { pushStore, pushNotifier, announceReviewItem };
}
