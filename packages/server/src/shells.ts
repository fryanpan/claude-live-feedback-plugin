import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
/**
 * Every HTML page this server renders itself, and the static serving under
 * them.
 *
 * Five shells and one file server. The shells — board, sign-in, landing,
 * project page, and the three "not found" pages — are what a browser gets
 * before any bundle runs, so each is a complete document with its own
 * `<style>`: nothing here may depend on an asset that has not loaded yet.
 * Everything dynamic renders client-side afterwards from the ydoc projection
 * and REST.
 *
 * They sit outside `createServer` because they always did — none of them
 * reads the closure. What they need is passed in: a `DocStore` and a
 * `TaskStore` for the landing page's inventory, an asset manifest so a shell
 * names the bundle that actually shipped, and the browser Sentry config so
 * the head tags exist or do not exist as one decision.
 *
 * The one rule that is not obvious: a shell is served `no-store`
 * (HTML_SHELL_HEADERS). Every shell names the asset URLs its page will load,
 * so it is the one document whose staleness cannot be recovered from — the
 * assets it names are content-addressed and cache forever, which is exactly
 * what makes a stale shell unrecoverable.
 *
 * Layer: HTTP. Imports services and domain, never a route.
 */
import type { DocType } from '@feedback/core';
import {
  ASSET_MANIFEST_FILE,
  type AssetManifest,
  assetHref,
  isContentHashedAsset,
  parseAssetManifest,
} from '@feedback/core/asset-manifest';
import { type BrowserSentryConfig, sentryHeadTags } from './browser-sentry.ts';
import { BOARD_FEEDBACK_DOC_ID } from './doc-ids.ts';
import type { DocStore, WorkspaceDirNode, WorkspaceFileNode } from './doc-store.ts';
import type {
  LandingModel,
  LandingProjectLink,
  LandingWorkspaceInput,
  LandingWorkspaceRow,
} from './landing.ts';
import { isWithinRoot } from './safe-path.ts';
import { type BoardWorkspace, type TaskStore, isRetired } from './tasks.ts';

/** The content type a static file is served with, by extension. */
const CT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  // Without this the manifest ships as application/octet-stream and the
  // browser declines to install it — which presents as "Add to Home Screen
  // makes a bookmark, not an app", with nothing in the console about why.
  '.webmanifest': 'application/manifest+json',
};

/**
 * Serve a file only if it really sits under `root`.
 *
 * `/app/*` and `/demos/*` build their path out of the request URL. Today
 * that is safe by accident rather than by design — `new URL()` collapses
 * `..` segments before we ever see the pathname — but nothing in this file
 * says so, and one future caller that decodes or rewrites a path would turn
 * a static route into an arbitrary-file read on a host that is now publicly
 * reachable. Assert the containment where the read happens.
 */
/**
 * What an HTML shell must be sent with.
 *
 * `no-store`, not `no-cache`. Every shell here names the asset URLs the page
 * will load, so it is the one document whose staleness cannot be recovered
 * from: a browser holding a shell from two deploys ago loads the bundles that
 * shell names and there is no later request in which to notice. `no-cache`
 * asks a browser to revalidate; `no-store` tells it there is nothing to
 * revalidate. The bug this replaced was a shell served with no cache
 * directives AT ALL, which makes it heuristically cacheable — the browser
 * picks its own lifetime.
 *
 * The cost is the shell itself on every navigation: about 1 KB gzipped, and
 * the assets it names still cache forever because they are content-addressed.
 */
export const HTML_SHELL_HEADERS: Record<string, string> = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
};

/**
 * The caching policy for one file under `/app/`.
 *
 * Three answers, and the middle one is the fix:
 *
 *   • `BUILD_INFO.txt` — `no-store`. The whole stale check reads this to learn
 *     the truth; a cached copy of it is the check lying to itself.
 *   • a content-addressed name — a year, `immutable`. Safe by construction:
 *     the name is a hash of the bytes, so these bytes at this URL can never
 *     become something else. This is what lets the shell stop depending on a
 *     browser's willingness to revalidate.
 *   • everything else — `no-cache`, as before. That is the plain-named copies
 *     kept for shells cached before the hashing landed, and it is exactly the
 *     policy whose weakness this change routes around rather than trusts.
 */
export function appCacheControl(fileName: string): string {
  if (fileName === 'BUILD_INFO.txt') return 'no-store';
  if (isContentHashedAsset(fileName)) return 'public, max-age=31536000, immutable';
  return 'no-cache';
}

/**
 * The built asset manifest, read fresh on every shell render.
 *
 * Deliberately NOT cached, and not read once at startup. `bun run dev`
 * rebuilds the client under a running server, and a deploy republishes the
 * release directory beneath it — a remembered manifest would name hashes that
 * no longer exist, which is a 404 on the bundle rather than merely a stale
 * one. Caching it on mtime is the obvious repair and the wrong one: two
 * rebuilds inside a millisecond report the same mtime. This is a few hundred
 * bytes read on page NAVIGATIONS only, never on an asset request.
 *
 * Absent or unreadable answers `{}`, and every caller then falls back to the
 * permanent names, which the build still emits.
 */
export function readAppAssetManifest(dist: string | null): AssetManifest {
  if (!dist) return {};
  try {
    return parseAssetManifest(readFileSync(join(dist, ASSET_MANIFEST_FILE), 'utf8'));
  } catch {
    return {};
  }
}

export function serveStaticUnder(root: string, p: string, cacheControl?: string): Response | null {
  // isWithinRoot realpaths both sides: `path.resolve` is purely LEXICAL, so a
  // symlink inside the root pointing anywhere on disk sails straight through a
  // string-prefix check. `demos/` in particular is a directory of Bryan's own
  // files, where a convenience symlink is entirely plausible. It answers
  // closed for a missing file or a dangling link — nothing to serve either way.
  if (!isWithinRoot(root, p)) return null;
  return serveStatic(p, cacheControl);
}

export function serveStatic(p: string, cacheControl?: string): Response | null {
  if (!existsSync(p)) return null;
  const buf = readFileSync(p);
  const ct = CT[extname(p).toLowerCase()] ?? 'application/octet-stream';
  return new Response(buf, {
    headers: {
      'content-type': ct,
      // `no-cache` is kept: this fleet redeploys often and a browser quietly
      // running last week's bundle is the worse failure. What it means is
      // "revalidate before use", NOT "do not store" — but a revalidation needs
      // a validator, and there was none here, so the only answer the server
      // could give was the whole file again. Every board load re-sent every
      // byte of its CSS, its app bundle and the widget. The etag below is what
      // turns that into a 304.
      //
      // A caller may override it — `/app/` does, because a content-addressed
      // name earns a year and `BUILD_INFO.txt` earns none. `no-cache` stays
      // the default for every root that is NOT content-addressed.
      'cache-control': cacheControl ?? 'no-cache',
      // Hashed from the CONTENT rather than from mtime+size. A redeploy writes
      // these files fresh, so mtime moves on every deploy whether or not the
      // bytes did — which would throw away the cache precisely when nothing
      // changed. Content-derived, an unchanged bundle keeps its tag across
      // deploys and a changed one cannot keep it. Bun's hash is not
      // cryptographic and does not need to be: this answers "same bytes?",
      // and nothing downstream trusts it for anything else.
      etag: `"${Bun.hash(buf).toString(16)}"`,
    },
  });
}

export function renderMockupNotFound(docId: string): string {
  const safe = escape(docId);
  return `<!doctype html><meta charset="utf-8"><title>Mockup not found · Workspaces</title>
<style>body{font:15px/1.55 system-ui, sans-serif;margin:60px auto;max-width:560px;color:#222;padding:0 20px}
h1{font-size:22px}code{background:#f3f3f3;padding:1px 5px;border-radius:3px;font-size:90%}
small{color:#777}</style>
<h1>Mockup not found</h1>
<p>No mockup is bound to <code>${safe}</code>, or its source file isn't readable.
Mockups are bound by an agent calling <code>attach_mockup</code> with an absolute path
to an HTML file. Once bound, the file is served here without any symlink dance.</p>
<p>Ask the agent who shared this URL to call <code>attach_mockup(docId, sourceHtmlPath)</code>, then refresh.</p>`;
}

/**
 * The board page shell (§3.9). Tab title is `<workspace> · Workspaces` — the
 * browser tab is a workspace switcher, so the WORKSPACE leads and the product
 * name trails, where truncation can take it. (`board-app.ts` extends the same
 * title with the open pane once the bundle runs.) Everything dynamic renders
 * client-side from the ws:<id> ydoc projection + REST; the shell only names
 * the workspace and loads the bundle.
 *
 * `feedback` embeds the comment widget, pointed at ONE well-known doc
 * (`BOARD_FEEDBACK_DOC_ID`) rather than at a per-workspace one — feedback about
 * the board UI is about the product, not about the workspace you happened to be
 * standing in, so it should reach the same place from every board. The widget
 * auto-captures `location` as the anchor url, so the comment already says
 * which board it came from; `view` adds the workspace NAME so the thread reads
 * without anyone resolving an id.
 *
 * `identity-scope="host"` is what makes the feedback ATTRIBUTED. The widget
 * normally keeps its identity under a `cfw:` prefix so it cannot touch a
 * third-party host page's storage — but this page is ours, and the board has
 * already asked the reader their name (`ensureUserIdentity`, unprefixed keys).
 * Without this attribute the same page holds two identities for one human: the
 * presence strip greets the reader by the name they gave, while every comment
 * the widget posts from that same page is signed "Anonymous <animal>".
 * Observed in a browser on 2026-08-17.
 *
 * Declarative `<claude-feedback-widget>` rather than `FeedbackWidget.init` on
 * purpose: a module script is deferred, so a plain inline script calling
 * `init` would run before the module that defines it. The element upgrades on
 * parse and reads its own attributes.
 */
export function renderBoardShell(
  workspaceId: string,
  name: string,
  opts: {
    feedback: boolean;
    /**
     * Is the reader a share or collaboration visitor rather than the owner?
     *
     * One bit, and it exists for one thing the bundle cannot work out for
     * itself: on a share hostname there is no "all workspaces" page to go
     * back to — `/` is out of scope and answers a JSON refusal — so the back
     * arrow has no destination and `buildShell` leaves it out. The server is
     * the only side that knows which hostname class served this page, so it
     * has to be told rather than sniffed.
     *
     * Deliberately NOT a general "am I a visitor" channel for the client:
     * every access decision is made server-side, per request, and a bit in
     * the HTML is a hint about what to paint, never a permission.
     */
    visitor?: boolean;
    sentry?: BrowserSentryConfig | null;
    assets?: AssetManifest;
  } = {
    feedback: false,
  },
): string {
  // Content-addressed URLs for the three files this shell names. Without a
  // manifest (an unbuilt dist, or one from before hashing landed) these fall
  // back to the plain names, which is exactly what the shell said before.
  const assets = opts.assets ?? {};
  const boardJs = assetHref(assets, 'board.js');
  const stylesCss = assetHref(assets, 'styles.css');
  const boardCss = assetHref(assets, 'board.css');
  const tokensCss = assetHref(assets, 'tokens.css');
  const safeName = escape(name);
  const safeId = escape(workspaceId);
  const sentryTags = sentryHeadTags(opts.sentry ?? null, 'board', assets);
  const sentryMeta = sentryTags ? `\n    ${sentryTags}` : '';
  // Deliberately NOT rendered for a share visitor. Every peer on a Yjs doc
  // syncs the whole doc, so one shared feedback doc would hand every board
  // visitor every other workspace's feedback threads — including the board
  // paths and quoted UI text they were anchored to. Same lesson as the
  // DocMeta sidecar: a field that must not reach a visitor cannot live in a
  // CRDT they sync. Keeping the widget off their page keeps them off the doc.
  const widget = opts.feedback
    ? `
    <script type="module" src="/widget.esm.js"></script>
    <claude-feedback-widget doc-id="${escape(BOARD_FEEDBACK_DOC_ID)}" view="${safeName}" identity-scope="host"></claude-feedback-widget>`
    : '';
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1" />
    <title>${safeName} · Workspaces</title>
    <!-- Two shells, two copies. Kept in step with packages/workspaces-app/index.html
         on purpose: an install started from the board and one started from
         an attachment have to produce the same web app, and on iOS the Home
         Screen install is what makes push available at all. -->
    <link rel="manifest" href="/manifest.webmanifest" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <meta name="theme-color" content="#2e7dd7" />${sentryMeta}
    <!-- The board's own rules load FIRST, and the order is load-bearing. The
         board block sat about a twelfth of the way into styles.css, so most of
         that file came AFTER it and won every equal-specificity tie. Loading
         board.css last reverses ~30 of those; loading it first reverses one,
         which a .board-topbar .back-link:hover rule in board.css now pins. -->
    <link rel="stylesheet" href="${boardCss}" />
    <link rel="stylesheet" href="${stylesCss}" />
    <!-- Open Props trial layer — after styles.css on purpose; see
         packages/workspaces-app/index.html. -->
    <link rel="stylesheet" href="${tokensCss}" />
  </head>
  <body class="board-body">
    <div id="board-root" data-workspace-id="${safeId}"${opts.visitor ? ' data-visitor="1"' : ''}></div>
    <script type="module" src="${boardJs}"></script>${widget}
  </body>
</html>`;
}

/**
 * The sign-in page shell. Same pattern as the board shell — server-rendered so
 * the route answers whether or not the app bundle is built, all behavior in
 * the bundle (`/app/signin.js`), the app's own stylesheet so the page looks
 * like the product it signs you into.
 */
export function renderSigninShell(
  sentry: BrowserSentryConfig | null,
  assets: AssetManifest = {},
): string {
  const sentryTags = sentryHeadTags(sentry, 'signin', assets);
  const sentryMeta = sentryTags ? `\n    ${sentryTags}` : '';
  const signinJs = assetHref(assets, 'signin.js');
  const stylesCss = assetHref(assets, 'styles.css');
  const signinCss = assetHref(assets, 'signin.css');
  const tokensCss = assetHref(assets, 'tokens.css');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1" />
    <title>Sign in · Fryanpan Workspaces</title>
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <meta name="theme-color" content="#2e7dd7" />${sentryMeta}
    <link rel="stylesheet" href="${stylesCss}" />
    <!-- The page's own rules, between the two for the same reason the board's
         are: this is where they sat inside styles.css. -->
    <link rel="stylesheet" href="${signinCss}" />
    <link rel="stylesheet" href="${tokensCss}" />
  </head>
  <body class="signin-body">
    <div id="signin-root"></div>
    <script type="module" src="${signinJs}"></script>
  </body>
</html>`;
}

export function renderBoardNotFound(workspaceId: string): string {
  const safe = escape(workspaceId);
  return `<!doctype html><meta charset="utf-8"><title>Workspace not found · Workspaces</title>
<style>body{font:15px/1.55 system-ui, sans-serif;margin:60px auto;max-width:560px;color:#222;padding:0 20px}
h1{font-size:22px}code{background:#f3f3f3;padding:1px 5px;border-radius:3px;font-size:90%}
small{color:#777}</style>
<h1>Workspace not found</h1>
<p>No board workspace exists for <code>${safe}</code>. Board workspaces are
created by an agent calling <code>create_workspace</code> (or
<code>POST /api/workspaces</code> with a name).</p>
<p><small><a href="/">all docs</a></small></p>`;
}

export function renderReviewNotFound(docId: string): string {
  const safe = escape(docId);
  return `<!doctype html><meta charset="utf-8"><title>Doc not found · Workspaces</title>
<style>body{font:15px/1.55 system-ui, sans-serif;margin:60px auto;max-width:560px;color:#222;padding:0 20px}
h1{font-size:22px}code{background:#f3f3f3;padding:1px 5px;border-radius:3px;font-size:90%}
small{color:#777}</style>
<h1>Doc not found</h1>
<p>No attachment exists for <code>${safe}</code>. Markdown attachments are
created by an agent calling <code>POST /api/docs</code> with a
<code>sourceUrl</code> pointing at a markdown file on disk.</p>
<p>Ask the agent who shared this URL to create the doc, then refresh this page.</p>
<p><small><a href="/">all docs</a></small></p>`;
}

// --- Landing page: active workspaces; per-project artifact pages on demand ---
//
// `/` is a list of active workspaces to open up — see the header of
// `landing.ts` for what that sentence is quoting and what it deliberately
// leaves out. The project → artifacts model below serves `/projects/<owner>`,
// the on-demand index of attachments. It groups by PROJECT (the creating
// agent's cwd = doc.owner; 'ungrouped' when absent), and within a project
// lists ARTIFACTS. An artifact is one of:
//   - a workspace (bound folder/worktree; docs sharing a workspaceId) →
//     one expandable row with a rolled-up open-count badge and a nested file
//     list, each file linking to its reviewUrl
//   - a single markdown file, a code file, a mockup, or a dev server
// Each artifact carries its open-comment count and a kind glyph/label.

type ArtifactKind = 'workspace' | 'markdown' | 'code' | 'diff' | 'mockup';

interface LandingFile {
  name: string;
  reviewUrl?: string;
  openCount: number;
}

interface LandingArtifact {
  kind: ArtifactKind;
  /** Display name (file basename, workspace title, or docId fallback). */
  name: string;
  /** docId for standalone artifacts; workspaceId for workspaces. */
  id: string;
  reviewUrl?: string;
  openCount: number;
  threadCount: number;
  lastActivity: number;
  /** Nested file list (workspace artifacts only). */
  files?: LandingFile[];
}

// Glyph + human label per artifact kind. The glyph keeps the kinds visually
// distinct at a glance; the label disambiguates for screen readers / clarity.
const ARTIFACT_KIND: Record<ArtifactKind, { glyph: string; label: string }> = {
  workspace: { glyph: '📁', label: 'folder' },
  markdown: { glyph: '📄', label: 'markdown' },
  code: { glyph: '⟨⟩', label: 'code' },
  diff: { glyph: '±', label: 'diff' },
  mockup: { glyph: '🖼', label: 'mockup' },
};

function flattenTreeFileNodes(node: WorkspaceDirNode | WorkspaceFileNode): WorkspaceFileNode[] {
  if (node.type === 'file') return [node];
  return node.children.flatMap(flattenTreeFileNodes);
}

/** Flatten a workspace tree into a sorted file list for the landing nesting. */
function flattenWorkspaceFiles(node: WorkspaceDirNode | WorkspaceFileNode): LandingFile[] {
  if (node.type === 'file') {
    return [{ name: node.relPath, reviewUrl: node.reviewUrl, openCount: node.openCount }];
  }
  return node.children.flatMap(flattenWorkspaceFiles);
}

/**
 * The `/` model's inputs, computed from the live stores.
 *
 * `lastActivity` is the newest REAL event on the board: a task mutation
 * (`task.updatedAt` — bumped by every transition, assignment, evidence and
 * body rewrite), a comment on a task's discussion (`thread.lastActivity` on
 * the `task:<id>` room), or the board's creation. Deliberately
 * NOT `meta.lastActivityAt`, which is the `.ydoc` mtime wearing an activity
 * label — see rule 1 in the header of `landing.ts`.
 */
export function collectLandingWorkspaces(
  docStore: DocStore,
  taskStore: TaskStore,
  // The landing route passes Home's own counter here (`reviewItemsFor` +
  // `homeQueueTotal`, both closure-bound in createServer), so the chip and
  // the queue it opens are one computation, not two that can drift.
  waitingOf?: (ws: BoardWorkspace) => number,
): LandingWorkspaceInput[] {
  return taskStore.listWorkspaces().map((ws) => {
    let last = ws.createdAt;
    // Archived rows included: archiving IS activity on this board, and a
    // reading that dropped the row afterwards would step the timestamp
    // backwards the moment somebody tidied up.
    for (const task of taskStore.listTasks(ws.id, { includeArchived: true })) {
      if (task.updatedAt > last) last = task.updatedAt;
      for (const thread of docStore.listThreads(`task:${task.id}`)) {
        if (thread.lastActivity > last) last = thread.lastActivity;
      }
    }
    // A retired board contributes NO review items to this page — no chip on
    // its row, nothing into the bar or the Review-all chain. Retiring is the
    // owner saying "get this out of my way", and every one of those surfaces
    // steering the reader back in contradicts the act. Filtered here at the
    // source, not in the renderer: the count is simply never computed, so no
    // later consumer of this model can reintroduce it. Un-retiring brings
    // the items straight back — nothing about them was touched.
    const waiting = !isRetired(ws) && waitingOf ? waitingOf(ws) : 0;
    return {
      id: ws.id,
      name: ws.name,
      lastActivity: last,
      ...(isRetired(ws) ? { retired: true } : {}),
      ...(waiting > 0 ? { waiting } : {}),
    };
  });
}

/** Every project owner that has at least one attachment — the links behind
 *  the attachments fold. Names only; the artifacts stay on the project page. */
export function collectLandingProjects(
  docStore: DocStore,
): Array<{ owner: string; label: string }> {
  const owners = new Set<string>();
  for (const meta of docStore.list()) {
    // Infrastructure, not attachment content: the shared hub-feedback doc exists
    // on every install from startup, and `ws:`/`task:` rooms are surfaces the
    // server owns for the boards the page already lists.
    if (meta.docId === BOARD_FEEDBACK_DOC_ID) continue;
    if (meta.docId.startsWith('ws:') || meta.docId.startsWith('task:')) continue;
    owners.add(meta.owner || 'ungrouped');
  }
  return Array.from(owners, (owner) => ({ owner, label: projectLabel(owner) }));
}

/**
 * One project's artifacts, built only when somebody opens that project.
 *
 * This is the old whole-server index, narrowed to a single owner: the same
 * rollup of workspace members into one expandable row, the same per-artifact
 * open counts. What changed is WHEN it runs — `buildWorkspaceTree` per
 * workspace and a nested file list per artifact was the bulk of both the 910
 * KB and the per-request work on a page that mostly nobody scrolled.
 */
export function buildProjectArtifacts(
  docStore: DocStore,
  decorate: <T extends { docId: string; type: DocType; sourceUrl?: string }>(
    meta: T,
  ) => T & { reviewUrl?: string },
  owner: string,
): LandingArtifact[] {
  const workspaceArtifacts = new Map<string, LandingArtifact>();
  const artifacts: LandingArtifact[] = [];

  for (const meta of docStore.list()) {
    if (meta.docId === BOARD_FEEDBACK_DOC_ID) continue;
    if (meta.docId.startsWith('ws:') || meta.docId.startsWith('task:')) continue;
    if ((meta.owner || 'ungrouped') !== owner) continue;

    // Both from the doc's index row rather than its thread map — same
    // numbers, without decoding every doc this owner has on every render.
    const openCount = docStore.threadCounts(meta.docId).open;
    // Thread activity, never `meta.lastActivityAt` — see the header note in
    // landing.ts. That field is the `.ydoc` mtime and a snapshot rewrite
    // refreshes it, so it ranks by persistence noise.
    const lastActivity = docStore.lastThreadActivity(meta.docId);

    if (meta.workspaceId) {
      let art = workspaceArtifacts.get(meta.workspaceId);
      if (!art) {
        const tree = docStore.buildWorkspaceTree(meta.workspaceId);
        const files = flattenWorkspaceFiles(tree.tree);
        // Clicking the workspace opens its entry file directly (the biggest
        // change for a diff review, first file otherwise); expansion is a
        // separate affordance in the renderer.
        const treeFiles = flattenTreeFileNodes(tree.tree);
        const entry = treeFiles.reduce(
          (best, f) =>
            (f.diffAdditions ?? 0) + (f.diffDeletions ?? 0) >
            (best?.diffAdditions ?? 0) + (best?.diffDeletions ?? 0)
              ? f
              : best,
          treeFiles[0],
        );
        art = {
          kind: 'workspace',
          name: meta.workspaceId,
          id: meta.workspaceId,
          reviewUrl: entry?.reviewUrl,
          openCount: tree.totalOpen,
          threadCount: 0,
          lastActivity: 0,
          files,
        };
        workspaceArtifacts.set(meta.workspaceId, art);
        artifacts.push(art);
      }
      // A diff member marks the whole workspace as a diff review (members can
      // also include plain 'code' context docs — any diff doc wins).
      if (meta.type === 'diff') art.kind = 'diff';
      art.threadCount += docStore.threadCounts(meta.docId).total;
      if (lastActivity > art.lastActivity) art.lastActivity = lastActivity;
      continue;
    }

    const decorated = decorate(meta);
    artifacts.push({
      kind: (meta.type as ArtifactKind) ?? 'markdown',
      name: meta.sourceUrl ? basenameOf(meta.sourceUrl) : meta.title || meta.docId,
      id: meta.docId,
      reviewUrl: decorated.reviewUrl,
      openCount,
      threadCount: docStore.threadCounts(meta.docId).total,
      lastActivity,
    });
  }

  artifacts.sort((a, b) => {
    if (a.openCount !== b.openCount) return b.openCount - a.openCount;
    if (a.lastActivity !== b.lastActivity) return b.lastActivity - a.lastActivity;
    return a.name.localeCompare(b.name);
  });
  return artifacts;
}

function basenameOf(p: string): string {
  let s = p;
  try {
    if (/^https?:\/\//.test(s)) s = new URL(s).pathname;
  } catch {}
  const m = s.match(/[^/\\]+$/);
  return m ? m[0] : s;
}

/** Display label for a project owner (cwd) — its basename, or the raw key. */
function projectLabel(owner: string): string {
  if (owner === 'ungrouped') return 'Ungrouped';
  return basenameOf(owner) || owner;
}

function renderLandingFile(f: LandingFile): string {
  const link = f.reviewUrl
    ? `<a href="${escape(f.reviewUrl)}">${escape(f.name)}</a>`
    : escape(f.name);
  const badge = f.openCount > 0 ? `<span class="badge badge-open">${f.openCount} open</span>` : '';
  return `<li class="ws-file"><span class="ws-file-name">${link}</span>${badge}</li>`;
}

function renderLandingArtifact(a: LandingArtifact): string {
  const kind = ARTIFACT_KIND[a.kind];
  const openBadge =
    a.openCount > 0
      ? `<span class="badge badge-open">${a.openCount} open</span>`
      : a.threadCount > 0
        ? `<span class="badge badge-resolved">all resolved</span>`
        : '';
  const kindBadge = `<span class="badge badge-kind">${kind.glyph} ${escape(kind.label)}</span>`;
  const activityLine =
    a.lastActivity > 0
      ? `<div class="meta">last activity ${escape(formatRelative(a.lastActivity))}</div>`
      : '';

  if (a.files) {
    const fileCount = a.files.length;
    const files = a.files.map(renderLandingFile).join('');
    const nameLink = a.reviewUrl
      ? `<a href="${escape(a.reviewUrl)}">${escape(a.name)}</a>`
      : escape(a.name);
    // Clicking the NAME opens the review's entry file; the caret + file
    // count is the (separate) expansion affordance for the nested list.
    return `<li class="artifact ${a.openCount > 0 ? 'has-open' : ''}">
      <div class="row">
        <span class="art-glyph">${kind.glyph}</span>
        <span class="art-name">${nameLink}</span>
        <span class="badges">${openBadge}<span class="badge badge-kind">${escape(kind.label)}</span></span>
      </div>
      <details class="ws-details">
        <summary><span class="art-sub">${fileCount} file${fileCount === 1 ? '' : 's'}</span></summary>
        <ul class="ws-files">${files || '<li class="ws-file empty">(no files)</li>'}</ul>
      </details>
      ${activityLine}
    </li>`;
  }

  const link = a.reviewUrl
    ? `<a href="${escape(a.reviewUrl)}">${escape(a.name)}</a>`
    : escape(a.name);
  return `<li class="artifact ${a.openCount > 0 ? 'has-open' : ''}">
    <div class="row">
      <span class="art-glyph">${kind.glyph}</span>
      <span class="art-name">${link}</span>
      <span class="badges">${openBadge}${kindBadge}</span>
    </div>
    ${activityLine}
  </li>`;
}

/**
 * Shared chrome for the two server-rendered pages (`/` and `/projects/<owner>`).
 *
 * Mobile is load-bearing here — this is the page Bryan lands on from his
 * phone. Every rule is authored for a 430px viewport first: single column, no
 * fixed widths, and `min-width: 0` on every flex child that holds prose, which
 * is the flex twin of the `minmax(0, 1fr)` grid footgun in
 * docs/product/design-mobile.md. Nothing here reaches into styles.css: the
 * landing page is server-rendered and owns its own styles, so the client
 * bundle's cascade cannot move it.
 */
const LANDING_CSS = `
*{box-sizing:border-box}
body{font:15px/1.55 system-ui,-apple-system,sans-serif;margin:0 auto;max-width:760px;padding:20px 14px 40px;color:#1b1f23;overflow-wrap:anywhere}
h1{font-size:20px;margin:0 0 2px}
h2{font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#57606a;margin:26px 0 8px;display:flex;flex-wrap:wrap;align-items:baseline;gap:8px}
.count{font-size:11px;font-weight:500;letter-spacing:0;text-transform:none;color:#8b95a1}
.summary{color:#6e7781;font-size:12px;margin:0 0 4px}
ul{padding:0;list-style:none;margin:0}
a{color:#2e7dd7;text-decoration:none}
a:hover{text-decoration:underline}
.grp{border-bottom:1px solid #f0f2f4}
.grp-link{display:block;padding:10px 4px;color:inherit;min-height:44px}
.grp-link:hover{text-decoration:none;background:#f8f9fb}
.grp-row{display:flex;align-items:baseline;gap:8px}
.grp-name{flex:1;min-width:0;font-weight:600;font-size:15px;color:#2e7dd7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.grp-meta{color:#8b95a1;font-size:12px;margin-top:2px}
.grp-flex{display:flex;align-items:center;gap:8px}
.grp-flex .grp-link{flex:1;min-width:0}
.needs{flex-shrink:0;display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600;color:#bf5b16;background:#fff1e6;border-radius:99px;padding:6px 12px;min-height:32px}
.needs:hover{text-decoration:none;background:#ffe7d1}
.needs .n{background:#e36f1e;color:#fff;border-radius:99px;font-size:11px;min-width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;padding:0 5px}
.allbar{display:flex;align-items:center;gap:10px;background:#fff8f2;border:1px solid #f5d9c2;border-radius:10px;padding:10px 14px;margin:10px 0 14px}
.allsum{flex:1;min-width:0;font-size:13px;font-weight:600;color:#8a4a12}
.allgo{flex-shrink:0;font-size:13px;font-weight:600;padding:7px 4px}
.badge{font-size:10.5px;padding:1.5px 7px;border-radius:99px;background:#f6f8fa;color:#6e7781;font-weight:500;flex-shrink:0}
.badge-open{background:#fff1e6;color:#bf5b16}
.badge-resolved{background:#e8f5ed;color:#2da44e}
.badge-kind{background:#f6f8fa;color:#8b95a1}
.badges{display:flex;gap:4px;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end}
li.artifact{padding:9px 0;border-bottom:1px solid #f3f4f6}
li.artifact.has-open{border-left:3px solid #e36f1e;padding-left:10px;margin-left:-13px}
.row{display:flex;align-items:baseline;gap:8px}
.art-glyph{flex-shrink:0;font-size:13px;width:1.4em;text-align:center}
.art-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 36px minimum tap target (design-mobile.md). An inline link is ~23px tall,
   so every link a thumb aims at gets vertical padding rather than a bigger
   font — this page is read on a phone. */
.art-name a{font-weight:600;display:inline-block;padding:7px 0}
.art-sub{color:#8b95a1;font-size:11px;flex-shrink:0}
.meta{color:#8b95a1;font-size:11px;margin-top:3px;padding-left:1.4em}
details > summary{display:flex;align-items:baseline;gap:8px;cursor:pointer;list-style:none;min-height:36px;align-items:center}
details > summary::-webkit-details-marker{display:none}
details > summary::before{content:'\\25B8';color:#8b95a1;font-size:11px;flex-shrink:0}
details[open] > summary::before{content:'\\25BE'}
/* The landing page's folded sections (inactive workspaces, attachments).
   Styled like the h2s so a fold reads as a section heading you can open —
   quiet on purpose: the page is the active list, the folds are the archive. */
.fold{margin-top:26px}
.fold > summary{font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#57606a}
.ws-files{margin:6px 0 0 1.8em;border-left:1px solid #eef0f2;padding-left:10px}
.ws-file{display:flex;align-items:baseline;gap:8px;padding:3px 0}
.ws-file-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.ws-file-name a{display:inline-block;padding:9px 0}
.ws-file.empty{color:#8b95a1;font-style:italic}
.empty{color:#6e7781;padding:18px 0;font-style:italic;font-size:13px}
.back{font-size:13px;display:inline-block;padding:8px 0;margin-bottom:4px}
footer{margin-top:28px;color:#8b95a1;font-size:11px}
`;

function landingShell(
  title: string,
  body: string,
  sentry: BrowserSentryConfig | null,
  assets: AssetManifest = {},
): string {
  const sentryTags = sentryHeadTags(sentry, 'landing', assets);
  const sentryMeta = sentryTags ? `\n${sentryTags}` : '';
  // The manifest belongs here most of all: `/` is the manifest's own
  // `start_url`, so this is the page a Home Screen install lands on and the
  // most likely page somebody installs FROM.
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title>
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="theme-color" content="#2e7dd7">${sentryMeta}
<style>${LANDING_CSS}</style>
${body}
<footer>POST /api/docs · /widget.iife.js · /demos/mockup</footer>`;
}

function renderLandingWorkspaceRow(w: LandingWorkspaceRow): string {
  // Thread/task activity, never `meta.lastActivityAt` — the collector's
  // header says why. The whole row is the tap target, not the name inside
  // it: an inline text link is ~21px tall, under the 36px floor in
  // docs/product/design-mobile.md, and this is the page Bryan opens on a
  // phone.
  const activity =
    w.lastActivity > 0 ? `active ${formatRelative(w.lastActivity)}` : 'no activity yet';
  // The chip is a SIBLING anchor, not a child — a nested <a> is invalid HTML
  // and browsers split it unpredictably. The row opens Home; the chip opens
  // the same Home with the walkthrough already running (?walk=1), so
  // answering never needs a second tap to find the queue.
  const chip =
    (w.waiting ?? 0) > 0
      ? `<a class="needs" href="${escape(`${w.href}?walk=1`)}"><span class="n">${w.waiting}</span> for you</a>`
      : '';
  return `<li class="grp grp-flex"><a class="grp-link" href="${escape(w.href)}">
    <div class="grp-row"><span class="grp-name">${escape(w.name)}</span></div>
    <div class="grp-meta">${escape(activity)}</div>
  </a>${chip}</li>`;
}

function renderLandingProjectLink(p: LandingProjectLink): string {
  return `<li class="grp"><a class="grp-link" href="${escape(p.href)}">
    <div class="grp-row"><span class="grp-name">${escape(p.label)}</span></div>
  </a></li>`;
}

export function renderLanding(
  model: LandingModel,
  sentry: BrowserSentryConfig | null,
  notesWorkspaceName: string,
  assets: AssetManifest = {},
): string {
  const days = Math.round(model.windowMs / 86_400_000);
  // Retired boards are NOT in this denominator. "Nothing active, 3 inactive
  // below" has to mean three rows a reader can go and look at; counting
  // deliberately stood-down boards in it would make the empty state overstate
  // what is still live.
  const total = model.active.length + model.inactive.length;
  // A cut list states what it cut: the empty state names the denominator,
  // and the inactive fold carries its count — "An empty list is a clearance
  // only if you also render the denominator" (docs/process/learnings.md).
  const active =
    model.active.length === 0
      ? total === 0
        ? '<div class="empty">No workspaces yet.</div>'
        : `<div class="empty">Nothing active in the last ${days} days (${total} inactive below).</div>`
      : `<ul>${model.active.map(renderLandingWorkspaceRow).join('')}</ul>`;
  const inactive =
    model.inactive.length === 0
      ? ''
      : `<details class="fold"><summary>Inactive workspaces <span class="count">${model.inactive.length}</span></summary>
<ul>${model.inactive.map(renderLandingWorkspaceRow).join('')}</ul></details>`;
  // Folded, not hidden — a retired board is still readable, which is the
  // whole difference between retiring one and deleting it. The count is the
  // denominator the empty state above deliberately leaves out.
  const retired =
    model.retired.length === 0
      ? ''
      : `<details class="fold"><summary>Retired workspaces <span class="count">${model.retired.length}</span></summary>
<ul>${model.retired.map(renderLandingWorkspaceRow).join('')}</ul></details>`;
  // The attachment index stays reachable — one fold of per-project links,
  // not a browser. The "hundreds of bound attachments" live behind
  // /projects/<owner>, fetched only when somebody opens one.
  const projects =
    model.projects.length === 0
      ? ''
      : `<details class="fold"><summary>Attachments by project <span class="count">${model.projects.length}</span></summary>
<ul>${model.projects.map(renderLandingProjectLink).join('')}</ul></details>`;
  // Every row with a waiting count, page order (active first, then the
  // quiet fold — an item on a quiet board still waits). The bar totals them
  // and "Review all" starts the walkthrough in the most recently active one,
  // handing the rest over via ?then= so the client chains the queues
  // without coming back here between boards. Retired boards are OUT — the
  // collector never computes a waiting count for one, so they can carry no
  // chip, no share of the total, and no place in the chain; this filter is
  // the belt to that suspender.
  const waitingRows = [...model.active, ...model.inactive].filter((w) => (w.waiting ?? 0) > 0);
  const waitingTotal = waitingRows.reduce((sum, w) => sum + (w.waiting ?? 0), 0);
  const firstWaiting = waitingRows[0];
  const allHref = firstWaiting
    ? `${firstWaiting.href}?walk=1${
        waitingRows.length > 1
          ? `&then=${waitingRows
              .slice(1)
              .map((w) => encodeURIComponent(w.id))
              .join(',')}`
          : ''
      }`
    : '';
  const allbar = firstWaiting
    ? `<div class="allbar"><span class="allsum">${waitingTotal} waiting on you${
        waitingRows.length > 1 ? ` across ${waitingRows.length} workspaces` : ''
      }</span><a class="allgo" href="${escape(allHref)}">Review all ›</a></div>`
    : '';
  return landingShell(
    'Workspaces',
    `<h1>Workspaces</h1>
<div class="summary">Active in the last ${days} days, most recent first</div>
<meeting-banner workspace-name="${escape(notesWorkspaceName)}"></meeting-banner>
<script type="module" src="${assetHref(assets, 'landing.js')}"></script>
${allbar}
${active}
${inactive}
${retired}
${projects}`,
    sentry,
    assets,
  );
}

/** The "artifacts on demand" half: one project's contents, fetched only when
 *  somebody asks for that project. Keeping this off `/` is what took the
 *  landing response from ~910 KB to a few KB — the nested per-file lists were
 *  most of the bytes and none of the reason anyone opened the page. */
export function renderProjectPage(
  owner: string,
  artifacts: LandingArtifact[],
  sentry: BrowserSentryConfig | null,
  assets: AssetManifest = {},
): string {
  const body =
    artifacts.length === 0
      ? '<div class="empty">No artifacts in this project.</div>'
      : `<ul>${artifacts.map(renderLandingArtifact).join('')}</ul>`;
  const open = artifacts.reduce((sum, a) => sum + a.openCount, 0);
  return landingShell(
    `${projectLabel(owner)} · Workspaces`,
    `<a class="back" href="/">← all workspaces</a>
<h1>${escape(projectLabel(owner))}</h1>
<div class="summary">${escape(owner)}</div>
<div class="summary">${artifacts.length} artifact${artifacts.length === 1 ? '' : 's'} · ${open} open thread${open === 1 ? '' : 's'}</div>
${body}`,
    sentry,
    assets,
  );
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.round(diff / 86_400_000)}d ago`;
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Viewport presets for ?mobile=<preset>. CSS px sizes (logical).
const DEVICE_PRESETS: Record<string, { w: number; h: number; label: string }> = {
  iphone16pm: { w: 440, h: 956, label: 'iPhone 16 Pro Max' },
  iphone16: { w: 393, h: 852, label: 'iPhone 16' },
  iphone15: { w: 393, h: 852, label: 'iPhone 15' },
  iphonese: { w: 375, h: 667, label: 'iPhone SE' },
  pixel8: { w: 412, h: 915, label: 'Pixel 8' },
};

export function renderDeviceFrame(presetName: string, url: URL): string {
  const preset = DEVICE_PRESETS[presetName] ?? DEVICE_PRESETS.iphone16pm!;
  // Build the inner URL with the mobile param stripped to avoid recursion
  const innerParams = new URLSearchParams(url.searchParams);
  innerParams.delete('mobile');
  const innerQs = innerParams.toString();
  const innerUrl = `${url.pathname}${innerQs ? `?${innerQs}` : ''}`;
  const asParam = url.searchParams.get('as') ?? 'bryan';
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<title>${escape(preset.label)} · ${escape(url.pathname)}</title>
<style>
  html, body { margin: 0; height: 100%; background: #1e2228; font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif; color: #eee; }
  body { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; padding: 8px; box-sizing: border-box; overflow: auto; }
  .bar { display: flex; flex-wrap: wrap; gap: 6px; font-size: 11px; color: #cfd3d9; }
  .bar .label { background: rgba(0,0,0,0.5); padding: 3px 9px; border-radius: 99px; }
  .bar a { color: #8fbfff; text-decoration: none; background: rgba(0,0,0,0.5); padding: 3px 9px; border-radius: 99px; }
  .bar a:hover { background: rgba(0,0,0,0.75); }
  .bar a.current { background: #8fbfff; color: #1e2228; }
  .device {
    width: ${preset.w}px;
    height: ${preset.h}px;
    background: #fff;
    border: 1px solid #3a3e45;
    border-radius: 18px;
    box-shadow: 0 14px 40px rgba(0,0,0,0.45);
    overflow: hidden;
    flex: 0 0 auto;
  }
  .device iframe {
    width: 100%;
    height: 100%;
    border: 0;
    display: block;
    background: #fff;
  }
</style>
</head><body>
<div class="bar">
  <span class="label">${escape(preset.label)} · ${preset.w}×${preset.h}</span>
  <a href="?as=${escape(asParam)}">← exit</a>
  <a class="${presetName === 'iphone16pm' ? 'current' : ''}" href="?mobile=iphone16pm&as=${escape(asParam)}">16 Pro Max</a>
  <a class="${presetName === 'iphone16' ? 'current' : ''}" href="?mobile=iphone16&as=${escape(asParam)}">16</a>
  <a class="${presetName === 'iphonese' ? 'current' : ''}" href="?mobile=iphonese&as=${escape(asParam)}">SE</a>
  <a class="${presetName === 'pixel8' ? 'current' : ''}" href="?mobile=pixel8&as=${escape(asParam)}">Pixel 8</a>
</div>
<div class="device"><iframe src="${escape(innerUrl)}" allow="clipboard-write"></iframe></div>
</body></html>`;
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return map[c] ?? c;
  });
}
