/**
 * The lead banner shows exactly while the doc's asks have nobody to land
 * on, and goes the moment that changes — from the first read or from the
 * stream, whichever says so. Unknown says nothing.
 */
import type { LeadPresence } from '@feedback/core';
import { describe, expect, it } from 'vitest';
import { leadBannerText, mountLeadBanner, parseLeadPresence } from '../src/lead-banner.ts';

const presence = (over: Partial<LeadPresence>): LeadPresence => ({
  event: 'lead.presence',
  docId: 'doc-1',
  workspaceId: 'w-1',
  live: false,
  ...over,
});

function mounted(first: Promise<unknown>) {
  let push: ((p: LeadPresence) => void) | null = null;
  let unsubscribed = 0;
  const parent = document.createElement('div');
  parent.append(document.createElement('p'));
  const banner = mountLeadBanner({
    docId: 'doc-1',
    parent,
    fetchJson: () => first,
    subscribe: (_docId, onPresence) => {
      push = onPresence;
      return () => {
        unsubscribed += 1;
      };
    },
  });
  return {
    banner,
    parent,
    push: (p: LeadPresence) => {
      if (!push) throw new Error('not subscribed');
      push(p);
    },
    unsubscribed: () => unsubscribed,
  };
}

describe('lead banner', () => {
  it('sits above the prose and says nothing until it knows', async () => {
    let resolve: (v: unknown) => void = () => {};
    const m = mounted(new Promise((r) => (resolve = r)));
    expect(m.parent.firstElementChild).toBe(m.banner.element);
    expect(m.banner.element.hidden).toBe(true);
    resolve(presence({ live: false }));
    await m.banner.ready;
    expect(m.banner.element.hidden).toBe(false);
    expect(m.banner.element.textContent).toContain('No lead agent is listening');
    expect(m.banner.element.textContent).toContain('queue until one attaches');
  });

  it('hides when the first read says a lead is live, and shows on a stream change', async () => {
    const m = mounted(Promise.resolve(presence({ live: true, leadAgentId: 'agent-lead' })));
    await m.banner.ready;
    expect(m.banner.element.hidden).toBe(true);
    m.push(presence({ live: false, leadAgentId: 'agent-lead' }));
    expect(m.banner.element.hidden).toBe(false);
    m.push(presence({ live: true, leadAgentId: 'agent-lead' }));
    expect(m.banner.element.hidden).toBe(true);
  });

  it('ignores a frame for another doc, and a failed read shows nothing', async () => {
    const m = mounted(Promise.reject(new Error('offline')));
    await m.banner.ready;
    expect(m.banner.element.hidden).toBe(true);
    m.push(presence({ docId: 'doc-other', live: false }));
    expect(m.banner.element.hidden).toBe(true);
    expect(m.banner.presence()).toBeNull();
  });

  it('names the other empty room: a doc no board holds', () => {
    expect(leadBannerText(presence({ workspaceId: undefined }))).toContain('on no board');
    expect(leadBannerText(presence({ live: true }))).toBeNull();
    expect(leadBannerText(null)).toBeNull();
  });

  it('parses the wire shape strictly and tears down cleanly', () => {
    expect(parseLeadPresence('{"docId":"doc-1","live":true}')).toEqual({
      event: 'lead.presence',
      docId: 'doc-1',
      live: true,
    });
    expect(parseLeadPresence('{"docId":"doc-1"}')).toBeNull();
    expect(parseLeadPresence('not json')).toBeNull();
    const m = mounted(Promise.resolve(presence({})));
    m.banner.destroy();
    expect(m.unsubscribed()).toBe(1);
    expect(m.parent.querySelector('.lead-banner')).toBeNull();
  });
});
