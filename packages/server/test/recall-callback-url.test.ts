/**
 * Where the bot is told to dial back — the one value in this feature whose
 * failure mode is silent and expensive.
 *
 * A wrong websocket origin is not an error anywhere: Recall accepts the bot,
 * the bot joins the call, records, bills per meeting-hour, streams to a
 * hostname nobody is listening on, and delivers nothing. A wrong status
 * webhook URL is quieter still — the transcript arrives and only the bot's
 * lifecycle events go missing. So the derivation gets its own suite, and the
 * cases are the ones where the two inputs disagree.
 *
 * The decision under test (Bryan, 2026-08-31): the dedicated callback
 * hostname WINS OUTRIGHT over `CW_PUBLIC_BASE_URL`, and the two are allowed
 * to name different hosts. That is the feature — the address a vendor dials
 * is deliberately not the address a person opens the product on.
 */
import { describe, expect, it } from 'bun:test';
import {
  normalizeRecallCallbackHost,
  recallConfigFromEnv,
  recallStatusWebhookUrl,
  wsBaseForRecall,
} from '../src/recall.ts';

const OPS = 'https://ops.example.com';
const HOST = 'recall.example.com';

describe('normalizeRecallCallbackHost', () => {
  it('takes a bare hostname, lowercased', () => {
    expect(normalizeRecallCallbackHost(HOST)).toBe(HOST);
    expect(normalizeRecallCallbackHost('  RECALL.Example.COM ')).toBe(HOST);
  });

  it('tolerates a pasted origin, with or without its trailing slash', () => {
    // What somebody copies out of a browser bar. Refusing it teaches nothing.
    expect(normalizeRecallCallbackHost(`https://${HOST}`)).toBe(HOST);
    expect(normalizeRecallCallbackHost(`https://${HOST}/`)).toBe(HOST);
  });

  it('REFUSES a path rather than trimming it', () => {
    // Silently dropping a base path would build `wss://host/recall/<token>`
    // for a deployment mounted under a prefix — a bot streaming to a 404.
    expect(normalizeRecallCallbackHost(`https://${HOST}/base`)).toBeNull();
    expect(normalizeRecallCallbackHost(`${HOST}/base`)).toBeNull();
    expect(normalizeRecallCallbackHost(`${HOST}?a=1`)).toBeNull();
    expect(normalizeRecallCallbackHost(`${HOST}#f`)).toBeNull();
  });

  it('refuses anything that is not a plain dotted DNS name', () => {
    // Each of these would end up inside a URL handed to the vendor.
    expect(normalizeRecallCallbackHost(`${HOST}:8443`)).toBeNull(); // a port
    expect(normalizeRecallCallbackHost('user@recall.example.com')).toBeNull(); // userinfo
    expect(normalizeRecallCallbackHost('[::1]')).toBeNull(); // IPv6 literal
    expect(normalizeRecallCallbackHost('recall example com')).toBeNull();
    expect(normalizeRecallCallbackHost('-recall.example.com')).toBeNull();
  });

  it('refuses a single label — nothing can present a cert for one', () => {
    expect(normalizeRecallCallbackHost('localhost')).toBeNull();
    expect(normalizeRecallCallbackHost('recall')).toBeNull();
  });

  it('is null for unset, empty and whitespace', () => {
    expect(normalizeRecallCallbackHost(undefined)).toBeNull();
    expect(normalizeRecallCallbackHost(null)).toBeNull();
    expect(normalizeRecallCallbackHost('')).toBeNull();
    expect(normalizeRecallCallbackHost('   ')).toBeNull();
  });
});

describe('wsBaseForRecall', () => {
  it('uses the callback host when one is configured', () => {
    expect(wsBaseForRecall({ callbackHost: HOST })).toBe(`wss://${HOST}`);
  });

  it('PREFERS the callback host over a public base URL that names another', () => {
    // The case the whole change exists for: two different hostnames, and the
    // vendor must be sent to the one without an Access application on it.
    expect(wsBaseForRecall({ callbackHost: HOST, publicBaseUrl: OPS })).toBe(`wss://${HOST}`);
  });

  it('falls back to the public base URL when no callback host is set', () => {
    expect(wsBaseForRecall({ publicBaseUrl: OPS })).toBe('wss://ops.example.com');
    // A base URL with a path keeps it — that fallback is unchanged.
    expect(wsBaseForRecall({ publicBaseUrl: 'https://ops.example.com/lf/' })).toBe(
      'wss://ops.example.com/lf',
    );
  });

  it('falls back when the callback host is set but unusable', () => {
    // A typo must degrade to the previous behaviour, not to a broken URL.
    expect(wsBaseForRecall({ callbackHost: 'not a host', publicBaseUrl: OPS })).toBe(
      'wss://ops.example.com',
    );
  });

  it('is null when neither is usable, which is what disables bots', () => {
    expect(wsBaseForRecall({})).toBeNull();
    // http:// in the fallback is REFUSED, never downgraded to ws:// — the
    // alternative is a meeting's audio in plaintext across the internet.
    expect(wsBaseForRecall({ publicBaseUrl: 'http://ops.example.com' })).toBeNull();
    expect(wsBaseForRecall({ callbackHost: 'nope', publicBaseUrl: 'http://ops.example.com' })).toBe(
      null,
    );
  });
});

describe('recallStatusWebhookUrl', () => {
  it('is the callback host under the same /recall/ prefix', () => {
    // This server never CALLS this URL — a human pastes it into the Recall
    // dashboard off the boot log — so the derivation is the only thing that
    // keeps it pointing at the same host as the websocket.
    expect(recallStatusWebhookUrl({ callbackHost: HOST })).toBe(`https://${HOST}/recall/status`);
    expect(recallStatusWebhookUrl({ callbackHost: HOST, publicBaseUrl: OPS })).toBe(
      `https://${HOST}/recall/status`,
    );
  });

  it('falls back to the public base URL, over https', () => {
    expect(recallStatusWebhookUrl({ publicBaseUrl: OPS })).toBe(
      'https://ops.example.com/recall/status',
    );
  });

  it('names the SAME host the websocket origin does, always', () => {
    // The failure this pins: the bot streams fine and every status change is
    // delivered to the other hostname. Asserted as a property over the cases
    // where the two inputs differ, rather than as one more literal.
    for (const opts of [
      { callbackHost: HOST, publicBaseUrl: OPS },
      { publicBaseUrl: OPS },
      { callbackHost: HOST },
      { callbackHost: 'bad host', publicBaseUrl: OPS },
    ]) {
      const ws = wsBaseForRecall(opts);
      const hook = recallStatusWebhookUrl(opts);
      expect(ws, JSON.stringify(opts)).not.toBeNull();
      expect(hook, JSON.stringify(opts)).toBe(
        `${(ws as string).replace('wss:', 'https:')}/recall/status`,
      );
    }
  });

  it('is null when there is no public address at all', () => {
    expect(recallStatusWebhookUrl({})).toBeNull();
    expect(recallStatusWebhookUrl({ publicBaseUrl: 'http://ops.example.com' })).toBeNull();
  });
});

describe('recallConfigFromEnv reads the callback host itself', () => {
  it('derives publicWsBase from CW_RECALL_CALLBACK_HOST, over the base URL', () => {
    // Read inside the config builder rather than threaded from bin.ts, so
    // there is one home for "where does the vendor dial" and no caller that
    // can pass one input and forget the other.
    const cfg = recallConfigFromEnv({ CW_RECALL_CALLBACK_HOST: HOST }, OPS);
    expect(cfg.publicWsBase).toBe(`wss://${HOST}`);
  });

  it('still derives from the base URL when the var is absent', () => {
    expect(recallConfigFromEnv({}, OPS).publicWsBase).toBe('wss://ops.example.com');
  });

  it('leaves bots disabled when neither is set', () => {
    expect(recallConfigFromEnv({}, undefined).publicWsBase).toBeNull();
  });
});
