/**
 * Enrolling this browser, on this device, for review-item notifications.
 *
 * Enrolment is per (origin, device, browser profile) — there is no account
 * to attach it to — so this is called from a settings toggle the person
 * taps, never at page load. The permission prompt must happen inside that
 * gesture or the browser silently refuses it.
 *
 * Every capability is read defensively. Push is absent on more devices than
 * it is present: Safari before 16.4, any iOS tab that has not been added to
 * the Home Screen, and any plain-HTTP origin. The module's job in those
 * cases is to say which one it is, because "the toggle does nothing" is the
 * failure people actually report.
 */

/** Matches the server's `/api/push/key` response. */
interface KeyResponse {
  available: boolean;
  publicKey?: string;
  reason?: string;
}

export interface PushStatus {
  /** This browser has the APIs at all. */
  supported: boolean;
  /** The server has a key to subscribe against. False on an insecure origin. */
  available: boolean;
  permission: NotificationPermission | 'unsupported';
  /** This device currently holds a subscription. */
  enabled: boolean;
  /** Present when `available` is false — why the server cannot offer push. */
  reason?: string;
}

export interface PushAuthor {
  id: string;
  name: string;
}

/**
 * `PushManager.subscribe` wants the application server key as raw bytes.
 *
 * Handing it the base64url string works in Chrome and fails in Safari, and
 * the failure is a bare `AbortError` naming nothing — so this conversion is
 * where a wrong answer becomes an unexplainable one.
 */
export function applicationServerKeyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * The APIs all have to be there together; any one missing means no push.
 *
 * Tested with `in` rather than `typeof x === '...'` on purpose. `Notification`
 * and `PushManager` are constructors, so they are functions in a real browser
 * and are trivially made objects in a fake one — a `typeof` check can pass a
 * test suite and be false on every device that matters.
 */
function browserSupportsPush(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in globalThis &&
    'Notification' in globalThis
  );
}

function permissionNow(): NotificationPermission | 'unsupported' {
  const n = (globalThis as { Notification?: { permission?: NotificationPermission } }).Notification;
  return n?.permission ?? 'unsupported';
}

async function serverKey(): Promise<KeyResponse> {
  try {
    const res = await fetch('/api/push/key');
    if (!res.ok) return { available: false, reason: `server said ${res.status}` };
    return (await res.json()) as KeyResponse;
  } catch (err) {
    return { available: false, reason: (err as Error).message };
  }
}

/** The worker that will receive pushes. Root scope, because the deep links it
 *  opens span the whole site rather than one pane of it. */
async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!browserSupportsPush()) return null;
  try {
    return await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch {
    return null;
  }
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await registration();
  if (!reg?.pushManager) return null;
  try {
    return await reg.pushManager.getSubscription();
  } catch {
    return null;
  }
}

/** Everything the settings row needs to render itself. */
export async function readPushStatus(): Promise<PushStatus> {
  if (!browserSupportsPush()) {
    return { supported: false, available: false, permission: 'unsupported', enabled: false };
  }
  const key = await serverKey();
  const subscription = await currentSubscription();
  return {
    supported: true,
    available: key.available,
    permission: permissionNow(),
    // Permission and enrolment are two different things, and the gap between
    // them is real: a granted prompt with no subscription means the server
    // has no way to reach this device, which a permission-only check would
    // render as "on".
    enabled: subscription !== null,
    ...(key.reason ? { reason: key.reason } : {}),
  };
}

export interface EnableResult {
  ok: boolean;
  error?: string;
}

/**
 * Turn notifications on for this device. MUST be called from a user gesture.
 */
export async function enablePush(author: PushAuthor): Promise<EnableResult> {
  if (!browserSupportsPush()) {
    return { ok: false, error: 'This browser does not support push notifications.' };
  }
  const key = await serverKey();
  if (!key.available || !key.publicKey) {
    return { ok: false, error: key.reason ?? 'Push is not available on this server.' };
  }

  const notification = (
    globalThis as {
      Notification?: {
        permission: NotificationPermission;
        requestPermission(): Promise<NotificationPermission>;
      };
    }
  ).Notification;
  if (notification && notification.permission !== 'granted') {
    const granted = await notification.requestPermission();
    if (granted !== 'granted') {
      return { ok: false, error: `Notification permission was ${granted}.` };
    }
  }

  const reg = await registration();
  if (!reg?.pushManager) {
    return { ok: false, error: 'Could not register the notification worker.' };
  }

  let subscription: PushSubscription | null;
  try {
    // An existing subscription is REUSED rather than replaced. Subscribing
    // again with the same key returns the same endpoint anyway, and with a
    // different key it throws — so asking first is both cheaper and the only
    // way to survive a server whose VAPID key was regenerated.
    subscription = await reg.pushManager.getSubscription();
    if (!subscription) {
      subscription = await reg.pushManager.subscribe({
        // Required by every browser: a push that shows nothing is not allowed.
        userVisibleOnly: true,
        applicationServerKey: applicationServerKeyBytes(key.publicKey),
      });
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  try {
    const res = await fetch('/api/push/subscriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Re-posting an endpoint the server already holds is deliberate: it is
      // what revives a device that was soft-disabled by an earlier 410.
      body: JSON.stringify({ author, subscription: subscription.toJSON() }),
    });
    if (!res.ok) return { ok: false, error: `Server refused the subscription (${res.status}).` };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  return { ok: true };
}

/**
 * Turn notifications off for this device.
 *
 * Both halves matter and in this order: dropping the browser subscription
 * stops the push service delivering, and telling the server retires the row
 * so it stops trying. Telling the server alone would leave the browser
 * holding a live endpoint that a re-enable would silently reuse.
 */
export async function disablePush(): Promise<void> {
  const subscription = await currentSubscription();
  if (!subscription) return;
  const endpoint = subscription.endpoint;
  try {
    await subscription.unsubscribe();
  } catch {
    // The local drop failing does not excuse leaving the server sending.
  }
  try {
    await fetch('/api/push/subscriptions', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint }),
    });
  } catch {
    // Offline. The server keeps the row; the next enable re-posts it, and
    // a delivery to a dead endpoint retires it on the 410 anyway.
  }
}
