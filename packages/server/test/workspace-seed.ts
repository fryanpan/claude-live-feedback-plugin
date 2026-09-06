/**
 * One board per test file, seeded over the real route, so a test can address
 * the things it creates.
 *
 * The canonical-routes cutover made the board part of every resource address:
 * a doc is `/workspaces/<ws>/docs/<id>`, and the middleware in front of it
 * refuses an id whose doc is not filed on that board. Before the cutover a
 * test could `POST /api/docs` and then read `/api/docs/<id>` without ever
 * saying where the doc lived, which is exactly the ambiguity the cutover
 * removed — so a test that touches a doc, a task, a review or a dispatch now
 * has to name a board too.
 *
 * `WS` is written once by `seedBoard` and read by the path builders, rather
 * than passed down through every helper each file already has. A test file is
 * one process with one server, so one module-level board is the same scope the
 * file's `base` already lives in; a file that boots two servers seeds each one
 * and holds the ids itself.
 */

/** `POST /workspaces` — returns the new board's id. */
export async function seedBoard(
  base: string,
  opts: { name?: string; host?: string } = {},
): Promise<string> {
  const res = await fetch(`${base}/workspaces`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(opts.host === undefined ? {} : { host: opts.host }),
    },
    body: JSON.stringify({
      name: opts.name ?? 'Test board',
      author: { id: 'agent:test-seed', name: 'Test Seed', kind: 'agent' },
    }),
  });
  if (!res.ok) {
    throw new Error(`seedBoard: POST /workspaces → ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { workspace?: { id?: string } };
  const id = body.workspace?.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`seedBoard: no workspace id in ${JSON.stringify(body)}`);
  }
  return id;
}

/**
 * The same board, minted through the store instead of the route.
 *
 * For a server that is behind an auth gate the HTTP seed cannot run: it has
 * no Access token, and `POST /workspaces` answers 401 before any board
 * exists — so a file testing the GATE would fail in its fixture rather than
 * in its assertion. The gate is what those files are about; the board is
 * scenery. Minting it directly keeps the fixture out of the thing under test.
 */
export function seedBoardOnHandle(
  h: { tasks: { createWorkspace(name: string): { id: string } } },
  name = 'Test board',
): string {
  return h.tasks.createWorkspace(name).id;
}
