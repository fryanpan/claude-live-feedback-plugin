/**
 * Web Push wire crypto: message encryption (RFC 8291, `aes128gcm` from
 * RFC 8188) and request authorization (VAPID, RFC 8292).
 *
 * Written against Web Crypto rather than pulled from npm. The whole of it is
 * two HKDFs, one ECDH, one AES-GCM seal and one ES256 signature — all of
 * which `crypto.subtle` already does — and it is exercised end to end by the
 * RFC's own published test vector, so the correctness question is settled by
 * the spec rather than by trust in a transitive dependency tree. This repo is
 * public and the server holds the operator's tasks; a push library is a lot
 * of third-party code to run next to that for a job this size.
 *
 * Nothing here reads or writes state. Key persistence is `push-store.ts`;
 * delivery and retry are `push-notify.ts`.
 */

/** Uncompressed P-256 point: 0x04 || X(32) || Y(32). */
const P256_POINT_BYTES = 65;
/** RFC 8291 §3.2 — the subscription's auth secret is always 16 bytes. */
const AUTH_SECRET_BYTES = 16;
/**
 * One record, and only ever one. RFC 8188 allows a stream of them; a push
 * message is small by construction (services cap the body at ~4KB anyway),
 * so multi-record framing would be code with no caller.
 */
const RECORD_SIZE = 4096;
const AES_TAG_BYTES = 16;
/** The 0x02 delimiter that marks the last record, per RFC 8188 §2. */
const LAST_RECORD_PAD = 0x02;
/** RFC 8292 §2 caps `exp` at 24h out. 12h leaves room for a slow clock. */
const VAPID_TTL_SECONDS = 12 * 60 * 60;

export interface VapidKeys {
  /** base64url, uncompressed P-256 point. This is the browser's `applicationServerKey`. */
  publicKey: string;
  /** base64url, the raw 32-byte private scalar. Never leaves the server. */
  privateKey: string;
}

export function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const utf8 = (s: string) => new TextEncoder().encode(s);

/**
 * A view whose backing store is a plain ArrayBuffer.
 *
 * Web Crypto's `BufferSource` will not accept `Uint8Array<ArrayBufferLike>`,
 * because a SharedArrayBuffer could be written from another thread mid-call.
 * `subarray()` widens to `ArrayBufferLike`, so every slice taken here has to
 * come back through `bytes()` before it reaches `crypto.subtle`. The copies
 * are 12-65 bytes on a path that already does an ECDH.
 */
type Bytes = Uint8Array<ArrayBuffer>;

function bytes(src: Uint8Array): Bytes {
  const out = new Uint8Array(src.length);
  out.set(src);
  return out;
}

/**
 * HKDF (RFC 5869) at the one length this protocol ever asks for — under one
 * hash block, so Expand is a single HMAC and the counter is always 0x01.
 */
async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Bytes> {
  const hmac = { name: 'HMAC', hash: 'SHA-256' } as const;
  const extractKey = await crypto.subtle.importKey('raw', bytes(salt), hmac, false, ['sign']);
  const prk = new Uint8Array(await crypto.subtle.sign('HMAC', extractKey, bytes(ikm)));
  const expandKey = await crypto.subtle.importKey('raw', prk, hmac, false, ['sign']);
  const okm = new Uint8Array(
    await crypto.subtle.sign('HMAC', expandKey, concat(info, new Uint8Array([1]))),
  );
  return bytes(okm.subarray(0, length));
}

/**
 * A raw private scalar is not importable on its own — Web Crypto wants a JWK,
 * and a JWK carrying `d` must also carry the matching `x`/`y`. Callers that
 * only kept the scalar therefore cannot use it; every path here keeps the
 * pair together for exactly that reason.
 */
async function importPrivateKey(
  publicKey: Uint8Array,
  privateKey: Uint8Array,
  algorithm: 'ECDH' | 'ECDSA',
  usages: KeyUsage[],
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      d: b64urlEncode(privateKey),
      x: b64urlEncode(publicKey.subarray(1, 33)),
      y: b64urlEncode(publicKey.subarray(33, 65)),
      ext: true,
    },
    { name: algorithm, namedCurve: 'P-256' },
    false,
    usages,
  );
}

export interface EncryptPushArgs {
  plaintext: Uint8Array;
  /** The subscription's `keys.p256dh`, decoded. */
  uaPublic: Uint8Array;
  /** The subscription's `keys.auth`, decoded. */
  authSecret: Uint8Array;
  /** Pinned only by the RFC-vector test; random per message otherwise. */
  salt?: Uint8Array;
  /** Pinned only by the RFC-vector test; ephemeral per message otherwise. */
  senderKeys?: { publicKey: Uint8Array; privateKey: Uint8Array };
}

/**
 * Seal a push message into an `aes128gcm` body, ready to POST at the
 * subscription endpoint.
 *
 * The sender keypair is ephemeral and per-message on purpose: it is NOT the
 * VAPID identity. Reusing the VAPID key here would tie every message to one
 * ECDH secret and make the server's long-lived identity key a decryption key
 * as well as a signing one.
 */
export async function encryptPushPayload(args: EncryptPushArgs): Promise<Uint8Array> {
  const { plaintext, uaPublic, authSecret } = args;

  if (uaPublic.length !== P256_POINT_BYTES || uaPublic[0] !== 0x04) {
    throw new Error(
      `push subscription p256dh must be a ${P256_POINT_BYTES}-byte uncompressed P-256 point`,
    );
  }
  if (authSecret.length !== AUTH_SECRET_BYTES) {
    throw new Error(`push subscription auth secret must be ${AUTH_SECRET_BYTES} bytes`);
  }
  // The delimiter and the GCM tag both ride inside the record.
  const maxPlaintext = RECORD_SIZE - AES_TAG_BYTES - 1;
  if (plaintext.length > maxPlaintext) {
    throw new Error(`push payload too large: ${plaintext.length} > ${maxPlaintext} bytes`);
  }

  const salt = args.salt ?? crypto.getRandomValues(new Uint8Array(16));

  let asPublic: Uint8Array;
  let asPrivateKey: CryptoKey;
  if (args.senderKeys) {
    asPublic = args.senderKeys.publicKey;
    asPrivateKey = await importPrivateKey(asPublic, args.senderKeys.privateKey, 'ECDH', [
      'deriveBits',
    ]);
  } else {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
      'deriveBits',
    ])) as CryptoKeyPair;
    asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    asPrivateKey = pair.privateKey;
  }

  const uaKey = await crypto.subtle.importKey(
    'raw',
    bytes(uaPublic),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asPrivateKey, 256),
  );

  // RFC 8291 §3.4: mix the shared secret with the subscription's auth secret,
  // binding the result to BOTH public keys so a message cannot be replayed at
  // a different subscriber.
  const keyInfo = concat(utf8('WebPush: info'), new Uint8Array([0]), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  // RFC 8188 §2.2: content encryption key and nonce, both salted by the
  // record salt that travels in the header.
  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const record = concat(plaintext, new Uint8Array([LAST_RECORD_PAD]));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, record),
  );

  // Header: salt(16) | rs(uint32be) | idlen(uint8) | keyid(= sender public key)
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, RECORD_SIZE, false);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ciphertext);
}

/** Mint a fresh VAPID identity. Called once, on the server's first push send. */
export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  if (!jwk.d) throw new Error('generated VAPID key has no private scalar');
  return { publicKey: b64urlEncode(publicKey), privateKey: jwk.d };
}

/**
 * Check that a stored pair is usable before anything depends on it — a
 * truncated or hand-edited key file should fail at load with a clear error
 * rather than at send time as an opaque push-service rejection.
 */
export async function importVapidKeys(keys: VapidKeys): Promise<CryptoKey> {
  const pub = b64urlDecode(keys.publicKey);
  if (pub.length !== P256_POINT_BYTES || pub[0] !== 0x04) {
    throw new Error('VAPID public key is not an uncompressed P-256 point');
  }
  const priv = b64urlDecode(keys.privateKey);
  if (priv.length !== 32) throw new Error('VAPID private key is not a 32-byte P-256 scalar');
  return importPrivateKey(pub, priv, 'ECDSA', ['sign']);
}

export interface VapidAuthArgs {
  /** The subscription endpoint. Only its origin reaches the token. */
  endpoint: string;
  keys: VapidKeys;
  /** `mailto:` or `https:`, per RFC 8292 §2.1 — who to contact about this sender. */
  subject: string;
  now?: number;
}

/**
 * Build the `Authorization` header for a push request: a signed JWT plus the
 * public key the push service checks it against.
 */
export async function vapidAuthorization(args: VapidAuthArgs): Promise<string> {
  if (!/^(mailto:|https:)/.test(args.subject)) {
    throw new Error('VAPID subject must be a mailto: or https: URI');
  }
  const now = args.now ?? Date.now();
  const audience = new URL(args.endpoint).origin;

  const header = b64urlEncode(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64urlEncode(
    utf8(
      JSON.stringify({
        aud: audience,
        exp: Math.floor(now / 1000) + VAPID_TTL_SECONDS,
        sub: args.subject,
      }),
    ),
  );
  const signingInput = utf8(`${header}.${claims}`);

  const key = await importVapidKeys(args.keys);
  // Web Crypto emits the raw r||s form ES256 wants. Node's `crypto.sign` emits
  // DER, which push services reject with a bare 401 and no explanation.
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, signingInput),
  );

  return `vapid t=${header}.${claims}.${b64urlEncode(signature)}, k=${args.keys.publicKey}`;
}
