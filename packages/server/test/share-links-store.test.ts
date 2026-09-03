/**
 * The share-link store on its own — the record, the states it moves between,
 * and the membership redeeming one creates.
 *
 * The HTTP half is `share-link-flow.test.ts`; this file is the unit test the
 * testing standard asks of every new server module, and it exists because the
 * three rules the gate depends on are all decisions this module makes alone:
 * a link is an invitation rather than a credential, a link that is not live
 * records nothing, and no expiry is different from an expiry that passed.
 *
 * Time is passed in rather than waited on. Every state and redeem call takes a
 * `now`, so "a link that lapsed" is a number, not a sleep.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShareLinks } from '../src/share/share-links.ts';

const BOARD = 'w-board-1';
const OTHER_BOARD = 'w-board-2';
const REVIEWER = 'reviewer@partner.example';
const OTHER_REVIEWER = 'someone-else@partner.example';

describe('the share-link store', () => {
  let dataDir: string;
  let links: ShareLinks;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'share-links-store-'));
    links = new ShareLinks({ dataDir });
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  const mint = (opts: { ttlSeconds?: number; workspaceId?: string } = {}) =>
    links.create({
      workspaceId: opts.workspaceId ?? BOARD,
      createdBy: 'Test Agent',
      ...(opts.ttlSeconds !== undefined ? { ttlSeconds: opts.ttlSeconds } : {}),
    });

  describe('minting', () => {
    it('gives every link an id no two links share', () => {
      // 128 bits, so this asserts the generator is not returning a constant
      // rather than sampling the distribution — the failure mode a fixed id
      // would produce is every link opening every board.
      const ids = new Set(Array.from({ length: 50 }, () => mint().linkId));
      expect(ids.size).toBe(50);
      for (const id of ids) expect(id).toMatch(/^[0-9a-f]{32}$/);
    });

    it('defaults to NO expiry, and honours one when asked for', () => {
      expect(mint().expiresAt).toBeNull();
      const dated = mint({ ttlSeconds: 3600 });
      expect(dated.expiresAt).not.toBeNull();
      // Live now, lapsed after its own expiry — read off the record rather
      // than off the wall clock.
      expect(links.state(dated.linkId, dated.expiresAt!)).toBe('expired');
      expect(links.state(dated.linkId, dated.expiresAt! - 1)).toBe('live');
    });

    it('refuses a TTL that would produce a link broken on arrival', () => {
      for (const ttlSeconds of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => mint({ ttlSeconds })).toThrow();
      }
      // Positive control: the same call with a real TTL mints.
      expect(mint({ ttlSeconds: 60 }).linkId).toBeTruthy();
    });

    it('refuses a link that names no workspace', () => {
      expect(() => links.create({ workspaceId: '', createdBy: 'Test Agent' })).toThrow();
    });
  });

  describe('redeeming', () => {
    it('makes the verified email a member, and says it added one', () => {
      const link = mint();
      expect(links.isMember(BOARD, REVIEWER)).toBe(false);
      const first = links.redeem(link.linkId, REVIEWER);
      expect(first).toEqual({ ok: true, workspaceId: BOARD, added: true });
      expect(links.isMember(BOARD, REVIEWER)).toBe(true);
    });

    it('is idempotent — a second visit adds no member and no redemption', () => {
      const link = mint();
      links.redeem(link.linkId, REVIEWER);
      const second = links.redeem(link.linkId, REVIEWER);
      expect(second).toEqual({ ok: true, workspaceId: BOARD, added: false });
      expect(links.membersOf(BOARD)).toHaveLength(1);
      expect(links.get(link.linkId)?.redemptions).toHaveLength(1);
    });

    it('folds the address the way the roster does, so a capitalised one is the same person', () => {
      const link = mint();
      links.redeem(link.linkId, REVIEWER);
      const again = links.redeem(link.linkId, REVIEWER.toUpperCase());
      expect(again).toEqual({ ok: true, workspaceId: BOARD, added: false });
      expect(links.isMember(BOARD, REVIEWER.toUpperCase())).toBe(true);
    });

    it('records the redemption with who and when', () => {
      const link = mint();
      const before = Date.now();
      links.redeem(link.linkId, REVIEWER);
      const [redemption] = links.get(link.linkId)?.redemptions ?? [];
      expect(redemption?.email).toBe(REVIEWER);
      expect(redemption?.at).toBeGreaterThanOrEqual(before);
    });

    it('admits nobody with no email — a token with no claim is not a person', () => {
      const link = mint();
      expect(links.redeem(link.linkId, '')).toEqual({ ok: false, state: 'unknown' });
      expect(links.membersOf(BOARD)).toHaveLength(0);
    });

    it('grants the workspace the LINK names, never one the caller does', () => {
      // There is no parameter for it, and that is the assertion: the
      // workspace comes off the record, so nothing a visitor sends can move
      // a redemption onto another board.
      const link = mint({ workspaceId: OTHER_BOARD });
      const outcome = links.redeem(link.linkId, REVIEWER);
      expect(outcome).toEqual({ ok: true, workspaceId: OTHER_BOARD, added: true });
      expect(links.isMember(BOARD, REVIEWER)).toBe(false);
    });
  });

  describe('a link that is not live records nothing', () => {
    it('refuses an unknown id, and says the same as a revoked one', () => {
      expect(links.redeem('0'.repeat(32), REVIEWER)).toEqual({ ok: false, state: 'unknown' });
      const revoked = mint();
      links.revoke(revoked.linkId);
      expect(links.redeem(revoked.linkId, REVIEWER)).toEqual({ ok: false, state: 'revoked' });
      expect(links.membersOf(BOARD)).toHaveLength(0);
    });

    it('refuses a lapsed link, and writes no member on the way out', () => {
      const link = mint({ ttlSeconds: 60 });
      const after = link.expiresAt! + 1;
      expect(links.redeem(link.linkId, REVIEWER, after)).toEqual({ ok: false, state: 'expired' });
      expect(links.isMember(BOARD, REVIEWER)).toBe(false);
      // Positive control: the same link a moment earlier admits them, so the
      // refusal above is the expiry and not a dead store.
      expect(links.redeem(link.linkId, REVIEWER, link.expiresAt! - 1).ok).toBe(true);
    });
  });

  describe('revoking a link and removing a member are different acts', () => {
    it('revoking stops new arrivals and keeps the ones already in', () => {
      const link = mint();
      links.redeem(link.linkId, REVIEWER);
      expect(links.revoke(link.linkId)).toBe(true);
      expect(links.isMember(BOARD, REVIEWER)).toBe(true);
      expect(links.redeem(link.linkId, OTHER_REVIEWER)).toEqual({ ok: false, state: 'revoked' });
      expect(links.isMember(BOARD, OTHER_REVIEWER)).toBe(false);
    });

    it('revoking twice is not a second revocation', () => {
      const link = mint();
      expect(links.revoke(link.linkId)).toBe(true);
      expect(links.revoke(link.linkId)).toBe(false);
    });

    it('removing a member ends their access and leaves everyone else in', () => {
      const link = mint();
      links.redeem(link.linkId, REVIEWER);
      links.redeem(link.linkId, OTHER_REVIEWER);
      expect(links.removeMember(BOARD, REVIEWER)).toBe(true);
      expect(links.isMember(BOARD, REVIEWER)).toBe(false);
      expect(links.isMember(BOARD, OTHER_REVIEWER)).toBe(true);
      // The link is still live, so they could come back through it — which is
      // the honest behaviour, and why revoking the link is the other half.
      expect(links.redeem(link.linkId, REVIEWER)).toEqual({
        ok: true,
        workspaceId: BOARD,
        added: true,
      });
    });

    it('removing keeps the redemption history, so who was ever admitted survives', () => {
      const link = mint();
      links.redeem(link.linkId, REVIEWER);
      links.removeMember(BOARD, REVIEWER);
      expect(links.get(link.linkId)?.redemptions.map((r) => r.email)).toEqual([REVIEWER]);
    });

    it('removing somebody who is not a member changes nothing', () => {
      mint();
      expect(links.removeMember(BOARD, REVIEWER)).toBe(false);
    });
  });

  describe('membership is per workspace', () => {
    it('a member of one board is not a member of another', () => {
      links.redeem(mint({ workspaceId: BOARD }).linkId, REVIEWER);
      expect(links.isMember(BOARD, REVIEWER)).toBe(true);
      expect(links.isMember(OTHER_BOARD, REVIEWER)).toBe(false);
    });

    it('answers no for an empty workspace or an absent email', () => {
      links.redeem(mint().linkId, REVIEWER);
      expect(links.isMember('', REVIEWER)).toBe(false);
      expect(links.isMember(BOARD, null)).toBe(false);
      expect(links.isMember(BOARD, '')).toBe(false);
    });

    it('lists every membership once, however many links a board has', () => {
      const a = mint();
      const b = mint();
      links.redeem(a.linkId, REVIEWER);
      links.redeem(b.linkId, REVIEWER);
      links.redeem(b.linkId, OTHER_REVIEWER);
      expect(
        links
          .allMembers()
          .map((m) => m.email)
          .sort(),
      ).toEqual([OTHER_REVIEWER, REVIEWER].sort());
    });
  });

  describe('across a restart', () => {
    it('keeps links, their state and their members', () => {
      const live = mint();
      const revoked = mint();
      links.revoke(revoked.linkId);
      links.redeem(live.linkId, REVIEWER);

      const reopened = new ShareLinks({ dataDir });
      expect(reopened.state(live.linkId)).toBe('live');
      expect(reopened.state(revoked.linkId)).toBe('revoked');
      expect(reopened.isMember(BOARD, REVIEWER)).toBe(true);
      expect(reopened.get(live.linkId)?.redemptions).toHaveLength(1);
    });

    it('a removed member stays removed', () => {
      const link = mint();
      links.redeem(link.linkId, REVIEWER);
      links.removeMember(BOARD, REVIEWER);
      expect(new ShareLinks({ dataDir }).isMember(BOARD, REVIEWER)).toBe(false);
    });

    it('an unreadable registry admits nobody rather than everybody', () => {
      const link = mint();
      links.redeem(link.linkId, REVIEWER);
      Bun.write(join(dataDir, 'share-links.json'), 'not json at all');
      const reopened = new ShareLinks({ dataDir });
      expect(reopened.isMember(BOARD, REVIEWER)).toBe(false);
      expect(reopened.state(link.linkId)).toBe('unknown');
    });
  });

  describe('what an operator reads', () => {
    it('stamps each link with the state it is in', () => {
      const live = mint();
      const revoked = mint();
      links.revoke(revoked.linkId);
      const listed = links.listForApi();
      expect(listed.find((l) => l.linkId === live.linkId)?.state).toBe('live');
      expect(listed.find((l) => l.linkId === revoked.linkId)?.state).toBe('revoked');
    });

    it('keeps who minted it and what it was for', () => {
      const link = links.create({
        workspaceId: BOARD,
        createdBy: 'Workspaces',
        label: 'Design review',
      });
      expect(link.createdBy).toBe('Workspaces');
      expect(link.label).toBe('Design review');
    });
  });
});
