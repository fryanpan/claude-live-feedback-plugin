/**
 * ── Shell and static serving: which page or asset does this address get ──
 *
 * The tail of the router, plus the closure helpers it calls. One subject:
 * given an address and who is asking, hand back an HTML shell, a built
 * asset, a mockup's own file, or a redirect to the address that has one.
 *
 * Everything here is decided AFTER admission, and its only per-request input
 * is the `visitor` the gate resolved, so this went back to the shape A15 and
 * A16 used and A17 could not: a factory of long-lived values, with the
 * visitor passed per call. `request-admission.ts` is the reason that is
 * safe — the visitor reaching this module has already been admitted and
 * scoped, so nothing here re-decides access, and nothing here should.
 *
 * ── Why the helpers and the routes are one file ──
 *
 * They are one decision read at two depths. `isMockupDoc` exists because a
 * mockup sent to the doc shell paints an empty page under a 200, and FOUR
 * route blocks branch on it to avoid exactly that; `addressableWorkspaceFor`
 * exists because a share visitor must be redirected to the workspace they
 * were shared rather than whichever one holds the doc first, and three
 * blocks call it. Split the helpers from the routes and the rules survive
 * only as long as every future block remembers to ask.
 *
 * ── The fall-through contract ──
 *
 * `serveShellRoutes` returns `Response | null`. Null means "no block here
 * claimed this address", which is what the run did inside `route()` when a
 * static file was missing: `if (resp) return resp;` and on to the next
 * block. `createServer` answers a null with the same 404 that used to sit at
 * the bottom of the handler, so the ordering inside the run and the ordering
 * around it are both unchanged.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { reviewIdOf } from '@feedback/core';
import type { DocType } from '@feedback/core';
import type { BrowserSentryConfig, PageType } from './browser-sentry.ts';
import { injectSentryHead } from './browser-sentry.ts';
import { buildLandingModel } from './landing.ts';
import type { ShareTarget } from './middleware/host-guard.ts';
import {
  captureMockup,
  isHtmlMockupSource,
  readMockupCapture,
  readMockupHtml,
} from './mockup-capture.ts';
import { injectWidget } from './mockup-widget.ts';
import type { ReviewItemRow } from './review-queue.ts';
import type { Rooms } from './rooms.ts';
import {
  HTML_SHELL_HEADERS,
  appCacheControl,
  buildProjectArtifacts,
  collectLandingProjects,
  collectLandingWorkspaces,
  readAppAssetManifest,
  renderDeviceFrame,
  renderHubNotFound,
  renderHubShell,
  renderLanding,
  renderMockupNotFound,
  renderProjectPage,
  renderReviewNotFound,
  renderSigninShell,
  serveStatic,
  serveStaticUnder,
} from './shells.ts';
import type { HubWorkspace, TaskStore } from './tasks.ts';

/** Files the workspaces-app build emits that must ALSO answer at the root
 *  path. See the route for why each one is here rather than under /app/. */
const ROOT_ALIASED_ASSETS = new Set([
  '/sw.js',
  '/sw.js.map',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
]);

/** What shell and static serving reads. Every member is long-lived; the
 *  request, its address and the admitted visitor arrive per call. */
export interface ShellStaticContext {
  /** The three built asset roots, each null when that bundle was not built.
   *  A null root does not 404 — it declines, and the run falls through. */
  widgetDist: string | null;
  markdownAppDist: string | null;
  demosDir: string | null;
  /** Where a mockup's capture is written and read back. */
  dataDir: string;
  /** Doc rooms: what an address resolves to, and the meta a mockup is
   *  served from. */
  rooms: Rooms;
  /** The boards, for the hub shell's name and the landing page's rows. */
  taskStore: TaskStore;
  /** The browser Sentry config, injected into every shell on the way out.
   *  Null leaves the built bytes exactly as they are. */
  browserSentry: BrowserSentryConfig | null;
  /** Whether the code sign-in page exists on this deployment. Under
   *  access-only it does not, and `/signin` is a 404 rather than a redirect. */
  emailCodeSignIn: boolean;
  /** The JSON responder, so a refusal here is spelled as a route's. */
  j: (status: number, body: unknown) => Response;
  /** The docId shape check every address-taking block runs first. */
  isValidDocId: (id: string) => boolean;
  /** A 302 that keeps the query string. */
  redirectTo: (path: string, search: string) => Response;
  /** The workspace a doc is filed under, for the compat redirects. */
  resolveWorkspaceForDoc: (docId: string) => string | null;
  /** Doc metadata decorated with its review URL, for a project's artifacts. */
  withReviewUrl: <T extends { docId: string; type: DocType; sourceUrl?: string }>(
    meta: T,
  ) => T & { reviewUrl?: string };
  /** Home's own queue counter, so the number on `/` is the number the
   *  reader sees when they open the board. See home-pane.ts. */
  reviewItemsFor: (workspace: HubWorkspace) => ReviewItemRow[];
  homeQueueTotal: (workspace: HubWorkspace, items: ReviewItemRow[]) => number;
  /** The holding-pen board's name, which the landing banner's join names. */
  defaultHubWorkspaceName: string;
}

/** The address this request is asking about, and who is asking. */
export interface ShellStaticRequest {
  req: Request;
  url: URL;
  pathname: string;
  /** The admitted visitor, or null on a local request. Read only to choose
   *  a redirect target and to drop the "all workspaces" arrow — never to
   *  decide access, which `request-admission.ts` has already done. */
  visitor: ShareTarget | null;
}

export interface ShellStatic {
  /** A shell, an asset, a mockup or a redirect — or null when no block here
   *  claimed the address, which the caller answers with its 404. */
  serveShellRoutes: (addressed: ShellStaticRequest) => Response | null;
}

export function createShellStatic(ctx: ShellStaticContext): ShellStatic {
  const {
    widgetDist,
    markdownAppDist,
    demosDir,
    dataDir,
    rooms,
    taskStore,
    browserSentry,
    emailCodeSignIn,
    j,
    isValidDocId,
    redirectTo,
    resolveWorkspaceForDoc,
    withReviewUrl,
    reviewItemsFor,
    homeQueueTotal,
    defaultHubWorkspaceName,
  } = ctx;

  /**
   * The workspace to send THIS caller to for a doc.
   *
   * For a share visitor it is always the workspace they were shared, never
   * whichever workspace happens to hold the doc first. The guard has already
   * established the doc is in their scope by the time they reach a redirect,
   * and sending them anywhere else fails twice over: it names a workspace
   * nobody shared with them, and the guard then refuses the very URL we just
   * handed out — so an old `/review/<docId>` bookmark, which is the shape
   * every link in every existing comment thread has, would 403 for exactly
   * the people shares exist to serve.
   */
  const addressableWorkspaceFor = (docId: string, visitor: ShareTarget | null): string | null =>
    visitor?.workspaceId ?? resolveWorkspaceForDoc(docId);

  /**
   * Which member a review opens on: the meatiest change, matching the entry
   * `create_diff_review` returns. Alphabetical order would land the reviewer
   * on dotfile and config noise on any large review.
   */
  const reviewEntryDocId = (reviewId: string): string | null => {
    const members = rooms.list().filter((m) => reviewIdOf(m) === reviewId);
    if (members.length === 0) return null;
    const best = members.reduce((a, b) =>
      (b.diffAdditions ?? 0) + (b.diffDeletions ?? 0) >
      (a.diffAdditions ?? 0) + (a.diffDeletions ?? 0)
        ? b
        : a,
    );
    return best.docId;
  };

  /** The review app shell for a doc, or its 404. Null when no app is built. */
  const serveDocShell = (docId: string, url: URL): Response | null => {
    if (!markdownAppDist) return null;
    // Docs are file-backed and created upfront via POST /api/docs. Arriving
    // before an agent has done that gets a clean 404 — there is nothing the
    // app could render for a doc that does not exist.
    if (!rooms.get(docId)) {
      return new Response(renderReviewNotFound(docId), {
        status: 404,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    // Device-frame simulation: `?mobile=<preset>` returns a shell hosting the
    // real page in an iframe sized to the preset, so media queries inside it
    // see the small width.
    const mobilePreset = url.searchParams.get('mobile');
    if (mobilePreset) {
      return new Response(renderDeviceFrame(mobilePreset, url), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    // The doc editor's shell is a BUILT file, identical on every box, so the
    // Sentry tags cannot be templated into it at build time — they are box
    // config. Rewritten here on the way out instead, the same way a mockup's
    // own HTML gets the widget. Unconfigured, `injectSentryHead` is skipped
    // and the built bytes go out as they are. The bundle URLs inside are
    // already content-addressed — the BUILD wrote them that way.
    return serveShellHtml(join(markdownAppDist, 'index.html'), 'doc');
  };

  /**
   * A built HTML shell, with the browser Sentry tags added for `pageType`.
   *
   * Read rather than delegated to `serveStatic` because the body can be
   * rewritten on the way out and the response has to describe what was
   * actually SENT. That used to mean re-hashing for an etag; it now means
   * `no-store` and no etag at all, which is the same principle taken one step
   * further — see `HTML_SHELL_HEADERS`.
   */
  const serveShellHtml = (path: string, pageType: PageType): Response | null => {
    if (!existsSync(path)) return null;
    // `no-store`, and no etag to go with it. This shell names the bundle URLs
    // the page will load; a browser holding an old copy of it loads the
    // bundles IT names, and there is no later request in which to notice.
    // Since those URLs are content-addressed, the shell is the only thing
    // that has to stay fresh — and it is about a kilobyte gzipped.
    const raw = readFileSync(path, 'utf8');
    const html = browserSentry
      ? injectSentryHead(raw, browserSentry, pageType, readAppAssetManifest(markdownAppDist))
      : raw;
    return new Response(html, { headers: HTML_SHELL_HEADERS });
  };

  /**
   * Whether a doc is a mockup, and so must never be sent to the doc route.
   *
   * The editor shell renders from LF-held content, and a mockup has none —
   * its surface is a host page. Asked for one anyway, the shell loads, finds
   * nothing to show, and paints an empty page under a 200. That is the worst
   * failure shape available: the status says it worked, so nothing upstream
   * reports it and the reviewer is left assuming the mockup itself is broken.
   * Both doc routes therefore check this and redirect instead.
   *
   * Deliberately keyed on the doc's own type rather than `contentKind`: a
   * `workspace` room also holds no content surface, but its route is the
   * board, not a mockup.
   */
  const isMockupDoc = (docId: string): boolean => rooms.peekMeta(docId)?.type === 'mockup';

  /**
   * A mockup's own HTML, streamed from the file the room is bound to — with
   * the comment widget added on the way out.
   *
   * The embed is attached HERE rather than written into the file, so a page
   * that a build step generates, or that git tracks, never has to carry review
   * scaffolding to be reviewable. See mockup-widget.ts for the incident that
   * moved it. A page that embeds the widget itself is served untouched.
   *
   * The live file wins whenever it is readable, and serving refreshes the
   * capture from it — so a mock that is still being edited behaves exactly as
   * it always did, and the fallback holds the last thing anyone was shown
   * rather than whatever round one looked like. Only when the file is gone
   * does the capture answer, which is the case that used to be a 404 in front
   * of the reviewer. See mockup-capture.ts.
   */
  const serveMockup = (docId: string): Response => {
    const notFound = () =>
      new Response(renderMockupNotFound(docId), {
        status: 404,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    const room = rooms.get(docId);
    if (!room || room.meta.type !== 'mockup' || !room.meta.sourceUrl) return notFound();
    const source = room.meta.sourceUrl;
    // A mockup bound to something that isn't HTML is served as-is, as before:
    // nothing is injected into it and nothing is captured from it.
    if (!isHtmlMockupSource(source)) return serveStatic(source) ?? notFound();
    const live = readMockupHtml(source);
    if (live !== null) captureMockup(dataDir, room.docId, live);
    const html = live ?? readMockupCapture(dataDir, room.docId);
    if (html === null) return notFound();
    // Sentry tags ride out with the widget embed, for the same reason and by
    // the same route: a mockup is somebody's own file, and neither the review
    // scaffolding nor the box's monitoring config belongs in it on disk.
    const withWidget = injectWidget(html, room.meta.docId);
    const body = injectSentryHead(
      withWidget,
      browserSentry,
      'mockup',
      readAppAssetManifest(markdownAppDist),
    );
    return new Response(body, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache',
        // Content-derived like serveStatic's, and for the same reason: a
        // reload of an unchanged mock should cost a 304, and a deploy that
        // changed nothing should not throw the cache away. Hashed from the
        // BODY WE SEND rather than the file we read — the widget embed and
        // the Sentry head are part of what the browser is holding, so a
        // source-derived tag would revalidate a page whose injected half had
        // changed underneath it. (`serveShellHtml` no longer carries a tag at
        // all — it is `no-store`, so there is nothing stored to validate.)
        etag: `"${Bun.hash(body).toString(16)}"`,
        // Which copy answered. A page served from the capture is still the
        // page — but "the source file is gone" is a fact somebody may want to
        // act on, and it must not be inferred from the absence of an error.
        'x-mockup-source': live !== null ? 'live' : 'captured',
      },
    });
  };

  const serveShellRoutes = ({
    req,
    url,
    pathname,
    visitor,
  }: ShellStaticRequest): Response | null => {
    // --- Static: widget ---
    if (widgetDist && pathname.startsWith('/widget/')) {
      const p = join(widgetDist, pathname.slice('/widget/'.length));
      // serveStaticUnder, like /app/ and /demos/ — this was the one static
      // root built from the request path that skipped the containment
      // check. Inert today (URL normalizes `..` before we see it, and we
      // never decode the remainder), but /widget/ is on the SHARE
      // visitor's allowlist, so it is the last of the three that should
      // be relying on that.
      const resp = serveStaticUnder(widgetDist, p);
      if (resp) return resp;
    }
    if (
      widgetDist &&
      (pathname === '/widget.js' || pathname === '/widget.iife.js' || pathname === '/widget.esm.js')
    ) {
      const map: Record<string, string> = {
        '/widget.js': 'widget.esm.js',
        '/widget.esm.js': 'widget.esm.js',
        '/widget.iife.js': 'widget.iife.js',
      };
      const file = map[pathname]!;
      const p = join(widgetDist, file);
      const resp = serveStatic(p);
      if (resp) return resp;
    }

    // --- Web app files that must live at the ROOT path ---
    //
    // These are the same bytes served under /app/, aliased up a level
    // because the path they are fetched from is load-bearing rather than
    // cosmetic. A service worker's scope cannot exceed the directory it
    // was served from, so a worker at /app/sw.js could never handle a
    // notification click aimed at /workspaces/… . The manifest and icons
    // ride along because a Home Screen install reads them by absolute
    // path and one place for them is simpler than two.
    //
    // Deliberately NOT added to the share-host allowlist in
    // host-guard.ts: enrolling a workspace visitor's phone for push is a
    // scope decision nobody has made, and the allowlist is
    // closed-by-default precisely so it stays a decision.
    if (markdownAppDist && ROOT_ALIASED_ASSETS.has(pathname) && req.method === 'GET') {
      const resp = serveStaticUnder(markdownAppDist, join(markdownAppDist, pathname.slice(1)));
      if (resp) return resp;
    }

    // --- Workspace hub (plan §3.9/§3.10: /workspaces/:workspaceId) ---
    // The shell is server-rendered (like the landing page) so the route
    // works — and 404s crisply — whether or not the app bundle has been
    // built; the page's behavior all lives in /app/hub.js.
    // Every nav suffix serves the same shell: which destination renders is
    // the client's routing (`navFromPath` in hub-presence-model), so all four are
    // deep-linkable — the board banner's "Go to Home", a phone bookmark
    // and a pasted link all land on the destination, not on the board with
    // a hint.
    //
    // The list must stay in step with `HubNav`, and the cost of it not
    // being is invisible from the client: `setNav` pushes these paths into
    // history, so a suffix missing here costs nothing until somebody
    // RELOADS or shares the URL, at which point they get a 404 on a link
    // the product handed them. That is exactly what `/tasks`, `/mine` and
    // `/activity` did between the nav landing and this line — measured on
    // a staging build, 404 on all three while `/home` answered 200.
    const hubPageMatch = pathname.match(
      /^\/workspaces\/([^/]+?)(?:\/(?:home|tasks|mine|activity))?$/,
    );
    if (hubPageMatch && req.method === 'GET') {
      const workspaceId = decodeURIComponent(hubPageMatch[1] ?? '');
      const workspace = taskStore.getWorkspace(workspaceId);
      if (!workspace) {
        return new Response(renderHubNotFound(workspaceId), {
          status: 404,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      return new Response(
        renderHubShell(workspace.id, workspace.name, {
          feedback: !visitor,
          // The board is the whole of what a visitor was given, so the
          // shell leaves out the "all workspaces" arrow rather than
          // painting a link to a 403.
          visitor: Boolean(visitor),
          sentry: browserSentry,
          assets: readAppAssetManifest(markdownAppDist),
        }),
        { headers: HTML_SHELL_HEADERS },
      );
    }

    /**
     * --- Resources under the workspace they belong to ---
     *
     * `/workspaces/<workspaceId>/docs/<docId>`,
     * `/workspaces/<workspaceId>/mockups/<docId>`,
     * `/workspaces/<workspaceId>/reviews/<reviewId>`.
     *
     * The workspace segment is CONTEXT, not authorization. It tells the
     * page (and the reader) which workspace they are in, and it is what
     * the back arrow and the sidebar build their links from. It is
     * deliberately not checked against the doc's own filing: a doc moved
     * between workspaces would otherwise 404 every link already handed
     * out, and the check that does matter — is this visitor allowed to
     * see this resource — belongs to the share guard, which checks the
     * workspace AND the resource and is the only thing that should.
     */
    const wsResourceMatch = pathname.match(
      /^\/workspaces\/([^/]+)\/(docs|mockups|reviews)\/([^/]+)$/,
    );
    if (wsResourceMatch && req.method === 'GET') {
      const wsSeg = decodeURIComponent(wsResourceMatch[1] ?? '');
      const kind = wsResourceMatch[2] ?? '';
      const id = decodeURIComponent(wsResourceMatch[3] ?? '');
      if (kind === 'reviews') {
        // A review is a set of docs, not a page. Send the reader to the
        // member worth opening first — the same entry `create_diff_review`
        // picks, so the URL and the tool agree on where a review starts.
        const entry = reviewEntryDocId(id);
        if (!entry) {
          return new Response(renderReviewNotFound(id), {
            status: 404,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          });
        }
        return redirectTo(
          `/workspaces/${encodeURIComponent(wsSeg)}/docs/${encodeURIComponent(entry)}`,
          url.search,
        );
      }
      if (!isValidDocId(id)) return j(400, { error: 'bad docId' });
      const canonical = rooms.get(id)?.docId ?? id;
      if (kind === 'mockups') return serveMockup(canonical);
      if (isMockupDoc(canonical)) {
        return redirectTo(
          `/workspaces/${encodeURIComponent(wsSeg)}/mockups/${encodeURIComponent(canonical)}`,
          url.search,
        );
      }
      const served = serveDocShell(canonical, url);
      if (served) return served;
    }

    // --- Markdown app (surface 1) ---
    //
    // COMPAT. `/review/<docId>` is where every doc used to live, and it
    // still answers — it redirects to the workspace path when the doc's
    // workspace can be resolved, and serves in place when it cannot. See
    // the compat block note above `resolveWorkspaceForDoc`.
    if (pathname.startsWith('/review/')) {
      const addressed = decodeURIComponent(pathname.slice('/review/'.length));
      if (!isValidDocId(addressed)) return j(400, { error: 'bad docId' });
      // A captured review URL carries whatever id it was copied with: a
      // pre-migration doc's own id, or the readable alias of one minted
      // since. Both land on the same doc, and the redirect below rewrites
      // either into the canonical address.
      const docId = rooms.get(addressed)?.docId ?? addressed;
      // A mockup has no editor, so the doc route is the wrong destination
      // for one — see `isMockupDoc`. Hand it to the mockup route's own
      // resolution, which is the behaviour `/mockup/<docId>` already has.
      if (isMockupDoc(docId)) {
        const mockHome = addressableWorkspaceFor(docId, visitor);
        if (mockHome) {
          return redirectTo(
            `/workspaces/${encodeURIComponent(mockHome)}/mockups/${encodeURIComponent(docId)}`,
            url.search,
          );
        }
        return serveMockup(docId);
      }
      // The redirect is deliberately OUTSIDE the `markdownAppDist` guard
      // that wraps the serve below. Where a doc lives is a fact about
      // addressing; whether the browser app has been built is a fact
      // about this deployment. Tying the two together would make an old
      // URL 404 on a server that simply has no app bundle, which is a
      // different failure wearing the same status code.
      if (rooms.get(docId)) {
        const home = addressableWorkspaceFor(docId, visitor);
        if (home) {
          return redirectTo(
            `/workspaces/${encodeURIComponent(home)}/docs/${encodeURIComponent(docId)}`,
            url.search,
          );
        }
      }
      const served = serveDocShell(docId, url);
      if (served) return served;
    }
    if (markdownAppDist && pathname.startsWith('/app/')) {
      const rel = pathname.slice('/app/'.length);
      const p = join(markdownAppDist, rel);
      const resp = serveStaticUnder(markdownAppDist, p, appCacheControl(basename(rel)));
      if (resp) return resp;
    }

    // --- Mockup HTML — bound to a docId via bind_mock / POST /api/docs
    //     with type='mockup'. Reads the file at the room's sourceUrl
    //     (any absolute path on disk) and streams it as text/html. The
    //     pre-bind_mock workflow required symlinking each new HTML
    //     into <plugin-repo>/demos/ — `/mockup/<docId>` replaces that
    //     dance and matches the contract of `/review/<docId>` for
    //     markdown docs: one MCP call, one URL, no filesystem juggling.
    //     Single-file mockups only — assets the HTML references via
    //     relative paths won't resolve since we don't serve the source
    //     directory. Use the existing /demos/ multi-page path for
    //     mockups that ship with sibling files.
    //     COMPAT, same rule as `/review/`: redirect to the workspace path
    //     when the mockup's workspace resolves, serve in place when it
    //     does not.
    if (pathname.startsWith('/mockup/')) {
      const slug = decodeURIComponent(pathname.slice('/mockup/'.length));
      // Tolerate `/mockup/<docId>.html` AND `/mockup/<docId>` — agents
      // share whichever URL feels natural.
      const addressed = slug.replace(/\.html?$/i, '');
      if (!isValidDocId(addressed)) return j(400, { error: 'bad docId' });
      const docId = rooms.get(addressed)?.docId ?? addressed;
      const home = rooms.get(docId) ? addressableWorkspaceFor(docId, visitor) : null;
      if (home) {
        return redirectTo(
          `/workspaces/${encodeURIComponent(home)}/mockups/${encodeURIComponent(docId)}`,
          url.search,
        );
      }
      return serveMockup(docId);
    }

    // --- Demos ---
    if (demosDir && pathname.startsWith('/demos/')) {
      let p = join(demosDir, pathname.slice('/demos/'.length));
      if (!extname(p)) p = join(p, 'index.html');
      const resp = serveStaticUnder(demosDir, p);
      if (resp) return resp;
    }

    // --- Sign-in page ---
    // Server-rendered shell like the hub's, so the route works — and the
    // page's behavior all lives in /app/signin.js. Identity, not access:
    // the tailnet reaches everything signed out; this page only lets a
    // person claim who they are (`/api/auth/*` above).
    if (pathname === '/signin' && req.method === 'GET') {
      // Turned off under access-only: the page's whole job is to prove an
      // address, and Access proved one before the request arrived. 404
      // rather than a redirect, so nothing links here and nothing lands
      // here — a dead end is exactly what this removes.
      if (!emailCodeSignIn) return j(404, { error: 'not_found' });
      return new Response(renderSigninShell(browserSentry, readAppAssetManifest(markdownAppDist)), {
        headers: HTML_SHELL_HEADERS,
      });
    }

    // --- Landing ---
    if (pathname === '/') {
      const model = buildLandingModel(
        collectLandingWorkspaces(rooms, taskStore, (ws) => homeQueueTotal(ws, reviewItemsFor(ws))),
        collectLandingProjects(rooms),
        Date.now(),
      );
      // The landing banner's join files its doc under the default board
      // (the join POST carries no workspaceId from `/`), so the offer
      // names that destination on its face.
      // `no-store` like every other shell, and this one has a second
      // reason of its own: the page IS the model — workspace rows,
      // waiting counts, "active in the last N days". Served with no cache
      // directives at all, as it was, a browser picks its own freshness
      // lifetime and can show a queue that has since been worked.
      return new Response(
        renderLanding(
          model,
          browserSentry,
          defaultHubWorkspaceName,
          readAppAssetManifest(markdownAppDist),
        ),
        { headers: HTML_SHELL_HEADERS },
      );
    }

    // --- One project's artifacts, on demand ---
    // The landing page deliberately does not carry these. Work here is
    // proportional to the project somebody actually opened, not to every
    // room on the server.
    if (pathname.startsWith('/projects/')) {
      let owner: string;
      try {
        owner = decodeURIComponent(pathname.slice('/projects/'.length));
      } catch {
        return new Response('bad project', { status: 400 });
      }
      if (owner === '') return new Response('not found', { status: 404 });
      const artifacts = buildProjectArtifacts(rooms, withReviewUrl, owner);
      return new Response(
        renderProjectPage(owner, artifacts, browserSentry, readAppAssetManifest(markdownAppDist)),
        { status: artifacts.length === 0 ? 404 : 200, headers: HTML_SHELL_HEADERS },
      );
    }
    return null;
  };

  return { serveShellRoutes };
}
