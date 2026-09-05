/**
 * Everything this deployment reads out of its environment and its argv,
 * resolved once into one typed value.
 *
 * It is the half of the composition root that decides WHAT to build. The
 * other half — `server-deps.ts` — builds it. Splitting them is what lets a
 * reader answer "where does this setting come from" without reading past a
 * hundred lines of adapter construction, and it is why the misconfiguration
 * warnings live here: the message is part of resolving the value, not a
 * separate reporting pass.
 *
 * Nothing here constructs an adapter, opens a socket or reads the Keychain.
 * The one thing it does beyond reading is REFUSE: a `CF_SHARE_MAX_TTL` the
 * grammar cannot read exits the process, because a silently absent ceiling is
 * the failure this validation exists to prevent.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { positiveEnvDuration, readRenamedEnv } from '@feedback/core/env-names';
import { clientReleaseStatus, resolveClientDists } from './client-release.ts';
import { resolveDataDir } from './data-dir.ts';
import { signInToWriteFromEnv } from './middleware/write-gate.ts';
import { normalizePublicBaseUrl } from './public-host.ts';
import { normalizeRecallCallbackHost } from './recall.ts';
import { TTL_FORMAT_HINT, parseTtl } from './share/ttl.ts';

/** Reads one `--name value` / `--name=value` flag out of argv. Parsing stays
 *  in `bin.ts`, which owns the command line; this file is handed the reader. */
export type ArgReader = (name: string, fallback?: string) => string | undefined;

export function resolveServerConfig(opts: {
  env: NodeJS.ProcessEnv;
  repoRoot: string;
  arg: ArgReader;
}) {
  const { env, repoRoot, arg } = opts;
  const requestedPort = Number(arg('port', env.PORT ?? '8787'));
  // Always a path: the flag wins, else the resolver's answer. It used to be
  // `string | undefined`, which every later reader repeated the resolver call
  // to work around.
  const dataDir = arg('data-dir') ?? resolveDataDir(env, repoRoot);

  // The bind address. Deliberately `undefined` unless a caller passes
  // `--host` — Bun's own default (the wildcard, every interface) is what
  // prod needs (tailnet + LAN reach it) and what this resolver must not
  // change. `scripts/staging.ts` is the caller that passes a value,
  // defaulting IT to loopback so a dev/staging instance is reachable only
  // from this machine unless someone opts into the wildcard with
  // `--host 0.0.0.0`.
  const hostname = arg('host');

  // Which browser bundles to serve. PROD passes published release directories
  // (see client-release.ts) so the served client is NOT read out of a git
  // working tree someone may be editing or switching branches in. Unset — `bun
  // run dev`, `bun run staging`, a bare bin.ts — falls back to this checkout's
  // own dist, which is what those want.
  //
  // The flag and the variable spell the app differently on purpose. The flag
  // is internal — `scripts/serve.ts` is its only caller and it restarts with
  // this file — so it followed the package rename. The variable is a launch
  // config, the one input this repo cannot restart on somebody's behalf, and
  // it already carries an `LF_MARKDOWN_APP_DIST` fallback (`env-names.ts`);
  // renaming it would end that chain for a straggler that the sweep missed.
  // Rename it in the same flag day that retires the `LF_` spellings.
  const { widget: widgetDist, markdownApp: markdownAppDist } = resolveClientDists({
    widgetDist: arg('widget-dist') ?? readRenamedEnv(env, 'CW_WIDGET_DIST'),
    markdownAppDist: arg('workspaces-app-dist') ?? readRenamedEnv(env, 'CW_MARKDOWN_APP_DIST'),
    repoRoot,
  });
  const demosDir = pathOrNull(join(repoRoot, 'demos'));

  // The external origin this deployment is reached on, when something in front
  // terminates TLS. Validated HERE, at boot, so a typo is a startup failure
  // somebody reads rather than a server that runs happily while handing out
  // links to an origin nobody meant to publish. Unset is the normal case and
  // falls back to `http://<discovered host>:<port>`.
  const publicBaseUrlOverride =
    normalizePublicBaseUrl(arg('public-base-url') ?? readRenamedEnv(env, 'CW_PUBLIC_BASE_URL')) ??
    undefined;

  // The release root this deployment PUBLISHES into, which is what lets the
  // board say "your browser is running a client from three days ago because the
  // build has been failing". PROD passes it (scripts/serve.ts --no-watch);
  // nothing else may, because dev and staging serve their own checkout's dist
  // while sharing this machine's default release root — they would report prod's
  // deploy state as their own. Same seam rule as the plugin refresher.
  const clientReleaseRootDir = arg('client-release-root') ?? null;

  const MINUTE_MS = 60_000;
  const HOUR_MS = 60 * MINUTE_MS;

  const sentryDsn = readRenamedEnv(env, 'CW_SENTRY_DSN')?.trim();

  // Server-side Sentry: traces + error capture for THIS process, independent
  // of the `sentryDsn` handed to `createServer` below (that one only ever
  // reaches the browser as a meta tag — see sentry.ts for why the two are
  // deliberately not the same init path). Same env var, same "no DSN, no SDK,
  // no outbound request" contract. The release is the deploy this process is
  // running, read the same way the board reads a peer's own version: from the
  // published release's provenance file, when this start is one (prod). Dev
  // and staging run straight from a checkout with no release directory, so
  // `sourceRef` is absent there — Sentry just omits the release tag rather
  // than guessing at one.
  // Resolved once and shared with the BROWSER (`sentryRelease` below), so a
  // page load and the server spans it continues carry the same release string
  // — that is the whole point of naming a deploy rather than a bundle hash.
  const releaseSourceRef = clientReleaseRootDir
    ? clientReleaseStatus(clientReleaseRootDir).sourceRef
    : null;

  // How long ready, agent-owned work may sit untouched before the board wakes
  // its lead (ready-nudge.ts). Minutes rather than ms because it is a number an
  // operator types.
  const readyNudgeIdleMs = positiveEnvDuration(env, 'CW_READY_NUDGE_MINUTES', MINUTE_MS);

  // How long a row may go untouched before the board tells its lead it has
  // STALLED (stall-nudge.ts) — a different question from the one above, which
  // asks whether ready work has been picked up.
  const stallNudgeQuietMs = positiveEnvDuration(env, 'CW_STALL_NUDGE_MINUTES', MINUTE_MS);

  // How many quiet windows a row with a WATCHING builder dispatch gets before
  // the board calls its builder silent (stall-gate.ts). A bare multiplier —
  // unit 1 — rather than its own duration, so it scales whatever the quiet
  // window above is set to.
  const stallBuilderSilentMultiplier = positiveEnvDuration(env, 'CW_BUILDER_SILENT_MULTIPLIER', 1);

  // How long the board waits before saying the SAME unchanged stall again
  // (stall-nudge.ts). Hours, not minutes, because this one is priced in a
  // woken lead's whole turn rather than in a tick: a wake costs the lead
  // session real tokens whether or not anything changed, so the repeat window
  // is the knob that sets the standing floor on that cost. Tunable without a
  // release for exactly that reason.
  const stallNudgeRepeatMs = positiveEnvDuration(env, 'CW_STALL_REPEAT_HOURS', HOUR_MS);

  // How long a review item the quality gate HELD may stand before the stall
  // loop complains to its filer and then to the lead (stall-gate.ts). Minutes,
  // like the stall window, and much shorter than it: a held item's filer was
  // told in the same tool result, and revising is one call.
  const heldReviewItemMs = positiveEnvDuration(env, 'CW_HELD_ITEM_MINUTES', MINUTE_MS);

  // How long a row the lead was ALREADY TOLD ABOUT may stay stuck before the
  // board files over the lead's head, onto the reader's own queue
  // (stall-escalation.ts). Minutes, like the stall window, and tunable
  // without a release for the same reason the repeat window is: it decides
  // how often a person is interrupted by their own board.
  const stallEscalateMs = positiveEnvDuration(env, 'CW_STALL_ESCALATE_MINUTES', MINUTE_MS);

  // Extra hostnames to treat as LOCAL. Loopback, the tailnet name, this
  // machine's LAN names, and private IPv4 ranges are detected automatically;
  // this covers anything we can't detect (a reverse proxy in front, a custom
  // /etc/hosts alias). Everything else is denied — see middleware/host-guard.ts.
  /**
   * Browser origins allowed to call the API cross-origin, beyond this machine's
   * own names — which are allowed automatically, so the widget on a local dev
   * server needs no configuration. Set this only for a dev server on a DIFFERENT
   * machine. Without it the option would be unreachable from the shipped binary,
   * and a config knob nobody can turn is the same bug as not having one.
   *
   * UNDERSTAND WHAT THIS GRANTS: an origin listed here can read ANY FILE this
   * process can read. A page on an allowed origin may open
   * `/y/<id>?type=mockup&sourceUrl=/abs/path`, which auto-creates the doc, then
   * fetch `/mockup/<id>`. That is inherent to the local trust model — loopback
   * already has it — but this knob hands the same primitive to another machine,
   * and those origins are also the only ones granted
   * Access-Control-Allow-Private-Network. List an origin only if you would
   * equally trust it with your home directory.
   */
  const allowedOrigins = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  /**
   * CW_SHARING_DISABLED=1 — external sharing starts OFF and the runtime toggle
   * (`POST /api/share/enabled`, the `set_sharing_enabled` MCP tool) refuses to
   * reopen it. Use this while a security review is in flight: it is the one
   * setting nothing the server exposes can undo, so a compromised or
   * misbehaving caller cannot reopen the door.
   *
   * For an ordinary on/off, leave this unset and use the runtime toggle — that
   * state persists in <dataDir>/sharing.json across restarts.
   */
  const sharingEnvLocked = ['1', 'true', 'yes'].includes(
    (readRenamedEnv(env, 'CW_SHARING_DISABLED') ?? '').trim().toLowerCase(),
  );

  /**
   * Email-keyed identity is IN EFFECT. Default off, and off means a request
   * with a session cookie is attributed exactly as it is attributed today.
   * The `/api/auth/*` routes are mounted either way — see ServerOptions.
   */
  const requireEmailAuth = ['1', 'true', 'yes'].includes(
    (env.CW_REQUIRE_EMAIL_AUTH ?? '').trim().toLowerCase(),
  );

  /**
   * A browser must be SIGNED IN to write. Default ON (owner decision on the
   * security row, 2026-09-02: *"flip on and add widget sign in"*);
   * `CW_REQUIRE_SIGNIN_TO_WRITE=0` turns it off, and off means an unsigned
   * browser writes as it did before the gate existed. Independent of
   * `CW_REQUIRE_EMAIL_AUTH`, which governs what a session MEANS rather than
   * whether one is needed — see ServerOptions and middleware/write-gate.ts.
   *
   * It was default OFF for one reason: a widget embed without `auth-offer` had
   * no way to sign in, so flipping the gate would have refused every comment
   * from every mockup and dev page with nothing on screen that could fix it.
   * The widget now asks `GET /api/auth/session` on load and offers the
   * popup-token handshake whenever the answer is `signInToWrite:true` — and
   * again as the backstop when a write comes back `sign_in_required` — so the
   * refusal always arrives with the control that lifts it. The board app has
   * carried its own prompt since the gate shipped. Agents are untouched: the
   * gate reads `Origin` and `Sec-Fetch-*`, which no MCP tool, hook, curl or
   * webhook sends. The binding routes are closed to browsers regardless of
   * this flag — see write-gate.ts, `browserCannotBindBody`.
   */
  const requireSignInToWrite = signInToWriteFromEnv(env.CW_REQUIRE_SIGNIN_TO_WRITE);

  /**
   * Whether the two agent-id-keyed routes REFUSE a caller that presents no
   * `at1` agent token: `GET /api/agents/<id>/watches` and
   * `GET /events/agent/<id>`.
   *
   * Default OFF, and that is the deprecation window rather than an opinion
   * about the gate. Presenting the token needs a client change, and the MCP
   * child that must make it ships in a plugin bundle a peer updates on their
   * own schedule; refusing an un-updated child would take its durable watch
   * restore and its whole event stream away mid-session, which is the exact
   * outage `/events/agent/` exists to prevent. So an un-tokened caller is
   * served with one logged warning until the fleet is past 0.1.164, and
   * `CW_REQUIRE_AGENT_TOKEN=1` closes it.
   *
   * Nothing about the SHAPE gate is deferred: not-a-browser, loopback-only
   * and not-through-the-edge are enforced on both routes regardless of this
   * flag, because every shipped MCP child already satisfies all three. See
   * auth/agent-token.ts for which door each layer closes.
   */
  const requireAgentToken = ['1', 'true', 'yes', 'on'].includes(
    (env.CW_REQUIRE_AGENT_TOKEN ?? '').trim().toLowerCase(),
  );

  /**
   * ACCESS-ONLY browser hosts. Default ON (Bryan, 2026-09-02: *"Let's make
   * everyone go through cloudflare access. No internal hole."*).
   *
   * This is the setting that says WHICH hostnames are browser-facing, and the
   * answer it gives is "every one that is not loopback". On, the only zone
   * that reaches this server without a verified Cloudflare Access identity is
   * a process on the box: a loopback Host from a loopback socket peer. The
   * tailnet name, this machine's LAN names and every `TRUSTED_HOSTS` entry
   * stop being an unauthenticated door — they answer 403 unknown_host unless
   * they are also listed as an Access host. See rule 3 in
   * middleware/host-guard.ts.
   *
   * `CW_ACCESS_ONLY_BROWSER_HOSTS=0` (or false/no/off) restores the old
   * classification. It is spelled the same way as `CW_REQUIRE_SIGNIN_TO_WRITE`
   * — only an explicit falsey word turns it off — because a typo must fail
   * CLOSED, and an unset variable is the secure default rather than the old
   * behaviour.
   */
  const accessOnlyBrowserHosts = !['0', 'false', 'no', 'off'].includes(
    (env.CW_ACCESS_ONLY_BROWSER_HOSTS ?? '').trim().toLowerCase(),
  );

  /**
   * The server's OWN emailed-code sign-in — the `/signin` page and the
   * `/api/auth/start` + `/api/auth/verify` routes behind it.
   *
   * Under access-only, every browser that reaches this server has already
   * proven an address at Cloudflare Access, so a second sign-in asks a person
   * to authenticate twice and leaves a "you are not signed in" dead end on a
   * surface where nobody can be un-signed-in. It is therefore OFF whenever
   * the access-only rule is on, and back on the moment that rule is turned
   * off — the two are one decision, not two.
   *
   * `CW_EMAIL_CODE_SIGNIN=1` forces it on anyway, for a deployment that wants
   * both doors. Spelled the opposite way round from the flags above on
   * purpose: here the DEFAULT is the closed thing, so only an explicit truthy
   * word opens it.
   */
  const emailCodeSignIn = ['1', 'true', 'yes', 'on'].includes(
    (env.CW_EMAIL_CODE_SIGNIN ?? '').trim().toLowerCase(),
  )
    ? true
    : !accessOnlyBrowserHosts;

  /**
   * The address whose email identity is the fleet owner. Without it,
   * `isOwnerActor` keeps matching only the two pre-email spellings, and the
   * day the owner signs in by email the owner-activity view quietly reads
   * empty — see activity.ts.
   */
  const ownerEmail = (env.CW_OWNER_EMAIL ?? '').trim();

  const trustedHosts = (env.TRUSTED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h !== '');

  // Cloudflare Access gate. When `share` is also configured, this gate
  // is wired to the shares registry so each share-<slug> hostname uses
  // its own AUD; the env-var AUD is then a static fallback for legacy
  // single-share use.
  const cfAccessTeam = env.CF_ACCESS_TEAM_DOMAIN;
  const cfAccessAud = env.CF_ACCESS_AUD;
  // No AUD → no `audience` at all, not a placeholder string. The server asks
  // "is a static audience configured?" by the TYPE of this field, and a string
  // placeholder answered yes — leaving every fail-closed host rule depending on
  // this file remembering to empty the lists. Absent, the verifier refuses every
  // token on its own, and the shares registry still overrides it per hostname.
  const cfAccess = cfAccessTeam
    ? { teamDomain: cfAccessTeam, ...(cfAccessAud ? { audience: cfAccessAud } : {}) }
    : undefined;

  /**
   * Hostnames the Cloudflare tunnel serves that should reach the COLLABORATION
   * surface from outside the tailnet — the share surface, gated by an Access
   * application over that hostname.
   *
   * Deliberately NOT `TRUSTED_HOSTS`. That variable means "another name for this
   * machine on a network I control" and its entries classify `local`, which is
   * the whole product with no authentication at all; quietly widening it would
   * grant tunnel access to every name added for a LAN reason. The `cf-ray` veto
   * in host-guard stays exactly as it was — an entry here classifies `collab`,
   * never `local`.
   *
   * Honoured ONLY with `CF_ACCESS_TEAM_DOMAIN` *and* `CF_ACCESS_AUD` set: the
   * hostname has its own Access application, so it has its own AUD tag, and
   * without one there is nothing to verify a token against. The server refuses
   * the list on its own (see `collabAccessVerifier`); this is the loud half, so
   * a misconfiguration reads as a misconfiguration instead of as a hostname
   * that mysteriously 403s.
   */
  const accessTunnelHosts = (env.CF_ACCESS_TUNNEL_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h !== '');
  const accessTunnelReady = Boolean(cfAccessTeam && cfAccessAud);
  if (accessTunnelHosts.length && !accessTunnelReady) {
    console.error(
      `[feedback] IGNORING CF_ACCESS_TUNNEL_HOSTS (${accessTunnelHosts.join(', ')}): ` +
        'CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD must BOTH be set, or there is no ' +
        'Access application in front of those hostnames and they would expose the ' +
        'server to anyone who can reach the tunnel. They will answer 403 unknown_host.',
    );
  }

  /**
   * Hostnames the Cloudflare tunnel serves that are the OPERATOR'S OWN address —
   * the whole product from outside the tailnet, behind a Cloudflare Access
   * application over that hostname.
   *
   * The third list. `TRUSTED_HOSTS` is a LAN name (local, no token, refused
   * through the proxy); `CF_ACCESS_TUNNEL_HOSTS` is for collaborators (token,
   * then the share surface); this one is for the operator (token, then
   * everything loopback gets). Kept apart from both because it grants the most,
   * and a host listed here AND as a collaboration host stays collab — the
   * server resolves the contradiction toward the narrower grant, and the boot
   * log says so rather than leaving it to be discovered as a 403.
   *
   * Honoured ONLY with `CF_ACCESS_TEAM_DOMAIN` *and* `CF_ACCESS_AUD` set, for the
   * same reason as the collaboration list and with more at stake: without an
   * Access application to verify against, honouring the list would be the full
   * API — every doc, share administration, the deploy verb — to anyone who can
   * reach the tunnel and type the hostname. The server refuses on its own (see
   * `proxiedTrustedVerifier`); this is the loud half.
   */
  const proxiedTrustedHosts = (readRenamedEnv(env, 'CW_PROXIED_TRUSTED_HOSTS') ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h !== '');
  if (proxiedTrustedHosts.length && !accessTunnelReady) {
    console.error(
      `[feedback] IGNORING CW_PROXIED_TRUSTED_HOSTS (${proxiedTrustedHosts.join(', ')}): ` +
        'CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD must BOTH be set, or there is no ' +
        'Access application in front of those hostnames and they would expose the ' +
        'WHOLE product to anyone who can reach the tunnel. They will answer 403 unknown_host.',
    );
  }
  /**
   * The SHARE hostname(s) — `share.<domain>` — that share links open on, and
   * the audience of the ONE Cloudflare Access application in front of them.
   *
   * `CW_SHARE_LINK_HOSTS` is a comma-separated list, matched exactly like
   * every other host list here. The FIRST entry is the one share URLs are
   * built from, because a URL has to name one hostname; the rest are accepted
   * so a rename can be rolled out without breaking the links already sent.
   *
   * `CF_ACCESS_SHARE_AUD` is deliberately its OWN variable rather than a
   * reuse of `CF_ACCESS_AUD`. The share application's policy is "everyone,
   * one-time PIN" and the owner's is not, so a deployment that pointed both
   * hostnames at one audience would accept an any-email token on the
   * operator's own address. Honoured only with `CF_ACCESS_TEAM_DOMAIN` AND
   * this audience set — without an application to verify against, the list is
   * ignored and the hostname answers 403 unknown_host.
   */
  const shareLinkHosts = (env.CW_SHARE_LINK_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h !== '');
  const cfAccessShareAud = env.CF_ACCESS_SHARE_AUD?.trim() || '';
  const shareLinkReady = Boolean(cfAccessTeam && cfAccessShareAud);
  if (shareLinkHosts.length && !shareLinkReady) {
    console.error(
      `[feedback] IGNORING CW_SHARE_LINK_HOSTS (${shareLinkHosts.join(', ')}): ` +
        'CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_SHARE_AUD must BOTH be set, or there is no ' +
        'Access application in front of the share hostname and share links would open ' +
        'a board to anyone who can reach the tunnel. They will answer 403 unknown_host.',
    );
  }
  // FATAL, not a warning. Everything else in this block degrades to a
  // hostname that answers 403; this one degrades to the operator's own
  // address accepting a token that anyone on the internet can mint by typing
  // an email at the share sign-in. A warning on a boot log is not a control:
  // the server would come up serving the misconfiguration, and the two
  // audiences being equal is exactly the mistake a copy-paste makes.
  // Both trimmed before comparing. `cfAccessShareAud` is trimmed where it is
  // read; `cfAccessAud` may not be, and a copy-pasted value with a trailing
  // space is the exact shape of the mistake this refuses — so an untrimmed
  // comparison would let the one misconfiguration it exists to stop through.
  if (
    shareLinkHosts.length &&
    cfAccessShareAud &&
    cfAccessShareAud === (cfAccessAud ?? '').trim()
  ) {
    console.error(
      '[feedback] CF_ACCESS_SHARE_AUD equals CF_ACCESS_AUD: the share hostname and the ' +
        "owner's hostname would be one Access application, so a token minted by anyone " +
        "who typed an email at the share sign-in would verify on the owner's hostname. " +
        'Create a SEPARATE Access application for the share hostname and use its audience.',
    );
    process.exit(1);
  }
  const shareHostOverlap = shareLinkHosts.filter((h) =>
    [...accessTunnelHosts, ...proxiedTrustedHosts].some((c) => c.toLowerCase() === h.toLowerCase()),
  );
  if (shareHostOverlap.length) {
    console.error(
      `[feedback] CW_SHARE_LINK_HOSTS overlaps another host list (${shareHostOverlap.join(', ')}): ` +
        'a hostname on both is served as a SHARE host — any-email Access application, and ' +
        'reach decided by share-link membership. Remove it from one list to say which you meant.',
    );
  }

  /**
   * The DEDICATED hostname Recall.ai's backend dials this deployment on — a
   * first-level name (`recall.<domain>`) pointed at the same tunnel, with NO
   * Cloudflare Access application in front of it.
   *
   * Bryan's call, 2026-08-31, and the trade it makes is the point. The bot
   * callbacks used to be two exemptions punched through the OPERATOR hostname,
   * because that was the only public address this deployment had; every
   * argument for them was about a caller that is not a person, and the hole was
   * in the door people use. A second name costs a DNS record and a tunnel
   * ingress rule, and in exchange the operator hostname goes back to having no
   * exemptions at all while the unauthenticated surface is two routes that each
   * carry their own credential.
   *
   * Unlike every other host list here this one takes NO Access readiness check,
   * because Access is a browser flow and this caller has no browser. What arms
   * each route is the credential it carries — a Recall key (so a per-bot token
   * can exist) and `RECALL_WEBHOOK_SECRET` — reported on the boot line below.
   */
  const recallCallbackHostRaw = env.CW_RECALL_CALLBACK_HOST?.trim() || '';
  const recallCallbackHost = normalizeRecallCallbackHost(recallCallbackHostRaw);
  if (recallCallbackHostRaw && !recallCallbackHost) {
    console.error(
      `[meetings] IGNORING CW_RECALL_CALLBACK_HOST (${recallCallbackHostRaw}): it must be a ` +
        'plain dotted hostname such as recall.example.com — no port, no path, no IP literal. ' +
        'Bot callbacks fall back to CW_PUBLIC_BASE_URL.',
    );
  }

  /**
   * WHO the operator is, by verified Access email — the check that makes the
   * list above the operator's door rather than a door for everyone the Access
   * application admits.
   *
   * A valid token proves admission by a policy this server cannot read. One
   * application may cover the collaboration hostnames too, and then every
   * collaborator's token is just as valid here. So after the token, the
   * verified email must be on this list, or the request is refused. Defaults to
   * CW_OWNER_EMAIL; with NEITHER set the host list is ignored, because a door
   * that cannot tell the operator from a collaborator must not open.
   */
  const proxiedTrustedEmails = (env.CW_PROXIED_TRUSTED_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e !== '');
  if (proxiedTrustedEmails.length === 0 && ownerEmail) proxiedTrustedEmails.push(ownerEmail);
  const proxiedTrustedReady = accessTunnelReady && proxiedTrustedEmails.length > 0;
  if (proxiedTrustedHosts.length && accessTunnelReady && proxiedTrustedEmails.length === 0) {
    console.error(
      `[feedback] IGNORING CW_PROXIED_TRUSTED_HOSTS (${proxiedTrustedHosts.join(', ')}): ` +
        'no operator allowlist. Set CW_PROXIED_TRUSTED_EMAILS (or CW_OWNER_EMAIL), or an ' +
        'Access token from ANYONE the application admits — every collaborator on the same ' +
        'app — would reach the whole product. They will answer 403 unknown_host.',
    );
  }
  const alsoCollab = proxiedTrustedHosts.filter((h) =>
    accessTunnelHosts.some((c) => c.toLowerCase() === h.toLowerCase()),
  );
  if (alsoCollab.length) {
    console.error(
      `[feedback] CW_PROXIED_TRUSTED_HOSTS overlaps CF_ACCESS_TUNNEL_HOSTS (${alsoCollab.join(', ')}): ` +
        'a hostname on both lists is served as a COLLABORATION host — Access token, ' +
        'share surface, operator verbs refused. Remove it from one list to say which you meant.',
    );
  }

  // Access-only with nothing Access-fronted means no browser can reach this
  // server except one running ON the box. That is a correct fail-closed state
  // and a miserable one to diagnose from a 403, so it is said at boot. LOUD
  // rather than fatal: a fresh install has no Access application yet, and
  // refusing to start would make the first run of the product the thing that
  // fails.
  const anyAccessHostConfigured =
    (accessTunnelHosts.length > 0 && accessTunnelReady) ||
    (proxiedTrustedHosts.length > 0 && proxiedTrustedReady) ||
    (shareLinkHosts.length > 0 && shareLinkReady);
  if (accessOnlyBrowserHosts && !anyAccessHostConfigured) {
    console.error(
      '[feedback] ACCESS-ONLY is on and no Cloudflare Access hostname is configured: ' +
        'the tailnet name, the LAN names and TRUSTED_HOSTS will answer 403 unknown_host, ' +
        'so the only browser that can reach this server is one on this machine using ' +
        'http://localhost:<port>. Set CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD and list the ' +
        'hostname in CW_PROXIED_TRUSTED_HOSTS (operator) or CF_ACCESS_TUNNEL_HOSTS ' +
        '(collaborators), or set CW_ACCESS_ONLY_BROWSER_HOSTS=0 to restore the old ' +
        'unauthenticated tailnet/LAN access.',
    );
  }

  // Sharing.
  //
  // ACCESS mode — per-share hostnames behind Cloudflare Access — is the only
  // mode. It needs CF_SHARE_BASE_HOSTNAME + CF_ACCOUNT_ID +
  // CF_ACCESS_TEAM_DOMAIN; the API token comes from the macOS Keychain via the
  // share module's reader.
  //
  // CF_SHARE_PUBLIC_HOSTNAME is read only so a box still setting it keeps a
  // share config at all. It authorizes nothing: link mode is retired and the
  // host classifier has no `link` kind.
  const accessShareConfigured = Boolean(
    env.CF_SHARE_BASE_HOSTNAME && env.CF_ACCOUNT_ID && cfAccessTeam,
  );
  const publicHostname = env.CF_SHARE_PUBLIC_HOSTNAME;
  // Optional ceiling on every share's TTL, in the same grammar `share_link`
  // takes (`30d`, `72h`). A mint or extension asking for more is clamped and
  // told so. Unset = no ceiling; a value the grammar cannot read is a startup
  // error rather than a silently absent ceiling.
  const maxTtlRaw = env.CF_SHARE_MAX_TTL;
  const maxTtlSeconds = maxTtlRaw ? parseTtl(maxTtlRaw) : null;
  if (maxTtlRaw && (maxTtlSeconds === null || maxTtlSeconds <= 0)) {
    console.error(
      `CF_SHARE_MAX_TTL=${JSON.stringify(maxTtlRaw)} is not a positive duration — ${TTL_FORMAT_HINT}`,
    );
    process.exit(1);
  }
  const shareConfig =
    accessShareConfigured || publicHostname
      ? {
          ...(env.CF_ACCOUNT_ID ? { cfAccountId: env.CF_ACCOUNT_ID } : {}),
          ...(cfAccessTeam ? { cfTeamDomain: cfAccessTeam } : {}),
          ...(env.CF_SHARE_BASE_HOSTNAME ? { baseHostname: env.CF_SHARE_BASE_HOSTNAME } : {}),
          ...(publicHostname ? { publicHostname } : {}),
          ...(maxTtlSeconds ? { maxTtlSeconds } : {}),
        }
      : null;

  // Hourly abuse ceilings on the login-code mailer. Unset or not a positive
  // number → the defaults in auth/email-code.ts; there is deliberately no
  // value that turns a ceiling OFF.
  const positiveIntEnv = (name: string): number | undefined => {
    const n = Number((env[name] ?? '').trim() || Number.NaN);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
  };
  const authGlobalStartsPerHour = positiveIntEnv('CW_AUTH_GLOBAL_STARTS_PER_HOUR');
  const authPeerStartsPerHour = positiveIntEnv('CW_AUTH_PEER_STARTS_PER_HOUR');

  const meetingBotWebhookSecret = env.RECALL_WEBHOOK_SECRET?.trim() || undefined;

  const pluginRefreshIntervalMs = Number(arg('plugin-refresh-interval-ms', '0'));
  return {
    repoRoot,
    widgetDist,
    markdownAppDist,
    accessShareConfigured,
    requestedPort,
    hostname,
    dataDir,
    demosDir,
    publicBaseUrlOverride,
    clientReleaseRootDir,
    sentryDsn,
    releaseSourceRef,
    readyNudgeIdleMs,
    stallNudgeQuietMs,
    stallBuilderSilentMultiplier,
    stallNudgeRepeatMs,
    heldReviewItemMs,
    stallEscalateMs,
    allowedOrigins,
    sharingEnvLocked,
    requireEmailAuth,
    requireSignInToWrite,
    requireAgentToken,
    accessOnlyBrowserHosts,
    emailCodeSignIn,
    ownerEmail,
    trustedHosts,
    cfAccess,
    accessTunnelHosts,
    accessTunnelReady,
    proxiedTrustedHosts,
    shareLinkHosts,
    cfAccessShareAud,
    shareLinkReady,
    recallCallbackHost,
    proxiedTrustedEmails,
    proxiedTrustedReady,
    shareConfig,
    authGlobalStartsPerHour,
    authPeerStartsPerHour,
    meetingBotWebhookSecret,
    pluginRefreshIntervalMs,
  };
}

/** The resolved shape — inferred from the resolver so the two cannot drift. */
export type ServerConfig = ReturnType<typeof resolveServerConfig>;

function pathOrNull(p: string): string | null {
  return existsSync(p) ? p : null;
}
