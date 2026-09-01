/**
 * The task panel's Related Links section: title-only links to every doc a
 * row ties to, directly below the fields row (approved mock, replacing the
 * old Source-doc field — see the mock's caption: "Replaces the Source doc
 * row"). Until this, a ref was stored, keyed and backlinked and then never
 * drawn in this spot — the store had it and no surface showed it here.
 *
 * Fixtures are synthetic (jordan@partner.example register).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CHORES_ID, type HubTask } from '../src/hub/hub-model.ts';
import { type DetailHandlers, relatedDocLinks, renderRelatedLinks } from '../src/hub/hub-render.ts';
import { _resetLinkTitlesForTest, primeLinkTitle } from '../src/link-titles.ts';
import { disposeTaskDetail, renderTaskDetail } from './support/task-detail.ts';

const NOW = 1_700_000_000_000;
let seq = 0;
function task(overrides: Partial<HubTask> = {}): HubTask {
  seq += 1;
  return {
    id: `t-${seq}`,
    title: `Task ${seq}`,
    status: 'todo',
    assignee: 'agent',
    goal: CHORES_ID,
    order: seq,
    after: [],
    links: [],
    transitions: [],
    bodyDocId: `task:t-${seq}`,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as HubTask;
}

const handlers = (over: Partial<DetailHandlers> = {}): DetailHandlers => ({
  onClose: vi.fn(),
  onStatusSet: vi.fn(),
  onTitleCommit: vi.fn(),
  onAnswer: vi.fn(),
  onAssign: vi.fn(),
  ...over,
});

let root: HTMLElement;
beforeEach(() => {
  disposeTaskDetail();
  _resetLinkTitlesForTest();
  root = document.createElement('div');
  document.body.replaceChildren(root);
});

describe('relatedDocLinks', () => {
  it('reads a doc or thread origin, and refuses everything else', () => {
    expect(relatedDocLinks(task({ origin: { kind: 'doc', docId: 'd-plan' } }))).toEqual([
      { docId: 'd-plan', held: false },
    ]);
    expect(
      relatedDocLinks(task({ origin: { kind: 'thread', docId: 'd-plan', threadId: 'th-1' } })),
    ).toEqual([{ docId: 'd-plan', held: false }]);
    expect(relatedDocLinks(task())).toEqual([]);
    expect(relatedDocLinks(task({ origin: { kind: 'task', taskId: 't-9' } }))).toEqual([]);
    expect(relatedDocLinks(task({ origin: { kind: 'doc', docId: '' } }))).toEqual([]);
    expect(relatedDocLinks(task({ origin: 'd-plan' }))).toEqual([]);
  });

  it('collects doc-kind refs off `links`, and skips url/diff/task kinds', () => {
    const links = relatedDocLinks(
      task({
        links: [
          { kind: 'doc', docId: 'd-a' },
          { kind: 'doc', docId: 'd-b' },
          { kind: 'url', url: 'https://example.com' },
          { kind: 'diff', workspaceId: 'w-1' },
          { kind: 'doc', docId: '' },
        ],
      }),
    );
    expect(links.map((l) => l.docId)).toEqual(['d-a', 'd-b']);
  });

  it('dedupes the origin against `links` — a doc tied both ways renders once', () => {
    const links = relatedDocLinks(
      task({
        origin: { kind: 'doc', docId: 'd-plan' },
        links: [
          { kind: 'doc', docId: 'd-plan' },
          { kind: 'doc', docId: 'd-other' },
        ],
      }),
    );
    expect(links.map((l) => l.docId)).toEqual(['d-plan', 'd-other']);
  });

  it('marks the origin doc held only while planHold names it', () => {
    const held = relatedDocLinks(
      task({ origin: { kind: 'doc', docId: 'd-plan' }, planHold: { docId: 'd-plan' } }),
    );
    expect(held).toEqual([{ docId: 'd-plan', held: true }]);

    // A doc from `links` is never the held one — only the origin can be.
    const notHeld = relatedDocLinks(
      task({ links: [{ kind: 'doc', docId: 'd-a' }], planHold: { docId: 'd-a' } }),
    );
    expect(notHeld).toEqual([{ docId: 'd-a' }]);
  });
});

describe('renderRelatedLinks', () => {
  it('is null on an empty list', () => {
    expect(renderRelatedLinks([])).toBeNull();
  });

  it('builds a heading and one link per entry, canonical workspace href first', () => {
    const el = renderRelatedLinks([{ docId: 'd-plan' }, { docId: 'd-other' }], 'w-test');
    expect(el?.querySelector('.hub-related-links-k')?.textContent).toBe('Related Links');
    const anchors = [...(el?.querySelectorAll<HTMLAnchorElement>('.hub-related-link') ?? [])];
    expect(anchors.map((a) => a.getAttribute('href'))).toEqual([
      '/workspaces/w-test/docs/d-plan',
      '/workspaces/w-test/docs/d-other',
    ]);
    // No workspace id: the legacy shape, same fallback the old Source-doc
    // field used.
    const legacy = renderRelatedLinks([{ docId: 'd-plan' }]);
    expect(legacy?.querySelector('.hub-related-link')?.getAttribute('href')).toBe('/review/d-plan');
  });

  it('falls back to "Untitled doc" for a resolved-but-titleless doc — never the raw id', () => {
    // `primeLinkTitle(url, null)` is the server saying "asked, and there is
    // nothing" (as opposed to never having asked) — the AC is title-only
    // links, so the raw doc id must never be the steady-state text.
    primeLinkTitle('/review/d-blank', null, null);
    const el = renderRelatedLinks([{ docId: 'd-blank' }]);
    expect(el?.querySelector('.hub-related-link')?.textContent).toBe('Untitled doc');
  });

  it('carries the held note on the marked entry only', () => {
    const el = renderRelatedLinks([{ docId: 'd-plan', held: true }, { docId: 'd-other' }]);
    const items = [...(el?.querySelectorAll('li') ?? [])];
    expect(items[0]?.querySelector('.hub-related-link-held')?.textContent).toContain('held until');
    expect(items[1]?.querySelector('.hub-related-link-held')).toBeNull();
  });
});

describe('the Related Links section on the panel', () => {
  it('renders below the fields row, and not at all with no doc ties', () => {
    renderTaskDetail(
      root,
      task({ origin: { kind: 'doc', docId: 'd-plan' } }),
      handlers({ workspaceId: 'w-test' }),
    );
    expect(root.querySelector('.hub-related-links-k')?.textContent).toBe('Related Links');
    const link = root.querySelector<HTMLAnchorElement>('.hub-related-link');
    expect(link?.getAttribute('href')).toBe('/workspaces/w-test/docs/d-plan');
    // Not the raw doc id, and not left blank either: "Loading…" is what a
    // reader sees before the title-hydration fetch lands (or forever, if it
    // fails) — the AC is title-only links, so the id is never a value this
    // settles on, in flight or not.
    expect(link?.textContent).toBe('Loading…');
    // The panel no longer has a "Source doc" field at all — this section
    // replaces it.
    expect(
      [...root.querySelectorAll('.hub-detail-field-k')].map((k) => k.textContent),
    ).not.toContain('Source doc');

    // The absence half, with the render above as its positive control.
    renderTaskDetail(root, task(), handlers({ workspaceId: 'w-test' }));
    expect(root.querySelector('.hub-related-links-k')).toBeNull();
  });

  it('shows the doc TITLE when the shared link-title cache knows it', () => {
    primeLinkTitle('/workspaces/w-test/docs/d-named', 'Sprint plan', null);
    renderTaskDetail(
      root,
      task({ origin: { kind: 'doc', docId: 'd-named' } }),
      handlers({ workspaceId: 'w-test' }),
    );
    expect(root.querySelector('.hub-related-link')?.textContent).toBe('Sprint plan');
  });

  it('carries the plan-hold mark, and never a staleness mark (dropped by design)', () => {
    renderTaskDetail(
      root,
      task({
        origin: { kind: 'doc', docId: 'd-plan' },
        planHold: { docId: 'd-plan' },
        possiblyStale: { docRevision: 3, ts: NOW },
      }),
      handlers({ workspaceId: 'w-test' }),
    );
    expect(root.querySelector('.hub-related-link-held')?.textContent).toContain('held until');
    // A possiblyStale row draws NO "plan edited since filed" mark — the flag
    // gives the reader nothing to act on (Bryan, 2026-08-31).
    expect(root.querySelector('.hub-related-link-stale')).toBeNull();

    renderTaskDetail(
      root,
      task({ origin: { kind: 'doc', docId: 'd-plan' } }),
      handlers({ workspaceId: 'w-test' }),
    );
    expect(root.querySelector('.hub-related-link')).not.toBeNull(); // control
    expect(root.querySelector('.hub-related-link-held')).toBeNull();
  });
});
