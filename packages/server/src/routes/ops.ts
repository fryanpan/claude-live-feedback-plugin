import type { User } from '@feedback/core';
/**
 * The operator block: metrics, plugin refresh, push subscriptions and
 * deploy, in the order it is matched.
 *
 * These are the routes a person runs the machine with rather than the ones a
 * document or a board is made of, which is why they are one family: each
 * reads or moves something about the PROCESS — how long it has been up, what
 * bundle the plugin cache holds, which browsers get woken, and which commit
 * is serving. They were written as one if-chain inside `createServer` and the
 * sequence was kept exactly through the move.
 *
 * TWO entry points because the block sits in two places. `/api/metrics` runs
 * high in the chain, above the doc routes; everything else runs far below,
 * between the chat-audit routes and the agent attachments. Each is called
 * from the position its routes occupied.
 *
 * There is no `/api/uptime` and no `/api/release`: uptime is a field on the
 * metrics reply and the release is a field on `GET /api/deploy`, which is
 * where the deploy's own verification verdict is read back.
 *
 * The deploy POST is loopback-only, and that check reads the SOCKET address
 * through `requestAddress` rather than any header — a deploy restarts the
 * server and drops every live editor, so the caller has to be on the box.
 *
 * Dependencies arrive in an explicit context rather than captured from the
 * `createServer` closure, following `task-routes-context.ts`.
 */
import type { Deployer } from '../deploy.ts';
import { isLoopbackAddress } from '../middleware/host-guard.ts';
import type { ShareTarget } from '../middleware/host-guard.ts';
import { browserCannotOperateBody, isBrowserRequest } from '../middleware/write-gate.ts';
import type { PluginRefresher } from '../plugin-refresh.ts';
import type { PushNotifier } from '../push-notify.ts';
import type { PushStore } from '../push-store.ts';
import type { Rooms } from '../rooms.ts';

/** The long-lived collaborators these routes need, built once per server. */
export interface OpsRoutesContext {
  /** Doc rooms — read for the binding and activation stats metrics serves. */
  rooms: Rooms;
  /** The plugin-cache refresher, or null when none was injected. */
  pluginRefresher: PluginRefresher | null;
  /** The deployer, or null when none was injected. A null one is the reason
   *  an embedded server cannot be made to restart anything. */
  deployer: Deployer | null;
  /** Browser push subscriptions. */
  pushStore: PushStore;
  /** The push sender, built lazily because it needs the VAPID keys. */
  pushNotifier: () => Promise<PushNotifier | null>;

  /** JSON response helper — status plus body, no CORS (the per-request
   *  wrapper in createServer adds that, because it knows the Origin). */
  j: (status: number, body: unknown) => Response;
  /** Parse a request body, answering null rather than throwing. */
  safeJson: (req: Request) => Promise<Record<string, unknown> | null>;
  /** The request's SOCKET address — not a header, which is the whole point
   *  of the deploy route's loopback check. */
  requestAddress: (req: Request) => string | undefined;
}

/** What only this request knows. */
export interface OpsRouteRequest {
  req: Request;
  pathname: string;
  /** The share target this request resolved to, or null for a member. */
  visitor: ShareTarget | null;
  /** The author this request is allowed to claim. */
  authorFor: (claimed: unknown) => User | undefined;
}

/** `GET /api/metrics` — room stats plus this process's uptime. It runs high
 *  in the chain, above the doc routes, where it always has. */
export function handleOpsMetricsRoute(
  ctx: OpsRoutesContext,
  rq: OpsRouteRequest,
): Response | undefined {
  const { rooms, j } = ctx;
  const { pathname, req, visitor } = rq;

  if (pathname === '/api/metrics' && req.method === 'GET') {
    if (visitor) return j(403, { error: 'not available to share visitors' });
    const stats = rooms.stats();
    return j(200, { ...stats, uptimeSec: Math.round(process.uptime()) });
  }
  return undefined;
}

/**
 * Plugin refresh, push subscriptions and deploy, tried in source order.
 * `undefined` means none of them matched and the caller's chain continues.
 */
export async function handleOpsRoutes(
  ctx: OpsRoutesContext,
  rq: OpsRouteRequest,
): Promise<Response | undefined> {
  const { pluginRefresher, deployer, pushStore, pushNotifier, j, safeJson, requestAddress } = ctx;
  const { req, pathname, visitor, authorFor } = rq;

  // --- REST: plugin refresh ---
  // The other half of the drift signal: any peer that can read who is
  // behind can also ask the machine to fetch the new bundle. Safe to
  // expose to everyone in the workspace because it cannot interrupt
  // anyone — it rewrites a version-keyed cache, and a running session
  // keeps loading the path it resolved at launch. Peers take the new
  // version at their own next restart.
  if (pathname === '/api/plugin/refresh') {
    // Unreachable today — `shareScopeAllows` is an allowlist and this
    // path is not on it, so a share host is refused before any route
    // runs (host-guard.test.ts pins that). Kept, and kept AHEAD of the
    // capability check, so that allowlisting this path later cannot
    // silently open a deploy step to external reviewers, and so an
    // unconfigured deployment never answers a visitor with what it
    // would have done.
    if (visitor) return j(403, { error: 'not available to share visitors' });
    if (!pluginRefresher) {
      return j(501, {
        error:
          'plugin refresh not enabled on this server (dev and staging deliberately cannot spawn an update)',
      });
    }
    if (req.method === 'GET') return j(200, { refresh: pluginRefresher.last() });
    if (req.method === 'POST') {
      // Never through the edge. The host guard admits the operator's
      // own proxied hostname with an Access token, and cloudflared
      // runs on this box, so a tunnelled request has a loopback peer
      // address — neither the host class nor the address says "not
      // from here". `cf-ray` does: Cloudflare stamps it on everything
      // it proxies and strips any the client sent, which is the test
      // the host guard already trusts. (Urgent-fixes ticket,
      // 2026-09-02.)
      if (req.headers.has('cf-ray')) {
        return j(403, {
          error:
            'plugin refresh cannot be triggered through the edge (proxied request) — run it from the box or the tailnet',
        });
      }
      // And not from a PAGE on this machine either — see
      // browserCannotOperateBody. Nothing above distinguishes a page
      // from an agent: the origin policy admits any machine-local
      // hostname on any port, and a local dev origin is same-site with
      // this server, so a session cookie rides along.
      if (isBrowserRequest(req.headers)) return j(403, browserCannotOperateBody());
      return j(200, { refresh: await pluginRefresher.refresh() });
    }
    return j(405, { error: 'method not allowed' });
  }
  // --- REST: deploy this server ---
  // Pull the deploy source and restart, as one operation. There is no
  // "just restart" verb here or anywhere below it: a restart re-runs
  // the supervisor out of the deploy source, so over an unpulled
  // checkout it rebuilds the same bundles, republishes the same client,
  // and prints a successful deploy. See deploy.ts.
  //
  // --- Push notifications ---
  //
  // Three verbs: what key to subscribe against, enrol a device, retire
  // one. Enrolment is per browser-per-device, so the hub calls these
  // from a settings toggle rather than at page load.
  if (pathname === '/api/push/key' && req.method === 'GET') {
    const notifier = await pushNotifier();
    return notifier
      ? j(200, { available: true, publicKey: notifier.publicKey() })
      : // Named rather than a bare false, because "why is the toggle
        // greyed out" has exactly one answer worth giving: this origin
        // is not one a service worker can register on.
        j(200, { available: false, reason: 'insecure-origin' });
  }
  if (pathname === '/api/push/subscriptions' && req.method === 'POST') {
    const body = await safeJson(req);
    const user = authorFor(body?.author);
    if (!user) return j(400, { error: 'author required' });
    const subscription = body?.subscription as
      | { endpoint?: string; keys?: { p256dh?: string; auth?: string } }
      | undefined;
    if (!subscription?.endpoint || !subscription.keys?.p256dh || !subscription.keys.auth) {
      return j(400, {
        error: 'subscription with endpoint + keys.p256dh + keys.auth required',
      });
    }
    try {
      pushStore.save(
        {
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
        },
        { userId: user.id, userName: user.name },
      );
    } catch (err) {
      return j(400, { error: (err as Error).message });
    }
    return j(200, { ok: true });
  }
  if (pathname === '/api/push/subscriptions' && req.method === 'DELETE') {
    const body = await safeJson(req);
    const endpoint = body?.endpoint as string | undefined;
    if (!endpoint) return j(400, { error: 'endpoint required' });
    // Soft, per the project rule — the row stays with `disabledAt` set,
    // and re-enabling on this device revives it rather than duplicating.
    pushStore.disable(endpoint, 'unsubscribed');
    return j(200, { ok: true });
  }

  // Unlike the refresh above, this one DOES interrupt: it ends this
  // process a moment after answering. That is why the response is sent
  // before the restart fires and why the result is written to disk —
  // the reporter does not survive to be asked again.
  if (pathname === '/api/deploy') {
    // Same shape and same reasoning as the refresh route's check: a
    // share host never reaches here (`shareScopeAllows` is a
    // closed-by-default allowlist that runs first, pinned by
    // host-guard.test.ts), so this is defense in depth against a later
    // allowlisting rather than the gate that stops a visitor today.
    if (visitor) return j(403, { error: 'not available to share visitors' });
    if (!deployer) {
      return j(501, {
        error:
          'deploy not enabled on this server (dev and staging deliberately cannot pull or restart the deploy source)',
      });
    }
    // Reading is not deploying: a board surface that shows deploy state
    // is served over the tailnet, and reporting what already happened
    // cannot restart anything. So the read stays at trusted-local, the
    // same level as every other operator read on this server.
    if (req.method === 'GET') return j(200, { deploy: deployer.last() });
    if (req.method === 'POST') {
      // Triggering one is different, and this is the narrow default.
      //
      // `local` in the host guard means "the Host header names one of
      // our own names", which covers every client on the tailnet and
      // the LAN — measured, not assumed. The refresh route next door is
      // safe at that width because it cannot interrupt anybody; a
      // deploy ends this process and drops every live editor socket on
      // the box, so it does not inherit that argument.
      //
      // Checked on the PEER ADDRESS rather than the Host header,
      // because the Host header is client-controlled: a LAN and a
      // tailnet client both reached this server sending
      // `Host: localhost` in the same measurement. See
      // `isLoopbackAddress`.
      //
      // TO LOOSEN (Bryan's call): drop this block and the route is
      // reachable by any trusted-local caller again. That is one
      // deletion, which is why the default is the narrow one — the
      // mistake it can make is refusing a caller who can retry from
      // the box, not restarting prod for somebody who should not have
      // been able to.
      if (!isLoopbackAddress(requestAddress(req))) {
        return j(403, {
          error:
            'deploy must be triggered from this machine (loopback only) — a deploy restarts the server and drops every live editor',
        });
      }
      // Loopback is necessary, not sufficient: cloudflared runs on
      // this box, so a request through the tunnel — the operator's
      // proxied hostname, Access token and all — arrives from
      // 127.0.0.1 and passes the address test. `cf-ray` is the hop's
      // own signature (see the refresh route above for why it is the
      // right test). (Urgent-fixes ticket, 2026-09-02.)
      if (req.headers.has('cf-ray')) {
        return j(403, {
          error:
            'deploy cannot be triggered through the edge (proxied request) — run it from the box',
        });
      }
      // Loopback is the PEER ADDRESS, which a page served from this
      // machine also has, so it says nothing about whether a page or an
      // agent asked. This does — see browserCannotOperateBody.
      if (isBrowserRequest(req.headers)) return j(403, browserCannotOperateBody());
      const body = (await safeJson(req)) ?? {};
      const force = body.force === true;
      const requestedBy = typeof body.requestedBy === 'string' ? body.requestedBy : undefined;
      return j(200, {
        deploy: await deployer.deploy({ force, ...(requestedBy ? { requestedBy } : {}) }),
      });
    }
    return j(405, { error: 'method not allowed' });
  }

  return undefined;
}
