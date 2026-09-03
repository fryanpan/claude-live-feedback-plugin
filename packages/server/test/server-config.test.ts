/**
 * `resolveServerConfig` is the half of the composition root that only READS —
 * env and argv into one typed value — and the reason that half was split out
 * of `bin.ts` is that a boot script's settings are otherwise only exercised by
 * booting. So this drives it directly.
 *
 * What it pins is the behaviour that has bitten before: a host list is
 * REFUSED, not merely warned about, when the Access application that would
 * make it safe is not configured. The warnings and the emptied lists are one
 * decision, and a test that asserted only the log line would pass over a
 * server that had honoured the list anyway.
 *
 * All fixtures are invented — the repo is public.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ArgReader, resolveServerConfig } from '../src/server-config.ts';

function noArgs(): ArgReader {
  return (_name, fallback) => fallback;
}

/** `--name value` pairs, read the way bin.ts reads them. */
function argsFrom(pairs: Record<string, string>): ArgReader {
  return (name, fallback) => pairs[name] ?? fallback;
}

function resolve(env: NodeJS.ProcessEnv, arg: ArgReader = noArgs()) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'cw-config-'));
  try {
    return resolveServerConfig({ env, repoRoot, arg });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

describe('resolveServerConfig', () => {
  it('falls back to the default port and resolves a data dir with nothing set', () => {
    const cfg = resolve({});
    expect(cfg.requestedPort).toBe(8787);
    expect(typeof cfg.dataDir).toBe('string');
    expect(cfg.dataDir.length).toBeGreaterThan(0);
  });

  it('lets a flag beat the environment for the port', () => {
    const cfg = resolve({ PORT: '9001' }, argsFrom({ port: '9002' }));
    expect(cfg.requestedPort).toBe(9002);
  });

  it('reads PORT when no flag is passed', () => {
    expect(resolve({ PORT: '9001' }).requestedPort).toBe(9001);
  });

  it('splits the comma lists and drops the empties', () => {
    const cfg = resolve({
      TRUSTED_HOSTS: 'box.example, , spare.example ',
      ALLOWED_ORIGINS: 'http://dev.example:5173,',
    });
    expect(cfg.trustedHosts).toEqual(['box.example', 'spare.example']);
    expect(cfg.allowedOrigins).toEqual(['http://dev.example:5173']);
  });

  it('defaults the write gate on and takes 0 as off', () => {
    expect(resolve({}).requireSignInToWrite).toBe(true);
    expect(resolve({ CW_REQUIRE_SIGNIN_TO_WRITE: '0' }).requireSignInToWrite).toBe(false);
  });

  it('treats the sharing lock and email-auth flags as the same yes-words', () => {
    expect(resolve({ CW_SHARING_DISABLED: 'YES' }).sharingEnvLocked).toBe(true);
    expect(resolve({ CW_SHARING_DISABLED: 'maybe' }).sharingEnvLocked).toBe(false);
    expect(resolve({ CW_REQUIRE_EMAIL_AUTH: 'true' }).requireEmailAuth).toBe(true);
    expect(resolve({}).requireEmailAuth).toBe(false);
  });

  it('omits the Access audience entirely when none is configured', () => {
    const withAud = resolve({ CF_ACCESS_TEAM_DOMAIN: 'team.example', CF_ACCESS_AUD: 'aud-1' });
    expect(withAud.cfAccess).toEqual({ teamDomain: 'team.example', audience: 'aud-1' });
    // Not a placeholder string: the server asks "is a static audience
    // configured?" by the TYPE of this field.
    const noAud = resolve({ CF_ACCESS_TEAM_DOMAIN: 'team.example' });
    expect(noAud.cfAccess).toEqual({ teamDomain: 'team.example' });
    expect(resolve({}).cfAccess).toBeUndefined();
  });

  it('REFUSES the tunnel host lists when no Access application is configured', () => {
    const cfg = resolve({
      CF_ACCESS_TUNNEL_HOSTS: 'collab.example',
      CW_PROXIED_TRUSTED_HOSTS: 'me.example',
      CW_OWNER_EMAIL: 'owner@example.com',
    });
    // The lists are still reported so the boot line can name what was ignored…
    expect(cfg.accessTunnelHosts).toEqual(['collab.example']);
    expect(cfg.proxiedTrustedHosts).toEqual(['me.example']);
    // …and both readiness flags say they must not be honoured.
    expect(cfg.accessTunnelReady).toBe(false);
    expect(cfg.proxiedTrustedReady).toBe(false);
  });

  it('arms the operator list only with an Access application AND an allowlist', () => {
    const base = {
      CF_ACCESS_TEAM_DOMAIN: 'team.example',
      CF_ACCESS_AUD: 'aud-1',
      CW_PROXIED_TRUSTED_HOSTS: 'me.example',
    };
    expect(resolve(base).proxiedTrustedReady).toBe(false);
    const owned = resolve({ ...base, CW_OWNER_EMAIL: 'owner@example.com' });
    expect(owned.proxiedTrustedEmails).toEqual(['owner@example.com']);
    expect(owned.proxiedTrustedReady).toBe(true);
    // An explicit allowlist wins over the owner fallback.
    const listed = resolve({
      ...base,
      CW_OWNER_EMAIL: 'owner@example.com',
      CW_PROXIED_TRUSTED_EMAILS: 'ops@example.com, second@example.com',
    });
    expect(listed.proxiedTrustedEmails).toEqual(['ops@example.com', 'second@example.com']);
  });

  it('refuses a Recall callback host that is not a plain hostname', () => {
    expect(resolve({ CW_RECALL_CALLBACK_HOST: 'recall.example.com' }).recallCallbackHost).toBe(
      'recall.example.com',
    );
    expect(
      resolve({ CW_RECALL_CALLBACK_HOST: 'https://recall.example.com/x' }).recallCallbackHost,
    ).toBeFalsy();
  });

  it('builds a share config for link mode and leaves it null with nothing set', () => {
    expect(resolve({}).shareConfig).toBeNull();
    expect(resolve({}).accessShareConfigured).toBe(false);
    const link = resolve({ CF_SHARE_PUBLIC_HOSTNAME: 'share.example' });
    expect(link.shareConfig).toEqual({ publicHostname: 'share.example' });
    expect(link.accessShareConfigured).toBe(false);
  });

  it('reports Access share mode only when all three of its pieces are set', () => {
    const cfg = resolve({
      CF_SHARE_BASE_HOSTNAME: 'base.example',
      CF_ACCOUNT_ID: 'acct-1',
      CF_ACCESS_TEAM_DOMAIN: 'team.example',
    });
    expect(cfg.accessShareConfigured).toBe(true);
    expect(cfg.shareConfig).toEqual({
      cfAccountId: 'acct-1',
      cfTeamDomain: 'team.example',
      baseHostname: 'base.example',
    });
    expect(resolve({ CF_SHARE_BASE_HOSTNAME: 'base.example' }).accessShareConfigured).toBe(false);
  });

  it('carries a readable share TTL ceiling onto the share config', () => {
    const cfg = resolve({ CF_SHARE_PUBLIC_HOSTNAME: 'share.example', CF_SHARE_MAX_TTL: '30d' });
    expect(cfg.shareConfig?.maxTtlSeconds).toBe(30 * 24 * 60 * 60);
  });

  it('takes the login-code ceilings only as positive integers', () => {
    const cfg = resolve({
      CW_AUTH_GLOBAL_STARTS_PER_HOUR: '250',
      CW_AUTH_PEER_STARTS_PER_HOUR: '0',
    });
    expect(cfg.authGlobalStartsPerHour).toBe(250);
    // There is deliberately no value that turns a ceiling OFF, so a
    // non-positive one falls back to the module's own default.
    expect(cfg.authPeerStartsPerHour).toBeUndefined();
    expect(
      resolve({ CW_AUTH_GLOBAL_STARTS_PER_HOUR: 'lots' }).authGlobalStartsPerHour,
    ).toBeUndefined();
  });

  it('reads the nudge windows in the units an operator types', () => {
    const cfg = resolve({
      CW_READY_NUDGE_MINUTES: '15',
      CW_STALL_REPEAT_HOURS: '2',
      CW_BUILDER_SILENT_MULTIPLIER: '3',
    });
    expect(cfg.readyNudgeIdleMs).toBe(15 * 60_000);
    expect(cfg.stallNudgeRepeatMs).toBe(2 * 60 * 60_000);
    expect(cfg.stallBuilderSilentMultiplier).toBe(3);
    expect(resolve({}).readyNudgeIdleMs).toBeUndefined();
  });

  it('REFUSES to boot on a malformed public base URL rather than passing it through', () => {
    expect(resolve({ CW_PUBLIC_BASE_URL: 'https://box.example' }).publicBaseUrlOverride).toBe(
      'https://box.example',
    );
    // A typo here silently breaks every share link the server hands out, so
    // the config throws and the process never starts.
    expect(() => resolve({ CW_PUBLIC_BASE_URL: 'not a url' })).toThrow(/CW_PUBLIC_BASE_URL/);
    expect(resolve({}).publicBaseUrlOverride).toBeUndefined();
  });

  it('leaves the release fields absent without a release root', () => {
    const cfg = resolve({});
    expect(cfg.clientReleaseRootDir).toBeNull();
    expect(cfg.releaseSourceRef).toBeNull();
    expect(cfg.pluginRefreshIntervalMs).toBe(0);
  });
});

/**
 * The one misconfiguration that is fatal rather than warned about.
 *
 * Everything else in the share-link block degrades to a hostname that answers
 * 403. This one degrades to the operator's own address accepting a token that
 * anyone on the internet can mint by typing an email at the everyone-policy
 * share sign-in — so the server refuses to come up at all.
 *
 * Driven in a subprocess because the refusal IS `process.exit(1)`, which in
 * this process would take the test runner with it. The exit code is the
 * assertion; a warning that let boot continue would read as a pass here.
 */
describe('a share audience equal to the owner audience is fatal', () => {
  const boot = async (env: Record<string, string>) => {
    const proc = Bun.spawn(
      [
        process.execPath,
        '-e',
        [
          "const m = await import('./packages/server/src/server-config.ts');",
          'm.resolveServerConfig({',
          '  env: JSON.parse(process.env.CW_TEST_ENV_JSON),',
          '  repoRoot: process.cwd(),',
          '  arg: (_n, f) => f,',
          '});',
          "console.log('booted');",
        ].join(''),
      ],
      {
        cwd: new URL('../../..', import.meta.url).pathname,
        env: { ...process.env, CW_TEST_ENV_JSON: JSON.stringify(env) },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { out, err, code };
  };

  const SHARED = {
    CF_ACCESS_TEAM_DOMAIN: 'example.cloudflareaccess.com',
    CW_SHARE_LINK_HOSTS: 'share.example.test',
  };

  it('refuses to start when the two audiences are the same', async () => {
    const r = await boot({
      ...SHARED,
      CF_ACCESS_AUD: 'one-application-for-both',
      CF_ACCESS_SHARE_AUD: 'one-application-for-both',
    });
    expect(r.code).toBe(1);
    expect(r.out).not.toContain('booted');
    expect(r.err).toContain('CF_ACCESS_SHARE_AUD');
  });

  it('refuses when they differ only by surrounding whitespace', async () => {
    // The shape a copy-paste actually makes. Compared untrimmed, this is the
    // one value that would slip past the check written to stop it.
    const r = await boot({
      ...SHARED,
      CF_ACCESS_AUD: '  one-application-for-both  ',
      CF_ACCESS_SHARE_AUD: 'one-application-for-both',
    });
    expect(r.code).toBe(1);
  });

  it('starts when they are two different applications', async () => {
    // The positive control the refusals need: the same configuration with the
    // share hostname on its own audience boots.
    const r = await boot({
      ...SHARED,
      CF_ACCESS_AUD: 'owner-application',
      CF_ACCESS_SHARE_AUD: 'share-application',
    });
    expect({ code: r.code, booted: r.out.includes('booted') }).toEqual({ code: 0, booted: true });
  });

  it('starts on an owner-audience-only configuration, which names no share audience', async () => {
    // Every deployment that has not adopted share links. The check must be
    // reachable only when a share hostname is configured, or it would refuse
    // to boot the servers that never asked for this feature.
    const r = await boot({
      CF_ACCESS_TEAM_DOMAIN: SHARED.CF_ACCESS_TEAM_DOMAIN,
      CF_ACCESS_AUD: 'owner-application',
    });
    expect({ code: r.code, booted: r.out.includes('booted') }).toEqual({ code: 0, booted: true });
  });
});
