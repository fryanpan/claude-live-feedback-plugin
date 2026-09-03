/**
 * The service worker. Its whole job is the two halves of a push
 * notification: show one when the server sends it, and land the reader on
 * the right thing when they tap it.
 *
 * It exists because a notification has to arrive when no tab is open. The
 * in-page Notification API can only fire while the site is on screen, which
 * is precisely when the reviewer does not need telling — and on an iOS Home
 * Screen web app it is not available at all.
 *
 * Deliberately has no imports. A service worker is fetched, byte-compared and
 * re-evaluated by the browser on its own schedule; keeping it a single
 * self-contained file means an update to it is one file changing rather than
 * a chunk graph the browser has to re-fetch piecemeal.
 */

export {};

/** The pieces of the worker global this file touches. Declared locally
 *  because the project compiles against the DOM lib, where `self` is a
 *  Window — pulling in the webworker lib would change that for every other
 *  file in the program. */
interface WorkerClient {
  id: string;
  url: string;
  focus(): Promise<WorkerClient>;
  navigate?(url: string): Promise<WorkerClient | null>;
}
interface WorkerScope extends EventTarget {
  location: { origin: string };
  registration: {
    showNotification(title: string, options?: Record<string, unknown>): Promise<void>;
  };
  clients: {
    matchAll(options?: { type?: string; includeUncontrolled?: boolean }): Promise<WorkerClient[]>;
    openWindow(url: string): Promise<WorkerClient | null>;
    claim(): Promise<void>;
  };
  skipWaiting(): Promise<void>;
}
interface ExtendableEventLike extends Event {
  waitUntil(promise: Promise<unknown>): void;
}
interface PushEventLike extends ExtendableEventLike {
  data: { json(): unknown; text(): string } | null;
}
interface NotificationEventLike extends ExtendableEventLike {
  notification: { close(): void; data?: { url?: string } };
}

const worker = self as unknown as WorkerScope;

/** What the server sends. Kept structurally identical to `ReviewNotification`
 *  in `push-notify.ts` — one shape, written once on each side of the wire. */
interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
  timestamp: number;
}

/**
 * A push event MUST end in a visible notification.
 *
 * Browsers enforce this: a push handler that shows nothing gets the user
 * agent's own "this site was updated in the background" notice instead, and
 * repeated offences can cost the site its push permission. So a payload that
 * fails to parse still produces something a person can tap, rather than an
 * early return that looks like nothing happened.
 */
function readPayload(data: PushEventLike['data']): PushPayload {
  const fallback: PushPayload = {
    title: 'Something needs your review',
    body: 'Open Workspaces to see what came in.',
    url: '/',
    tag: 'review-unknown',
    timestamp: Date.now(),
  };
  if (!data) return fallback;
  try {
    const raw = data.json() as Partial<PushPayload> | null;
    if (!raw || typeof raw !== 'object') return fallback;
    return {
      title: typeof raw.title === 'string' && raw.title ? raw.title : fallback.title,
      body: typeof raw.body === 'string' ? raw.body : fallback.body,
      url: typeof raw.url === 'string' && raw.url ? raw.url : fallback.url,
      tag: typeof raw.tag === 'string' && raw.tag ? raw.tag : fallback.tag,
      timestamp: typeof raw.timestamp === 'number' ? raw.timestamp : fallback.timestamp,
    };
  } catch {
    return fallback;
  }
}

worker.addEventListener('install', (event) => {
  // Take over immediately rather than waiting for every tab to close. There
  // is no cached app shell here to version against, so the usual reason to
  // wait does not apply, and waiting would leave a just-enabled subscription
  // being handled by a worker that does not know about it yet.
  (event as ExtendableEventLike).waitUntil(worker.skipWaiting());
});

worker.addEventListener('activate', (event) => {
  (event as ExtendableEventLike).waitUntil(worker.clients.claim());
});

worker.addEventListener('push', (event) => {
  const e = event as PushEventLike;
  const payload = readPayload(e.data);
  e.waitUntil(
    worker.registration.showNotification(payload.title, {
      body: payload.body,
      // Per review item, so two different asks stack as two notifications
      // while a resend of the same one replaces rather than duplicates.
      tag: payload.tag,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      timestamp: payload.timestamp,
      // The click handler reads the target from here. It cannot re-derive it:
      // by the time the tap arrives the push event is long gone.
      data: { url: payload.url },
    }),
  );
});

/**
 * Land on the review item.
 *
 * Prefers an already-open tab on this origin — focus and navigate it —
 * because opening a second copy of the board is how a reviewer ends up with
 * six tabs of the same workspace after a busy morning. `navigate` is absent
 * on some clients (notably an iOS Home Screen web app), so a focus that
 * cannot be redirected still beats a new window.
 */
async function openTarget(url: string): Promise<void> {
  const target = new URL(url, worker.location.origin);
  const windows = await worker.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of windows) {
    let sameOrigin: boolean;
    try {
      sameOrigin = new URL(client.url).origin === target.origin;
    } catch {
      continue;
    }
    if (!sameOrigin) continue;
    await client.focus();
    if (client.url !== target.href && typeof client.navigate === 'function') {
      await client.navigate(target.href);
    }
    return;
  }
  await worker.clients.openWindow(target.href);
}

worker.addEventListener('notificationclick', (event) => {
  const e = event as NotificationEventLike;
  // Dismiss first: on some platforms the notification outlives the handler
  // and sits on the lock screen after the app has already opened.
  e.notification.close();
  const url = e.notification.data?.url ?? '/';
  e.waitUntil(openTarget(url));
});
