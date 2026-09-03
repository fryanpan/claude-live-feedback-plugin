/**
 * `resolveStagingHost` is the one line that decided the 2026-09-0x outage:
 * a staging server bound the wildcard, inherited another fleet service's
 * port the moment that service restarted, and answered its callbacks
 * `unknown_host` behind a green health check. Pinned directly, not by
 * booting a server, per the pure-function pattern the rest of this file's
 * guardrails already use (`isPrimaryCheckout`, the reserved-port refusal).
 */
import { describe, expect, it } from 'vitest';
import { resolveStagingHost } from './staging.ts';

function argsFrom(pairs: Record<string, string>): (name: string) => string | undefined {
  return (name) => pairs[name];
}

describe('resolveStagingHost', () => {
  it('defaults to loopback with nothing set', () => {
    expect(resolveStagingHost(argsFrom({}))).toBe('127.0.0.1');
  });

  it('lets --host opt into the wildcard', () => {
    expect(resolveStagingHost(argsFrom({ host: '0.0.0.0' }))).toBe('0.0.0.0');
  });

  it('passes through any other explicit host unchanged', () => {
    expect(resolveStagingHost(argsFrom({ host: '10.0.0.5' }))).toBe('10.0.0.5');
  });
});
