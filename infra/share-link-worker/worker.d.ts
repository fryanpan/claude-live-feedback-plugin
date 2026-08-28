/**
 * Types for the plain-JS Worker, for the server test that cross-verifies
 * signatures against it. The Worker itself ships as worker.js — Cloudflare
 * never sees this file.
 */
export function verifySignedShare(
  shareId: string,
  exp: string,
  sig: string,
  key: string,
  now?: number,
): Promise<boolean>;

declare const handler: {
  fetch(request: Request, env: { SHARE_LINK_KEY?: string }): Promise<Response>;
};
export default handler;
