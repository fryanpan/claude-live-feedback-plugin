/** The duration grammar `share_link({ ttl })` accepts: `<integer><s|m|h|d|w>`. */
import { describe, expect, it } from 'bun:test';
import { parseTtl } from '../src/share/ttl.ts';

describe('parseTtl', () => {
  it('reads the units the tool schema advertises', () => {
    expect(parseTtl('90s')).toBe(90);
    expect(parseTtl('15m')).toBe(900);
    expect(parseTtl('2h')).toBe(7200);
    expect(parseTtl('3d')).toBe(3 * 86400);
    expect(parseTtl('1w')).toBe(7 * 86400);
  });

  it('answers null for anything else — the caller turns that into a 400', () => {
    for (const bad of ['', '15', 'm', '15 m', '15M', '1.5h', '-1h', '+1h', '15min', '0x10m']) {
      expect(parseTtl(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('parses zero (so the caller can refuse it as below the minimum, by name)', () => {
    expect(parseTtl('0m')).toBe(0);
  });
});
