import { describe, expect, it } from 'bun:test';
import { UNKNOWN_CLIENT, clientAddressKey } from '../src/middleware/client-address.ts';

/**
 * The cases are written in the vocabulary of the measurement in the module
 * header: `tailscale serve` REPLACES `x-forwarded-for`, Cloudflare APPENDS to
 * it, and a client talking to the port directly controls it completely.
 */
const key = (socketAddress: string | null | undefined, forwardedFor?: string | null) =>
  clientAddressKey({ socketAddress, forwardedFor: forwardedFor ?? null });

describe('clientAddressKey — behind a trusted proxy', () => {
  it('keys on the forwarded client, not the loopback socket', () => {
    // What `tailscale serve` delivers: loopback socket, tailnet client.
    expect(key('127.0.0.1', '100.64.0.5')).toBe('100.64.0.5');
    expect(key('127.0.0.1', '100.64.0.5')).not.toBe('127.0.0.1');
  });

  it('gives two clients through the same proxy DIFFERENT buckets', () => {
    // The whole point: these two used to collapse onto one key and share a
    // 15-start budget, so one person retrying locked the other out.
    expect(key('127.0.0.1', '100.64.0.5')).not.toBe(key('127.0.0.1', '100.64.2.9'));
  });

  it('accepts the ::1 and IPv4-mapped spellings of a loopback socket', () => {
    expect(key('::1', '203.0.113.7')).toBe('203.0.113.7');
    expect(key('::ffff:127.0.0.1', '203.0.113.7')).toBe('203.0.113.7');
    // Loopback is the whole of 127.0.0.0/8, not just .0.1.
    expect(key('127.0.0.2', '203.0.113.7')).toBe('203.0.113.7');
  });

  it('takes the RIGHTMOST entry, which is the one our proxy appended', () => {
    // Measured on the Cloudflare path: a client sending `9.9.9.9` arrives as
    // `9.9.9.9,<real>`. Reading the header left-to-right — the usual way —
    // would hand that client its own choice of bucket.
    expect(key('127.0.0.1', '9.9.9.9,198.51.100.7')).toBe('198.51.100.7');
    expect(key('127.0.0.1', '9.9.9.9, 198.51.100.7')).toBe('198.51.100.7');
    expect(key('127.0.0.1', '9.9.9.9,198.51.100.7')).not.toBe('9.9.9.9');
  });

  it('cannot be pushed off the real entry by padding the list', () => {
    const forged = `${Array(500).fill('9.9.9.9').join(',')},198.51.100.7`;
    expect(key('127.0.0.1', forged)).toBe('198.51.100.7');
  });

  it('ignores a trailing empty entry rather than keying on it', () => {
    expect(key('127.0.0.1', '9.9.9.9,198.51.100.7,')).toBe('198.51.100.7');
    expect(key('127.0.0.1', '198.51.100.7, ,')).toBe('198.51.100.7');
  });
});

describe('clientAddressKey — NOT behind a trusted proxy', () => {
  it('refuses a forged forwarding header from a direct LAN client', () => {
    // Measured row four: a client on the LAN talking straight to the port can
    // put anything in the header. It must not get to pick its bucket.
    expect(key('192.168.1.23', '9.9.9.9')).toBe('192.168.1.23');
    expect(key('192.168.1.23', '9.9.9.9')).not.toBe('9.9.9.9');
  });

  it('refuses a forged header from a direct tailnet client', () => {
    expect(key('100.64.0.5', '9.9.9.9')).toBe('100.64.0.5');
  });

  it('gives an attacker ONE bucket however many identities they claim', () => {
    const forgeries = ['1.1.1.1', '2.2.2.2', '3.3.3.3,4.4.4.4', '2001:db8::1'];
    const keys = new Set(forgeries.map((f) => key('198.51.100.9', f)));
    expect([...keys]).toEqual(['198.51.100.9']);
  });
});

describe('clientAddressKey — no forwarding header at all', () => {
  it('keys a direct loopback request on the socket', () => {
    expect(key('127.0.0.1')).toBe('127.0.0.1');
    // `::1` goes through the same /64 rule as any other IPv6 address, so its
    // key is the prefix rather than the literal. Only loopback itself lives
    // in `::/64`, so this stays one stable bucket for local callers — which
    // is all the key has to be. Asserted so the shape is a decision.
    expect(key('::1')).toBe('0000:0000:0000:0000');
    expect(key('::1')).toBe(key('::1'));
    expect(key('::1')).not.toBe(key('198.51.100.9'));
  });

  it('keys a direct remote request on the socket', () => {
    expect(key('198.51.100.9')).toBe('198.51.100.9');
  });

  it('falls back to the socket when the header is unparseable', () => {
    // Strictly the pre-fix behaviour, reached only when there is nothing
    // better to key on — never an attacker-chosen key.
    for (const junk of ['not-an-ip', '', '   ', 'evil.example.com', '127.0.0.1.evil.example']) {
      expect(key('127.0.0.1', junk)).toBe('127.0.0.1');
    }
  });

  it('shares one bucket when the peer address is unreadable', () => {
    expect(key(null)).toBe(UNKNOWN_CLIENT);
    expect(key(undefined)).toBe(UNKNOWN_CLIENT);
    // And a forwarding header does not rescue it: with no socket to check,
    // there is no evidence a proxy was involved, so the claim is not read.
    expect(key(null, '203.0.113.7')).toBe(UNKNOWN_CLIENT);
  });
});

describe('clientAddressKey — normalisation', () => {
  it('unwraps IPv4-mapped IPv6 so one client is one bucket', () => {
    expect(key('127.0.0.1', '::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(key('::ffff:198.51.100.9')).toBe('198.51.100.9');
  });

  it('strips a port from a forwarded entry', () => {
    expect(key('127.0.0.1', '203.0.113.7:51234')).toBe('203.0.113.7');
    expect(key('127.0.0.1', '[2001:db8::1]:443')).toBe(key('127.0.0.1', '2001:db8::1'));
  });

  it('buckets IPv6 by /64, so one client cannot rotate through a subnet', () => {
    const a = key('127.0.0.1', '2001:db8:1:2::1');
    const b = key('127.0.0.1', '2001:db8:1:2::beef');
    const c = key('127.0.0.1', '2001:db8:1:2:ffff:ffff:ffff:ffff');
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it('keeps different /64s in different buckets', () => {
    expect(key('127.0.0.1', '2001:db8:1:2::1')).not.toBe(key('127.0.0.1', '2001:db8:1:3::1'));
  });

  it('treats every spelling of one prefix as one bucket', () => {
    const canonical = key('127.0.0.1', '2001:0db8:0000:0000:0000:0000:0000:0001');
    expect(key('127.0.0.1', '2001:db8::1')).toBe(canonical);
    expect(key('127.0.0.1', '2001:DB8::1')).toBe(canonical);
    expect(key('127.0.0.1', '2001:db8:0:0::1')).toBe(canonical);
  });

  it('does not confuse an IPv4 bucket with an IPv6 one', () => {
    expect(key('127.0.0.1', '203.0.113.7')).not.toBe(key('127.0.0.1', '2001:db8::203.0.113.7'));
  });
});
