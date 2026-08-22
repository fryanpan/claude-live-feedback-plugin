/**
 * Web Push message encryption (RFC 8291 / RFC 8188 `aes128gcm`) and VAPID
 * request signing (RFC 8292).
 *
 * The load-bearing test is the RFC 8291 §5 vector: its keys, its salt, its
 * plaintext, and its published ciphertext, byte for byte. That matters more
 * than the usual round-trip because a push service is the only other
 * implementation we ever talk to and it never tells us WHY it rejected a
 * body — a 400 from a browser vendor is the whole error report. A round-trip
 * against our own decrypt would agree with itself while both halves shared a
 * misreading of the spec, which is exactly the bug that would ship silently.
 * All other fixtures are synthetic.
 */

import { describe, expect, it } from 'bun:test';
import {
  b64urlDecode,
  b64urlEncode,
  encryptPushPayload,
  generateVapidKeys,
  importVapidKeys,
  vapidAuthorization,
} from '../src/push-crypto.ts';

/** RFC 8291 §5. */
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  uaPublic:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  asPublic:
    'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
    'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
    'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

describe('base64url', () => {
  it('round-trips bytes that need padding and the URL-safe alphabet', () => {
    // 0xFB 0xFF encodes to "-_" in base64url and "+/" in standard base64.
    const bytes = new Uint8Array([0xfb, 0xff, 0x00, 0x01]);
    const enc = b64urlEncode(bytes);
    expect(enc).not.toContain('=');
    expect(enc).not.toContain('+');
    expect(enc).not.toContain('/');
    expect([...b64urlDecode(enc)]).toEqual([...bytes]);
  });

  it('decodes the RFC salt to exactly 16 bytes', () => {
    expect(b64urlDecode(RFC.salt).length).toBe(16);
  });

  it('decodes the RFC public keys to uncompressed P-256 points', () => {
    const ua = b64urlDecode(RFC.uaPublic);
    expect(ua.length).toBe(65);
    expect(ua[0]).toBe(0x04);
  });
});

describe('encryptPushPayload — RFC 8291 §5 vector', () => {
  it('reproduces the published ciphertext byte for byte', async () => {
    const body = await encryptPushPayload({
      plaintext: new TextEncoder().encode(RFC.plaintext),
      uaPublic: b64urlDecode(RFC.uaPublic),
      authSecret: b64urlDecode(RFC.authSecret),
      // Pinning both the salt and the sender keypair is what makes the output
      // deterministic; in production both are freshly random per message.
      salt: b64urlDecode(RFC.salt),
      senderKeys: {
        publicKey: b64urlDecode(RFC.asPublic),
        privateKey: b64urlDecode(RFC.asPrivate),
      },
    });
    expect(b64urlEncode(body)).toBe(RFC.body);
  });

  it('lays the aes128gcm header out as salt | rs | idlen | sender key', async () => {
    const body = await encryptPushPayload({
      plaintext: new TextEncoder().encode(RFC.plaintext),
      uaPublic: b64urlDecode(RFC.uaPublic),
      authSecret: b64urlDecode(RFC.authSecret),
      salt: b64urlDecode(RFC.salt),
      senderKeys: {
        publicKey: b64urlDecode(RFC.asPublic),
        privateKey: b64urlDecode(RFC.asPrivate),
      },
    });
    expect([...body.subarray(0, 16)]).toEqual([...b64urlDecode(RFC.salt)]);
    // Record size, uint32 big-endian. 4096 is what every push service accepts.
    const rs = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0, false);
    expect(rs).toBe(4096);
    expect(body[20]).toBe(65); // keyid length
    expect([...body.subarray(21, 86)]).toEqual([...b64urlDecode(RFC.asPublic)]);
  });

  it('produces a different body each call when salt and keypair are not pinned', async () => {
    const args = {
      plaintext: new TextEncoder().encode('hello'),
      uaPublic: b64urlDecode(RFC.uaPublic),
      authSecret: b64urlDecode(RFC.authSecret),
    };
    const a = await encryptPushPayload(args);
    const b = await encryptPushPayload(args);
    expect(b64urlEncode(a)).not.toBe(b64urlEncode(b));
  });

  it('refuses a subscription key that is not an uncompressed P-256 point', async () => {
    await expect(
      encryptPushPayload({
        plaintext: new TextEncoder().encode('hello'),
        uaPublic: new Uint8Array(32),
        authSecret: b64urlDecode(RFC.authSecret),
      }),
    ).rejects.toThrow(/p256dh/i);
  });

  it('refuses an auth secret of the wrong length', async () => {
    await expect(
      encryptPushPayload({
        plaintext: new TextEncoder().encode('hello'),
        uaPublic: b64urlDecode(RFC.uaPublic),
        authSecret: new Uint8Array(8),
      }),
    ).rejects.toThrow(/auth/i);
  });

  it('refuses a payload too large for one 4096-byte record', async () => {
    await expect(
      encryptPushPayload({
        plaintext: new Uint8Array(4096),
        uaPublic: b64urlDecode(RFC.uaPublic),
        authSecret: b64urlDecode(RFC.authSecret),
      }),
    ).rejects.toThrow(/too large/i);
  });
});

describe('generateVapidKeys', () => {
  it('mints an uncompressed P-256 public point and a 32-byte private scalar', async () => {
    const keys = await generateVapidKeys();
    const pub = b64urlDecode(keys.publicKey);
    expect(pub.length).toBe(65);
    expect(pub[0]).toBe(0x04);
    expect(b64urlDecode(keys.privateKey).length).toBe(32);
  });

  it('mints a different pair each time', async () => {
    const a = await generateVapidKeys();
    const b = await generateVapidKeys();
    expect(a.privateKey).not.toBe(b.privateKey);
  });

  it('produces a pair that importVapidKeys accepts', async () => {
    const keys = await generateVapidKeys();
    await expect(importVapidKeys(keys)).resolves.toBeDefined();
  });
});

describe('vapidAuthorization', () => {
  const keys = { publicKey: RFC.asPublic, privateKey: RFC.asPrivate };

  it('is a vapid scheme carrying the token and the public key', async () => {
    const header = await vapidAuthorization({
      endpoint: 'https://push.example.net/push/abc123',
      keys,
      subject: 'mailto:ops@example.com',
      now: 1_770_000_000_000,
    });
    expect(header.startsWith('vapid t=')).toBe(true);
    const m = header.match(/^vapid t=([^,]+), k=(.+)$/);
    expect(m).not.toBeNull();
    expect(m?.[2]).toBe(RFC.asPublic);
  });

  it('scopes the audience to the push service ORIGIN, not the full endpoint', async () => {
    const header = await vapidAuthorization({
      endpoint: 'https://push.example.net/push/abc123?x=1',
      keys,
      subject: 'mailto:ops@example.com',
      now: 1_770_000_000_000,
    });
    const jwt = header.slice('vapid t='.length).split(',')[0]!;
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(jwt.split('.')[1]!)));
    // The endpoint path is a capability. Putting it in `aud` would hand the
    // push service a token scoped to one subscriber's secret URL.
    expect(claims.aud).toBe('https://push.example.net');
    expect(claims.sub).toBe('mailto:ops@example.com');
  });

  it('expires in the future and within the 24h the spec allows', async () => {
    const now = 1_770_000_000_000;
    const header = await vapidAuthorization({
      endpoint: 'https://push.example.net/push/abc',
      keys,
      subject: 'mailto:ops@example.com',
      now,
    });
    const jwt = header.slice('vapid t='.length).split(',')[0]!;
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(jwt.split('.')[1]!)));
    const nowSec = Math.floor(now / 1000);
    expect(claims.exp).toBeGreaterThan(nowSec);
    expect(claims.exp).toBeLessThanOrEqual(nowSec + 24 * 60 * 60);
  });

  it('signs with ES256 over the P-256 key', async () => {
    const header = await vapidAuthorization({
      endpoint: 'https://push.example.net/push/abc',
      keys,
      subject: 'mailto:ops@example.com',
      now: 1_770_000_000_000,
    });
    const jwt = header.slice('vapid t='.length).split(',')[0]!;
    const head = JSON.parse(new TextDecoder().decode(b64urlDecode(jwt.split('.')[0]!)));
    expect(head.alg).toBe('ES256');
    // Raw ES256 signature: r and s, 32 bytes each. A DER-wrapped signature is
    // the classic way this header gets silently rejected.
    expect(b64urlDecode(jwt.split('.')[2]!).length).toBe(64);
  });

  it('refuses a subject that is not mailto: or https:', async () => {
    await expect(
      vapidAuthorization({
        endpoint: 'https://push.example.net/push/abc',
        keys,
        subject: 'ops@example.com',
        now: 1_770_000_000_000,
      }),
    ).rejects.toThrow(/subject/i);
  });
});
