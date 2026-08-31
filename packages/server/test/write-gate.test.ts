/**
 * The predicates behind the sign-in write gate.
 *
 * Unit coverage for the decisions the gate makes; `auth-write-gate.test.ts`
 * drives the real route table, because a gate wired in after a route that
 * already answered would pass every test in this file.
 */
import { describe, expect, it } from 'bun:test';
import {
  SIGN_IN_REQUIRED_ERROR,
  isBrowserRequest,
  isGatedWrite,
  isReadShapedPost,
  isSignInFlowPath,
  signInRequiredBody,
} from '../src/middleware/write-gate.ts';

const headers = (h: Record<string, string>): Headers => new Headers(h);

describe('telling a browser from an agent', () => {
  it('calls a request with no Origin and no Sec-Fetch-* an agent', () => {
    // Every MCP tool, every curl, every webhook. They cannot sign in and must
    // not be asked to.
    expect(isBrowserRequest(headers({ 'content-type': 'application/json' }))).toBe(false);
  });

  it('calls a request carrying Origin a browser', () => {
    expect(isBrowserRequest(headers({ origin: 'http://localhost:8787' }))).toBe(true);
  });

  it('calls `Origin: null` a browser', () => {
    // A file:// page or a sandboxed iframe. Emphatically a browser — refusing
    // it is the ORIGIN check's job, and misreading it as an agent would hand
    // the one origin we trust least the one path that skips the gate.
    expect(isBrowserRequest(headers({ origin: 'null' }))).toBe(true);
  });

  it('calls a request carrying only Sec-Fetch-* a browser', () => {
    // The belt to Origin's braces: a browser that somehow omitted Origin is
    // still a browser, and no HTTP client in this repo sends these.
    expect(isBrowserRequest(headers({ 'sec-fetch-site': 'same-origin' }))).toBe(true);
    expect(isBrowserRequest(headers({ 'sec-fetch-mode': 'cors' }))).toBe(true);
    expect(isBrowserRequest(headers({ 'sec-fetch-dest': 'empty' }))).toBe(true);
  });

  it('reads the header name case-insensitively, as HTTP does', () => {
    expect(isBrowserRequest(headers({ Origin: 'http://localhost:8787' }))).toBe(true);
  });

  it('treats an EMPTY Origin as a browser too', () => {
    // Presence, not value. A gate that required a non-empty string could be
    // stepped around by sending the header blank.
    expect(isBrowserRequest(headers({ origin: '' }))).toBe(true);
  });
});

describe('which requests the gate governs', () => {
  it('never governs a read', () => {
    // Reading stays open to everyone — the decision this gate was built to.
    for (const m of ['GET', 'HEAD', 'get', 'head']) {
      expect(isGatedWrite(m, '/api/docs')).toBe(false);
    }
  });

  it('never governs a preflight', () => {
    // OPTIONS is answered above the gate anyway; refusing it would break the
    // widget's cross-origin writes before the real request was ever sent.
    expect(isGatedWrite('OPTIONS', '/api/docs')).toBe(false);
  });

  it('governs every mutating method', () => {
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'post']) {
      expect(isGatedWrite(m, '/api/docs/d1/threads')).toBe(true);
    }
  });

  it('governs a route nobody has written yet', () => {
    // The point of keying on method rather than on a list of routes: the
    // list is the thing that silently stops being complete.
    expect(isGatedWrite('POST', '/api/some-route-invented-next-year')).toBe(true);
  });

  it('never governs the sign-in flow itself', () => {
    // Gating these would be a deadlock: no session, so no writes, so no way
    // to post the email that mints one.
    for (const p of [
      '/api/auth/start',
      '/api/auth/verify',
      '/api/auth/logout',
      '/api/auth/profile',
      '/api/auth/widget-token',
    ]) {
      expect(isSignInFlowPath(p)).toBe(true);
      expect(isGatedWrite('POST', p)).toBe(false);
    }
  });

  it('does not let a lookalike path claim the sign-in exemption', () => {
    expect(isSignInFlowPath('/api/authors')).toBe(false);
    expect(isGatedWrite('POST', '/api/authors')).toBe(true);
  });

  it('lets a POST that only reads through', () => {
    // `/api/links/titles` batches a render burst's URLs into one lookup and
    // changes nothing. Gated, an unsigned reader's link chips silently never
    // resolve and the refusal says "Reading needs no account" while refusing
    // a read.
    expect(isReadShapedPost('/api/links/titles')).toBe(true);
    expect(isGatedWrite('POST', '/api/links/titles')).toBe(false);
  });

  it('lets a reader OPEN a doc it is allowed to read', () => {
    // The ship-blocker this closes: the redline surface opens its companion
    // doc with `POST /api/reviews/<id>/editable-file` at mount. Gated, it got
    // a 401, fell back to the derived redline over the MEMBER doc, and the
    // chrome then read a different set of comment threads — so a signed-out
    // reader saw comments nobody else saw and missed the ones everybody else
    // did. Silently. The `.md` File view fell back to raw source for the same
    // reason, and the refusal also raised a blocking sign-in modal on plain
    // page load.
    for (const p of [
      '/api/reviews/rev-1/editable-file',
      '/api/reviews/rev-1/context-file',
      // Both prefixes: `/api/workspaces/<id>/…` is the live alias every open
      // browser tab and un-restartable plugin bundle still calls.
      '/api/workspaces/rev-1/editable-file',
      '/api/workspaces/rev-1/context-file',
    ]) {
      expect(isReadShapedPost(p)).toBe(true);
      expect(isGatedWrite('POST', p)).toBe(false);
    }
  });

  it('exempts the OPEN and nothing else on the same review', () => {
    // The control. These are real writes on the very same prefix, and an
    // exemption that took them too would be a hole rather than a fix.
    for (const p of [
      '/api/reviews/rev-1/refresh',
      '/api/reviews/rev-1/groups',
      '/api/reviews/rev-1/editable-file/extra',
      '/api/reviews/rev-1/editable-fileX',
      '/api/reviews/editable-file',
      '/api/reviews/rev-1/sub/context-file',
    ]) {
      expect(isReadShapedPost(p)).toBe(false);
      expect(isGatedWrite('POST', p)).toBe(true);
    }
  });

  it('matches the read exemption exactly, never as a prefix', () => {
    // The control for the entry above: a route that merely starts the same
    // way is a real write and must stay gated, or the exemption grows on its
    // own every time somebody names a route conveniently.
    for (const p of ['/api/links/titles/bulk', '/api/links', '/api/links/titlesX']) {
      expect(isReadShapedPost(p)).toBe(false);
      expect(isGatedWrite('POST', p)).toBe(true);
    }
  });
});

describe('what the refusal says', () => {
  it('names the action and carries the URL that performs it', () => {
    // A bare 401 is indistinguishable from a bug. The browser client keys
    // its prompt off `error`, and shows `message` to the person.
    const body = signInRequiredBody();
    expect(body.error).toBe(SIGN_IN_REQUIRED_ERROR);
    expect(body.signInUrl).toBe('/signin');
    expect(body.message).toMatch(/sign in/i);
    // And says the part a refused reader most needs to hear.
    expect(body.message).toMatch(/reading/i);
  });
});
