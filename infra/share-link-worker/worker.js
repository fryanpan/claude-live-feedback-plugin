/**
 * Edge gate for signed share links. Routes covering `<publicHostname>/share/*`
 * run this before the origin sees the request: a URL whose signature or
 * expiry does not check out is 404'd at Cloudflare, so slug-guessing and
 * expired links never reach the tunnel. The origin re-validates every
 * /share/* request itself — this Worker is the first gate, never the only one.
 *
 * Deploying this (and setting SHARE_LINK_KEY) is a manual step — see README.md.
 */

/** Same check as the server's share/url-signing.ts: HMAC-SHA256 over `<id>.<exp>`. */
export async function verifySignedShare(shareId, exp, sig, key, now = Date.now()) {
  if (!/^\d{1,15}$/.test(exp) || !/^[0-9a-f]{64}$/.test(sig)) return false;
  if (Number(exp) * 1000 <= now) return false;
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(key), // UTF-8 bytes of the key string, no hex decode
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const sigBytes = Uint8Array.from(sig.match(/.{2}/g), (b) => Number.parseInt(b, 16));
  return crypto.subtle.verify('HMAC', cryptoKey, sigBytes, enc.encode(`${shareId}.${exp}`));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/share' || url.pathname.startsWith('/share/')) {
      // Only the exact redeem shape can pass, and only signed — no key
      // configured means NOTHING passes, never everything.
      const m = url.pathname.match(/^\/share\/([^/]+)$/);
      const ok =
        m &&
        env.SHARE_LINK_KEY &&
        (await verifySignedShare(
          decodeURIComponent(m[1]),
          url.searchParams.get('exp') ?? '',
          url.searchParams.get('sig') ?? '',
          env.SHARE_LINK_KEY,
        ));
      if (!ok) return new Response('Not found', { status: 404 });
    }
    return fetch(request);
  },
};
