/**
 * "This tab is running an older build."
 *
 * A prod restart is the browser deploy (docs/process/delivery.md), and an
 * already-open tab keeps running whatever it loaded — so a fix can be merged,
 * deployed and verified while the person reporting the bug still sees the old
 * behaviour. That failure is silent on both ends: nothing in the tab knows,
 * and nothing on the server can tell it.
 *
 * The check rides the reconnect the websocket already performs when the server
 * restarts. No poll, no timer: an idle tab does nothing at all, and a tab that
 * reconnects asks one question — "what build are you serving now?" — and only
 * speaks up if the answer differs from the build it is running.
 */
import type { ConnectionStatus } from '@feedback/core';

/**
 * Stamped into the bundle at build time (see packages/markdown-app/scripts/
 * build.ts). Empty in an unbuilt/dev context, which disarms the check — a
 * `bun dev` tab has no release to be stale against.
 */
declare const __LF_BUILD_ID__: string | undefined;
export const BUILD_ID: string = typeof __LF_BUILD_ID__ === 'string' ? __LF_BUILD_ID__ : '';

/** Where the server exposes the running release's id. */
export const BUILD_INFO_URL = '/app/BUILD_INFO.txt';

/**
 * Reads the id out of `built <iso>` — the one line the build script writes.
 *
 * Returns null for everything else on purpose. The caller turns "a different
 * id" into a banner, so an unrecognised body (a 404 page, an SPA fallback,
 * a truncated read) must mean "I could not tell", never a guess.
 */
export function parseBuildId(text: string): string | null {
  const line = text.split('\n', 1)[0]?.trim() ?? '';
  const m = /^built\s+(\S+)$/.exec(line);
  return m ? m[1] : null;
}

export interface StaleWatchOptions {
  /** The build this tab is running. Empty disarms the whole check. */
  buildId: string;
  /** ws-client's subscribe: fires on transitions AND once with the current status. */
  onStatus: (cb: (s: ConnectionStatus) => void) => void;
  /** Fetches the served BUILD_INFO body. */
  fetchBuildInfo: () => Promise<string>;
  /** Called at most once, when the served build differs from ours. */
  onStale: () => void;
}

export function watchForStaleClient(opts: StaleWatchOptions): void {
  const { buildId, onStatus, fetchBuildInfo, onStale } = opts;
  if (!buildId) return;

  // The subscribe fires immediately with the current status, and a tab that
  // has only ever been connected has not reconnected. Only a drop arms the
  // probe — otherwise mounting a second surface would check on every mount.
  let armed = false;
  let done = false;
  let inFlight = false;

  onStatus((s) => {
    if (done) return;
    if (s !== 'open') {
      armed = true;
      return;
    }
    if (!armed || inFlight) return;
    armed = false;
    inFlight = true;
    void fetchBuildInfo()
      .then((text) => {
        const served = parseBuildId(text);
        // Unreadable answer: stay silent and stay armed. A server mid-restart
        // can serve anything; the next reconnect asks again.
        if (served === null) {
          armed = true;
          return;
        }
        if (served === buildId) return;
        done = true;
        onStale();
      })
      .catch(() => {
        armed = true;
      })
      .finally(() => {
        inFlight = false;
      });
  });
}

/**
 * One unobtrusive line, with a reload and a dismiss. Idempotent: a second call
 * is a no-op, so nothing can stack banners.
 */
export function showStaleNotice(doc: Document, reload: () => void): void {
  if (doc.querySelector('.stale-client')) return;
  const bar = doc.createElement('div');
  bar.className = 'stale-client';
  bar.setAttribute('role', 'status');

  const text = doc.createElement('span');
  text.className = 'stale-client__text';
  text.textContent = 'New version available';

  const reloadBtn = doc.createElement('button');
  reloadBtn.type = 'button';
  reloadBtn.className = 'stale-client__reload';
  reloadBtn.textContent = 'Reload';
  reloadBtn.addEventListener('click', () => reload());

  const dismiss = doc.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'stale-client__dismiss';
  dismiss.setAttribute('aria-label', 'Dismiss');
  dismiss.textContent = '✕';
  dismiss.addEventListener('click', () => bar.remove());

  bar.append(text, reloadBtn, dismiss);
  doc.body.append(bar);
}

/**
 * The wiring both surfaces use: reconnect → probe → notice.
 *
 * Called per connection, because a client's status callbacks die with the
 * client — the review surface makes a new one on every navigation, so a
 * single install at startup would stop watching the moment Bryan opened a
 * second doc. `announced` keeps that from turning into repeat probing.
 */
let announced = false;
export function installStaleClientNotice(client: {
  onStatus: (cb: (s: ConnectionStatus) => void) => void;
}): void {
  if (announced) return;
  watchForStaleClient({
    buildId: BUILD_ID,
    onStatus: (cb) => client.onStatus(cb),
    fetchBuildInfo: async () => {
      const res = await fetch(BUILD_INFO_URL, { cache: 'no-store' });
      if (!res.ok) throw new Error(`BUILD_INFO ${res.status}`);
      return await res.text();
    },
    onStale: () => {
      announced = true;
      showStaleNotice(document, () => window.location.reload());
    },
  });
}
