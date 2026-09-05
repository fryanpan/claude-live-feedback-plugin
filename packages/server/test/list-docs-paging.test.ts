/**
 * GET /api/docs answers a PAGE when asked with `?limit=`, and the old whole
 * dump when not.
 *
 * Reported 2026-08-26: a fresh session in a new repo called `list_docs` and
 * got ~6.4 MB back — effectively the whole server, as its opening tool call.
 * Measured 2026-09-01: 7,420,585 bytes for 5,919 rows, none of it a body;
 * the weight is bind configuration replicated onto every member. So the
 * paged answer is a compact row, sorted by most recent activity, with a
 * keyset cursor to continue and `?full=1` to get whole meta on purpose.
 *
 * The size assertion has a positive control: the same page with `?full=1`
 * must EXCEED the ceiling the compact page stays under, otherwise "compact
 * is small" would pass on a corpus where nothing was ever big.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DOC_STORE_TIMINGS } from '../src/doc-store-timings.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { waitFor } from './wait-for.ts';

const N = 120;
const PAGE = 50;
/** What a compact page of PAGE rows may weigh. ~1 KB a row is generous —
 *  the measured full row averaged 1.25 KB and the compact one drops the
 *  replicated bind fields that made it so. */
const CEILING_BYTES = PAGE * 1024;
/** Heavy meta a full row carries and a compact one must not. Two kilobytes
 *  per doc is what makes the full-page control exceed the ceiling. */
const HEAVY_OWNER = `owner-${'x'.repeat(2048)}`;

interface Row {
  docId: string;
  type: string;
  title?: string;
  sourceUrl?: string;
  owner?: string;
  workspaceRoot?: string;
  threads?: { open: number; total: number };
  reviewUrl?: string;
  createdAt: number;
  lastActivityAt?: number;
}
interface Page {
  docs: Row[];
  total: number;
  limit: number;
  nextCursor: string | null;
  hasMore: boolean;
  full: boolean;
}

describe('GET /api/docs pages', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  /** Readable name → minted id. The name a caller posts is an alias; the
   *  listing answers in minted ids. */
  const mintedId: Record<string, string> = {};
  const minted = () => Object.values(mintedId).sort();
  /** Docs the server seeds for itself (the board feedback doc, a board room).
   *  Counted once so every total below is a claim about the seeded set. */
  let builtin: string[] = [];
  const isSeeded = (r: Row) => !builtin.includes(r.docId);

  const local = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        host: `localhost:${handle.port}`,
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });
  const getText = async (qs: string): Promise<string> => {
    const r = await local(`/api/docs${qs}`);
    expect(r.status).toBe(200);
    return r.text();
  };
  const getPage = async (qs: string): Promise<Page> => JSON.parse(await getText(qs)) as Page;

  /**
   * Wait until the corpus stops moving under the recency sort.
   *
   * Every test below that compares two listings assumes a still corpus, and
   * seeding N docs does not leave one: `lastActivityAt` is the `.ydoc`
   * mtime, that file is written by the persist debounce the server schedules
   * per change, and N creations therefore leave N persist timers in flight.
   * Each one that lands lifts its row to the front. Two listings read while
   * the backlog drains disagree about the order — which is the one thing a
   * keyset cursor is defined not to survive, and why the cursor walk lost a
   * row and the garbage-cursor comparison found one had jumped.
   *
   * The observable is the data dir itself: this server owns it alone, every
   * persist lands there as `<docId>.ydoc`, and the mtime it writes IS the
   * sort key. So the corpus is still exactly when no new file appears and no
   * existing one is rewritten.
   *
   * The gap is taken INSIDE the probe, before the snapshot, and derived from
   * the persist cadence rather than written as a literal. Both details are
   * load-bearing. Comparing two snapshots taken microseconds apart reports
   * quiet before the backlog has begun to land — a check that passes on a
   * zero — and a literal gap that clears a 200ms debounce clears nothing at
   * the 20ms one the suite actually runs.
   */
  const settle = async (): Promise<void> => {
    const snapshot = (): string[] =>
      readdirSync(dataDir)
        .filter((f) => f.endsWith('.ydoc'))
        .map((f) => `${f}@${statSync(join(dataDir, f)).mtimeMs}`)
        .sort();
    let previous = snapshot();
    await waitFor(
      async () => {
        await new Promise((r) => setTimeout(r, DOC_STORE_TIMINGS.persistMs * 3));
        const current = snapshot();
        const same =
          current.length === previous.length && current.every((v, i) => v === previous[i]);
        previous = current;
        // The length floor is the positive control: an empty or half-written
        // dir must never read as settled just because two probes agreed.
        return (same && current.length >= N) || false;
      },
      { interval: 0, describe: `every seeded .ydoc in ${dataDir} to stop being rewritten` },
    );
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'list-docs-paging-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    for (let i = 0; i < N; i++) {
      const docId = `paged-doc-${String(i).padStart(3, '0')}`;
      const file = join(dataDir, `${docId}.md`);
      writeFileSync(file, `# ${docId}\n\nBody ${i}.\n`);
      const r = await local('/api/docs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          docId,
          type: 'markdown',
          sourceUrl: file,
          title: i % 10 === 0 ? `Decade ${i}` : `Doc ${i}`,
          owner: HEAVY_OWNER,
          workspaceRoot: `/synthetic/root/${'y'.repeat(200)}`,
        }),
      });
      expect(r.status).toBe(200);
      mintedId[docId] = ((await r.json()) as { docId: string }).docId;
    }
    await settle();
    const all = (JSON.parse(await getText('')) as { docs: Row[] }).docs;
    builtin = all.map((d) => d.docId).filter((id) => !minted().includes(id));
  }, 60_000);

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('answers the legacy whole dump, full meta, when no limit is asked for', async () => {
    const body = JSON.parse(await getText('')) as { docs: Row[] };
    expect(Object.keys(body)).toEqual(['docs']);
    expect(body.docs.length).toBe(N + builtin.length);
    expect(body.docs.filter(isSeeded).length).toBe(N);
    expect(body.docs.filter(isSeeded).every((d) => d.owner === HEAVY_OWNER)).toBe(true);
  });

  it('caps the page, sorts by recency, and carries no bind meta or bodies', async () => {
    const page = await getPage(`?limit=${PAGE}`);
    expect(page.docs.length).toBe(PAGE);
    expect(page.total).toBe(N + builtin.length);
    expect(page.limit).toBe(PAGE);
    expect(page.hasMore).toBe(true);
    expect(page.full).toBe(false);
    expect(typeof page.nextCursor).toBe('string');
    for (const row of page.docs) {
      expect(row.owner).toBeUndefined();
      expect(row.workspaceRoot).toBeUndefined();
      expect(row.threads).toEqual({ open: 0, total: 0 });
      expect(JSON.stringify(row)).not.toContain('Body ');
      if (!isSeeded(row)) continue;
      expect(row.reviewUrl).toContain(row.docId);
      expect(row.type).toBe('markdown');
    }
    const key = (r: Row) => r.lastActivityAt ?? r.createdAt;
    for (let i = 1; i < page.docs.length; i++) {
      const a = page.docs[i - 1] as Row;
      const b = page.docs[i] as Row;
      expect(key(a) >= key(b)).toBe(true);
      if (key(a) === key(b)) expect(a.docId < b.docId).toBe(true);
    }
  });

  it('walks the whole set by cursor with no gaps and no duplicates', async () => {
    // Scoped to the seeded rows: the server's own docs (the board feedback
    // doc, the board room) get their first activity stamp a beat after
    // boot, and a row whose recency MOVES while a walk is in flight is the
    // one case a keyset cursor is defined not to revisit. That is the
    // intended contract (an offset would duplicate instead), and it is not
    // what this test is about.
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const qs: string = `?limit=${PAGE}&query=paged-doc${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const page: Page = await getPage(qs);
      expect(page.total).toBe(N);
      pages++;
      for (const row of page.docs) seen.push(row.docId);
      cursor = page.nextCursor;
      expect(page.hasMore).toBe(cursor !== null);
    } while (cursor !== null && pages < 10);
    expect(pages).toBe(Math.ceil(N / PAGE));
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort()).toEqual(minted());
  });

  it('treats a cursor it did not mint as page one', async () => {
    const first = await getPage(`?limit=${PAGE}`);
    const garbage = await getPage(`?limit=${PAGE}&cursor=not-a-cursor`);
    expect(garbage.docs.map((d) => d.docId)).toEqual(first.docs.map((d) => d.docId));
  });

  it('narrows by query, sourcePrefix and kind in both modes', async () => {
    const decades = await getPage(`?limit=${PAGE}&query=decade`);
    expect(decades.total).toBe(N / 10);
    expect(decades.docs.every((d) => d.title?.startsWith('Decade'))).toBe(true);

    const byFile = await getPage('?limit=5&query=paged-doc-042');
    expect(byFile.docs.map((d) => d.docId)).toEqual([mintedId['paged-doc-042']]);

    const prefixed = await getPage(`?limit=${PAGE}&sourcePrefix=${encodeURIComponent(dataDir)}`);
    expect(prefixed.total).toBe(N);
    const none = await getPage('?limit=5&sourcePrefix=/nowhere');
    expect(none.total).toBe(0);
    expect(none.nextCursor).toBeNull();

    expect((await getPage('?limit=5&kind=diff')).total).toBe(0);
    expect((await getPage('?limit=5&kind=markdown')).total).toBe(N);

    // Legacy mode honours the same filters, still as `{ docs }`.
    const legacy = JSON.parse(await getText('?query=decade')) as { docs: Row[] };
    expect(Object.keys(legacy)).toEqual(['docs']);
    expect(legacy.docs.length).toBe(N / 10);
  });

  it('returns whole meta for the page with full=1', async () => {
    const page = await getPage(`?limit=${PAGE}&full=1`);
    expect(page.full).toBe(true);
    expect(page.docs.length).toBe(PAGE);
    expect(page.docs.filter(isSeeded).every((d) => d.owner === HEAVY_OWNER)).toBe(true);
    expect(page.docs.filter(isSeeded).length).toBeGreaterThanOrEqual(PAGE - builtin.length);
  });

  it('keeps a compact page under the ceiling — and the full page over it', async () => {
    const compact = (await getText(`?limit=${PAGE}`)).length;
    const full = (await getText(`?limit=${PAGE}&full=1`)).length;
    expect(compact).toBeLessThan(CEILING_BYTES);
    // Positive control: the same rows, whole meta, must be heavier than the
    // ceiling, or the assertion above proves nothing about what was dropped.
    expect(full).toBeGreaterThan(CEILING_BYTES);
    expect(full).toBeGreaterThan(compact * 3);
  });

  it('clamps limit to 500 and falls back to 50 on a malformed one', async () => {
    expect((await getPage('?limit=99999')).limit).toBe(500);
    expect((await getPage('?limit=abc')).limit).toBe(50);
    expect((await getPage('?limit=abc')).docs.length).toBe(50);
  });
});
