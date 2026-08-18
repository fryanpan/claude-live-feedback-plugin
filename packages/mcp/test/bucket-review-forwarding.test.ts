/**
 * The MCP handler forwards the bucket re-look — it does not drop it.
 *
 * Two hand-copy seams sit between the server and the agent, and neither is
 * type-checked against the other end: the REST route (covered end to end in
 * `packages/server/test/goal-band-bucket-routes.test.ts`) and THIS layer,
 * where each `case` picks fields out of the JSON body and rebuilds the tool
 * result by hand. A field the server computes, persists and returns is still
 * invisible to every agent if this switch forgets to copy it — the same "one
 * layer away from where it's consumed" failure that shipped a `groups` param
 * the API accepted and discarded.
 *
 * Source-reading, like tool-wiring.test.ts: mcp.ts is a bundle entry point
 * and exports nothing. The BUNDLE is checked too, because peers load
 * `packages/plugin/mcp/index.js` rather than the source — a description or a
 * forward edited in `mcp.ts` and never rebuilt reaches nobody.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, '../src/mcp.ts'), 'utf8');
const BUNDLE = readFileSync(join(HERE, '../../plugin/mcp/index.js'), 'utf8');

/** The `case 'x': {` block for one tool, up to the next case. */
function handlerFor(tool: string): string {
  const start = SRC.indexOf(`case '${tool}': {`);
  expect(start, `no handler for ${tool}`).toBeGreaterThan(-1);
  const rest = SRC.slice(start + 1);
  return rest.slice(0, rest.indexOf('case '));
}

/**
 * The part of a handler that BUILDS THE RESULT — everything from `return ok(`
 * on. Asserting against the whole handler is what a first draft of this file
 * did, and it could not fail: each handler declares the response shape it
 * expects in a `as { … }` type annotation a few lines above, so the field name
 * appears there whether or not anything copies the value out. Deleting the
 * forward left the test green. The result block is the only place where the
 * field reaching the AGENT is distinguishable from the field merely being
 * named.
 */
function resultOf(tool: string): string {
  const handler = handlerFor(tool);
  const start = handler.indexOf('return ok(');
  expect(start, `${tool} does not return ok(...)`).toBeGreaterThan(-1);
  return handler.slice(start);
}

/** The declaration block for one tool, up to the next tool entry. */
function declarationFor(tool: string): string {
  const start = SRC.indexOf(`name: '${tool}',\n      description:`);
  expect(start, `no declaration for ${tool}`).toBeGreaterThan(-1);
  const rest = SRC.slice(start);
  return rest.slice(0, rest.indexOf('},\n    {'));
}

describe('set_goal_list hands the bucket re-look back to its caller', () => {
  // Positive control: this extractor really is reading that handler, so the
  // assertion below is about the forwarding rather than about an empty string.
  it('found the handler, and it is the one that calls the goals route', () => {
    expect(handlerFor('set_goal_list')).toContain('/goals');
  });

  it('forwards bucketReview into the result instead of dropping it', () => {
    // Positive control for the slice: the result really does carry the other
    // fields this handler reports, so a miss below is about bucketReview.
    expect(resultOf('set_goal_list')).toContain('strandedDone');
    expect(resultOf('set_goal_list')).toMatch(/bucketReview/);
  });

  // The caller is being told that somebody else was asked to do something.
  // Without it in the description, `requested` / `queued` read as two
  // unexplained booleans on a call about goals.
  it('the description says adding a band asks the lead to re-look', () => {
    const decl = declarationFor('set_goal_list');
    expect(decl).toContain('bucketReview');
    expect(decl.toLowerCase()).toContain('lead');
    // And that it does NOT place anything: an agent that reads this as "the
    // bucket gets emptied" has been told the opposite of what happens.
    expect(decl.toLowerCase()).toContain('nothing is placed');
  });
});

describe('attach_agent hands over a bucket re-look that was waiting', () => {
  it('found the handler (positive control)', () => {
    expect(handlerFor('attach_agent')).toContain('/attachments');
  });

  it('forwards pendingBucketReview into the result', () => {
    expect(resultOf('attach_agent')).toContain('queuedVoice');
    expect(resultOf('attach_agent')).toMatch(/pendingBucketReview/);
  });

  it('the description tells an arriving lead what it is', () => {
    expect(declarationFor('attach_agent')).toContain('pendingBucketReview');
  });
});

describe('what peers actually load', () => {
  // The bundle is the deliverable; the source is not. A forward that exists
  // only in mcp.ts reaches nobody until `bun run build:mcp` is committed.
  //
  // Assert the FORWARD, not the name. A first draft of this block checked
  // `BUNDLE.toContain('bucketReview')` — which the tool DESCRIPTIONS satisfy
  // on their own (set_goal_list's says "`bucketReview.taskIds` is that
  // bucket", attach_agent's contains the word `pendingBucketReview`), so
  // deleting the spread from mcp.ts and rebuilding left both green. That is
  // the same vacuous-probe failure the file exists to guard against, one
  // layer down. These literals appear only where the value is copied out.
  it('the committed bundle carries both forwards, not just the words', () => {
    expect(BUNDLE).toContain('{ bucketReview: res.bucketReview }');
    expect(BUNDLE).toContain('{ pendingBucketReview: res.pendingBucketReview }');
  });

  // The channel line the lead reads is rendered in the bundle too.
  it('the committed bundle can render a bucket-review request', () => {
    expect(BUNDLE).toContain('bucket-review');
  });
});
