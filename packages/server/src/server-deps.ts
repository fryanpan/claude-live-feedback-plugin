/**
 * The other half of the composition root: the ONE place a real adapter is
 * constructed.
 *
 * Every seam in here follows the same rule, and it is a load-bearing one.
 * `createServer` defaults each of these to a no-op or a null, so nothing that
 * merely spins a server up — every test in packages/server/test, every
 * embedded use — can reach the network, the Keychain, a metered transcription
 * session, this machine's plugin cache, or the launchd service. A real one
 * exists only because this file, reached only from `bin.ts`, built it.
 *
 * The log lines travel with their constructors on purpose: each says which
 * adapter was built and, when one was not, the single command that would
 * change that. Read together they are the boot's account of what this
 * deployment can actually do.
 */
import { resolvePostmarkCodeSender } from './auth/postmark-code-sender.ts';
import { createDeployer } from './deploy.ts';
import { effortEstimateEnabled, haikuEffortEstimator } from './effort-estimator.ts';
import {
  GOOGLE_OAUTH_KEYCHAIN_SERVICE,
  createGoogleOauthApp,
  createKeychainRefreshTokenVault,
  resolveGoogleOauthCreds,
} from './google-oauth.ts';
import { stamped } from './log-stamp.ts';
import { createHaikuNotesComposer } from './meeting-notes-composer.ts';
import { createHaikuTaskCaptureExtractor } from './meeting-task-capture.ts';
import { createNotesPromptStore } from './notes-prompt-store.ts';
import { createPluginRefresher } from './plugin-refresh.ts';
import { createRecallCalendarClient } from './recall-calendar.ts';
import { createRecallClient, recallStatusWebhookUrl } from './recall.ts';
import { haikuReviewJudge, reviewGateEnabled } from './review-judge.ts';
import type { ServerConfig } from './server-config.ts';
import { readKeychainPassword } from './share/keychain.ts';
import { KEYCHAIN_SERVICE, ThreadSummarizer } from './summarize.ts';
import {
  KEYCHAIN_SERVICE as ASSEMBLYAI_KEYCHAIN_SERVICE,
  createAssemblyAiEngine,
  createAssemblyAiProEngine,
} from './transcribe-assemblyai.ts';
import { SONIOX_KEYCHAIN_SERVICE, createSonioxEngine } from './transcribe-soniox.ts';
import { orderedEngines } from './transcribe.ts';
import { haikuVoiceComplete } from './voice.ts';

export function createServerDeps(
  cfg: ServerConfig,
  opts: {
    /** Whether this start is the deploy source — `--deploy`, passed only by
     *  scripts/serve.ts under launchd. */
    deployEnabled: boolean;
    /** Which bound documents are mid-edit. Asked of the server that does not
     *  exist yet when the deployer is built, so it arrives as a thunk. */
    busyDocs: () => { docId: string; path: string }[];
  },
) {
  const { deployEnabled, busyDocs } = opts;
  const share = cfg.shareConfig
    ? {
        config: cfg.shareConfig,
        // Only read the Keychain when Access mode is actually configured —
        // the reader throws when the entry is missing, and a link-only
        // deployment has no reason to hold a Cloudflare token at all.
        ...(cfg.accessShareConfigured
          ? { cfApiToken: readKeychainPassword('cloudflare-api-token') }
          : {}),
      }
    : undefined;

  // The ONLY place a real summarizer is constructed. `createServer` has no
  // default, so nothing that merely spins a server up — every test in
  // packages/server/test, every embedded use — can reach the network or the
  // key. An absent key or CW_SUMMARIES=0 makes every call on it a no-op.
  const summarizer = new ThreadSummarizer();

  // The ONLY place a real email sender is constructed, for the same reason the
  // summarizer is: `createServer` defaults to the log sender, so nothing that
  // merely spins a server up — every test, every embedded use — can reach the
  // network or the Keychain. Resolving never throws; a partial setup keeps the
  // log sender and says which piece is missing, because during setup that is
  // the normal state rather than an error.
  const codeSenderChoice = resolvePostmarkCodeSender(process.env, readKeychainPassword);
  // Stamped, like the code-delivery lines themselves: this line says which
  // sender the codes that follow went through, so reading a burst means
  // pairing it with the notice that was in force at the time.
  if (codeSenderChoice.reason) console.log(stamped(`[auth] ${codeSenderChoice.reason}`));
  else console.log(stamped('[auth] login codes send via Postmark'));

  // The ONLY place the real voice fast-path completer is constructed — the
  // same seam rule (and the same dedicated-key consent) as the summarizer.
  // Absent key → null → the fast path is off and voice routes to the agent.
  const voiceComplete = haikuVoiceComplete();

  // The ONLY place the real review-item judge is constructed — same seam rule
  // and the SAME dedicated-key consent as the summarizer, because what leaves
  // the machine is the item's own text. Absent key or CW_REVIEW_GATE=0 → null
  // → every item passes unjudged, which is the documented "gate off" state.
  const reviewJudge = haikuReviewJudge();
  if (!reviewJudge) {
    console.log(
      reviewGateEnabled()
        ? '[review-gate] no summary API key; review items pass unjudged. ' +
            `Add one with: security add-generic-password -a "$USER" -s ${KEYCHAIN_SERVICE} -w`
        : '[review-gate] off (CW_REVIEW_GATE=0); review items pass unjudged.',
    );
  }

  // The ONLY place the real effort-estimate scorer is constructed — same seam
  // rule and the same dedicated-key consent as the summarizer and the review
  // judge: a ticket's title and description leave the machine for this call.
  // Absent key or CW_EFFORT_ESTIMATE=0 → null → every ticket stays unscored,
  // which reads on the row exactly like a workspace that never wired this in.
  const effortEstimator = haikuEffortEstimator();
  if (!effortEstimator) {
    console.log(
      effortEstimateEnabled()
        ? '[effort-estimate] no summary API key; tickets stay unscored. ' +
            `Add one with: security add-generic-password -a "$USER" -s ${KEYCHAIN_SERVICE} -w`
        : '[effort-estimate] off (CW_EFFORT_ESTIMATE=0); tickets stay unscored.',
    );
  }

  // The ONLY place a real transcription engine is constructed — same seam rule,
  // and here it is also the difference between a test suite that is free and one
  // that opens a metered streaming session per server it spins up. No key → null
  // → the meeting socket answers `not_configured` and the strip says so.
  const assemblyAi = createAssemblyAiEngine();
  // The same key opens the pro model, so the two appear and disappear together.
  const assemblyAiPro = createAssemblyAiProEngine();
  const soniox = createSonioxEngine();
  // Default first — Soniox (Bryan, 2026-09-01). The ordering itself lives in
  // `orderedEngines`, where a test holds it still.
  const engines = orderedEngines({ soniox, assemblyAi, assemblyAiPro });
  const transcription = engines.length > 0 ? engines : null;
  if (!transcription) {
    console.log(
      '[meetings] no transcription key; live meetings answer "not configured". ' +
        `Add one with: security add-generic-password -a "$USER" -s ${ASSEMBLYAI_KEYCHAIN_SERVICE} -w`,
    );
  } else if (!soniox) {
    // Not a failure — the option simply does not appear in any chooser. Named
    // so the person wondering where the Soniox option went finds the answer in
    // the log rather than in the code. It matters more than it used to:
    // Soniox is the DEFAULT engine, so its absence also moves the default
    // back to AssemblyAI.
    console.log(
      '[meetings] no Soniox key; the soniox engine option stays hidden and ' +
        'AssemblyAI becomes the default. ' +
        `Add one with: security add-generic-password -a "$USER" -s ${SONIOX_KEYCHAIN_SERVICE} -w`,
    );
  }

  // The ONLY place the real notes composer is constructed — same seam and the
  // SAME dedicated-key consent as the summarizer, because what it sends off-
  // machine is the meeting transcript itself. Absent key → null → meetings
  // still record transcripts; the notes section simply never appears.
  // The ONLY place a real Recall client is constructed — the same seam again,
  // and the most expensive one to get wrong: a bot bills the vendor per
  // meeting-hour AND opens an AssemblyAI session behind it, so a client built
  // by anything that merely spins a server up would be a meter attached to a
  // test suite. No key → null → the invite route answers `not_configured` and
  // the doc says meeting bots are not set up.
  const meetingBot = createRecallClient({ publicBaseUrl: cfg.publicBaseUrlOverride });
  if (meetingBot && !meetingBot.config.publicWsBase) {
    // Worth saying out loud rather than discovering at invite time: the server
    // binds to localhost and Recall dials in from the public internet, so it
    // has to be told the origin something in front of it answers on. Named
    // rather than guessed, and named ONCE — the same value every human-facing
    // link is built from.
    console.log(
      cfg.publicBaseUrlOverride
        ? '[meetings] Recall key found but CW_PUBLIC_BASE_URL is not https; ' +
            'bots stay disabled rather than stream a meeting in plaintext.'
        : '[meetings] Recall key found but CW_PUBLIC_BASE_URL is unset; ' +
            'bots stay disabled until it names the https origin this server is reached on.',
    );
  }
  if (meetingBot) {
    // Say which region the key is being sent to and whether it answers there.
    // A key from another region fails every invite with a 502 and nothing
    // else in the boot log hints at it; this line is the hint.
    const regionSource = process.env.RECALL_REGION?.trim()
      ? `RECALL_REGION=${meetingBot.config.region}`
      : `RECALL_REGION unset, defaulting to ${meetingBot.config.region}`;
    void meetingBot.checkKeyRegion().then((check) => {
      if (check.ok) {
        console.log(`[meetings] Recall key accepted by ${check.region} (${regionSource}).`);
      } else if (check.status === 401) {
        console.error(
          `[meetings] Recall key REJECTED by ${check.region} (401; ${regionSource}). ` +
            'The key belongs to another region, so every bot invite will answer 502. ' +
            'Set RECALL_REGION in the launchd plist EnvironmentVariables to the region ' +
            'the key was issued in and re-bootstrap the service.',
        );
      } else {
        console.error(
          `[meetings] Recall key check against ${check.region} failed (status ${check.status}; ${regionSource}); bots may not work.`,
        );
      }
    });
  }

  if (meetingBot?.config.publicWsBase && !cfg.meetingBotWebhookSecret) {
    // Says CLOSED, not "accepted unsigned". It said the latter until the
    // pass-2 review, which was the pre-fix behaviour and the opposite of the
    // meetings summary block twelve lines down. An operator reading it
    // concluded either that an unauthenticated injection path was open or that
    // events were arriving, when in fact every delivery 404s — and the symptom
    // they will actually see, a bot whose status never updates, has no other
    // line to point at.
    console.log(
      '[meetings] RECALL_WEBHOOK_SECRET is unset; the bot status webhook is ' +
        'CLOSED — every delivery answers 404 and bot status will not update. ' +
        'Set it to the signing secret from the Recall dashboard.',
    );
  }
  // Calendar auto-join — the ONLY place real calendar-side pieces are
  // constructed, same seam rule as the bot client above: a scheduled bot joins
  // a real call and spends. The Recall key gates the whole feature; the Google
  // OAuth app (Keychain service `claude-workspaces-google-oauth`, accounts
  // `client-id` / `client-secret`) gates only the CONNECT flow, so a calendar
  // connected earlier keeps syncing even if those entries go missing.
  const calendarClient = createRecallCalendarClient({});
  const googleOauthCreds = calendarClient ? resolveGoogleOauthCreds(process.env) : null;
  // The redirect URI is registered at Google verbatim, so it is stated rather
  // than guessed: the env override wins, else it derives from the same public
  // base URL every human-facing link uses.
  const googleRedirectUri =
    process.env.CW_GOOGLE_OAUTH_REDIRECT_URI?.trim() ||
    (cfg.publicBaseUrlOverride
      ? `${cfg.publicBaseUrlOverride.replace(/\/+$/, '')}/api/calendar/google/callback`
      : null);
  const calendarBot = calendarClient
    ? {
        client: calendarClient,
        google:
          googleOauthCreds && googleRedirectUri
            ? createGoogleOauthApp({ creds: googleOauthCreds, redirectUri: googleRedirectUri })
            : null,
        vault: createKeychainRefreshTokenVault(),
      }
    : null;
  if (calendarBot) {
    if (calendarBot.google) {
      console.log(
        `[calendar] Google connect armed; redirect URI ${googleRedirectUri} ` +
          '(must match the OAuth app registration at Google).',
      );
    } else {
      console.log(
        '[calendar] connect is off: ' +
          (googleOauthCreds
            ? 'CW_PUBLIC_BASE_URL (or CW_GOOGLE_OAUTH_REDIRECT_URI) is unset.'
            : `no Google OAuth app in Keychain service ${GOOGLE_OAUTH_KEYCHAIN_SERVICE} ` +
              '(accounts client-id and client-secret). A calendar connected earlier keeps syncing.'),
      );
    }
  }

  // Where Recall dials in, and whether each of the two routes there is actually
  // armed. Printed whenever a callback hostname is configured, because "did this
  // take effect?" is otherwise only answerable by making a bot join a real call
  // — and the status webhook URL in particular is a value a human must paste
  // into the Recall dashboard, which nothing else in this process ever says.
  //
  // NOT gated on the operator hostname any more: the callback host stands on its
  // own now, and a deployment can have one without publishing the product at all.
  if (cfg.recallCallbackHost) {
    console.log(
      `[meetings] bot callback host: ${cfg.recallCallbackHost} (no Cloudflare Access; ` +
        'each route carries its own credential)',
    );
    console.log(
      '[meetings]   websocket  wss://' +
        `${cfg.recallCallbackHost}/recall/<per-bot-token>  ` +
        (meetingBot?.config.publicWsBase ? 'ARMED' : 'closed (no Recall key)'),
    );
    console.log(
      `[meetings]   webhook    ${recallStatusWebhookUrl({ callbackHost: cfg.recallCallbackHost })}  ` +
        (cfg.meetingBotWebhookSecret ? 'ARMED' : 'closed (set RECALL_WEBHOOK_SECRET)') +
        ' — paste this into the Recall dashboard',
    );
    console.log('[meetings]   every other path on that hostname answers 404.');
  }
  // No `else` warning here on purpose. Whether the CW_PUBLIC_BASE_URL fallback
  // is actually dialable depends on the effective host lists, which live in
  // createServer — so the honest line ("bots are OFF: Recall would dial …") is
  // printed there, by the same check that disarms the invite. A warning here
  // would either duplicate it or cry wolf at every deployment whose public
  // hostname is not Access-gated at all.

  // The instructions the note-taker runs on come from the data dir, re-read
  // per tick, so retuning how the notes read is an edit to a file rather than
  // a deploy (`notes-prompt-store.ts`).
  const notesPrompt = createNotesPromptStore({ dataDir: cfg.dataDir });
  const notesComposer = createHaikuNotesComposer({ instructions: notesPrompt.read });
  if (transcription && !notesComposer) {
    console.log(
      '[meeting-notes] no summary API key; meetings record transcripts, notes stay off. ' +
        `Add one with: security add-generic-password -a "$USER" -s ${KEYCHAIN_SERVICE} -w`,
    );
  }

  // The ONLY place the real task-capture extractor is constructed — the same
  // dedicated-key consent as the notes composer, because the same transcript
  // text leaves the machine. Absent key or CW_MEETING_TASKS=0 → null → the
  // notes still compose, they just never link or file board tasks.
  const taskExtractor = createHaikuTaskCaptureExtractor();
  if (notesComposer && !taskExtractor) {
    console.log(
      '[meeting-tasks] task capture off (CW_MEETING_TASKS=0); meetings compose notes ' +
        'without finding or filing board tasks.',
    );
  }

  // The ONLY place a real plugin refresher is constructed — same seam rule as
  // the summarizer above, and here it also means no test run and no `bun run
  // staging` can mutate this machine's plugin cache. A deploy has to be asked
  // for by the process that IS the deploy.
  //
  // PROD passes --plugin-refresh-interval-ms (see scripts/serve.ts). Absent, no
  // refresher exists and /api/plugin/refresh answers 501, which is what dev and
  // staging want: they are copies, not the machine everyone installs from.
  const pluginRefresher =
    Number.isFinite(cfg.pluginRefreshIntervalMs) && cfg.pluginRefreshIntervalMs > 0
      ? createPluginRefresher()
      : null;

  // The ONLY place a real deployer is constructed — same seam rule as the
  // plugin refresher above, and it matters more here: this one runs `git merge
  // --ff-only` in the deploy source and then restarts the launchd service. No
  // test run, no embedded server and no `bun run staging` may do either.
  //
  // PROD passes --deploy (see scripts/serve.ts). Absent, no deployer exists and
  // /api/deploy answers 501 — which is what dev and staging want, because they
  // are copies of the deploy source rather than the machine everyone reads.
  //
  // There is deliberately no "--restart" companion. A restart re-runs
  // scripts/serve.ts out of the deploy source's WorkingDirectory, so over an
  // unpulled checkout it rebuilds the same bundles and republishes the same
  // client while printing a successful deploy line. Pull and restart are one
  // verb in deploy.ts precisely so that cannot be expressed here.
  const deployer = deployEnabled
    ? createDeployer({
        repoRoot: cfg.repoRoot,
        dataDir: cfg.dataDir,
        // Only documents bound INSIDE the deploy source can be clobbered by
        // its pull; one bound from another checkout is not this deploy's
        // business.
        busyDocs,
        // What the browser is actually running, which is what a deploy
        // delivers. Without it "up-to-date" only means the CHECKOUT is
        // current, and a hand-pulled source with an unrestarted server reports
        // nothing to do while the fleet loads the older bundle.
        clientReleaseRoot: cfg.clientReleaseRootDir,
      })
    : null;
  return {
    share,
    summarizer,
    codeSenderChoice,
    voiceComplete,
    reviewJudge,
    effortEstimator,
    transcription,
    meetingBot,
    calendarBot,
    notesComposer,
    taskExtractor,
    pluginRefresher,
    deployer,
  };
}

/** What the boot has to work with — inferred, so the two cannot drift. */
export type ServerDeps = ReturnType<typeof createServerDeps>;
