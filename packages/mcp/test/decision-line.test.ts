/**
 * The propagation clause on `decision.answered`, and the wiring that carries
 * it to an agent.
 *
 * The behaviour is proven against REAL emitted rows in
 * `packages/server/test/decision-answered-line.test.ts` — that is the test
 * that can tell `links` from a key nobody sends. What this file adds is the
 * two seams that suite cannot see: the switch in mcp.ts must actually call
 * this renderer rather than rebuild the sentence inline (which is how the
 * unconditional clause survived in the first place), and the BUNDLE must carry
 * the guard, because peers load `packages/plugin/mcp/index.js` and never the
 * source.
 *
 * The bundle half used to be `BUNDLE.toContain('Array.isArray(p.links) && …')`.
 * A minifier that spelt the same test differently would have failed it, and a
 * guard whose result was thrown away would have passed it. It now pushes both
 * shapes of the frame down the running bundle's event stream and reads the
 * sentence a session receives.
 */
import { describe, expect, it } from 'vitest';
import { decisionAnsweredLine } from '../src/decision-line.ts';
import { type BundleHarness, restoredWatches, startBundle } from './harness/mcp-bundle.ts';

const CLAUSE = 'walk its links as the propagation checklist';
const ANSWERED = {
  taskId: 't-synthetic',
  answer: 'Rebuild after the freeze.',
  actor: { name: 'Alex' },
};

describe('decisionAnsweredLine', () => {
  it('always says which task was answered, and in whose words', () => {
    const line = decisionAnsweredLine({ ...ANSWERED, links: [] });
    expect(line).toContain('[decision.answered]');
    expect(line).toContain('t-synthetic');
    expect(line).toContain('by Alex');
    expect(line).toContain('Rebuild after the freeze.');
  });

  it('offers the checklist when there are links to walk', () => {
    expect(decisionAnsweredLine({ ...ANSWERED, links: [{ kind: 'doc', docId: 'd1' }] })).toContain(
      CLAUSE,
    );
  });

  it('says nothing about links when the task has none', () => {
    expect(decisionAnsweredLine({ ...ANSWERED, links: [] })).not.toContain(CLAUSE);
  });

  it('says nothing about links when the frame carries no links key at all', () => {
    // A server older than the field, or a replayed row. Absent is not "walk
    // an empty list" and it is not "walk an unknown list" either — there is
    // nothing to hand the reader.
    expect(decisionAnsweredLine(ANSWERED)).not.toContain(CLAUSE);
  });

  it('truncates a long answer rather than relaying the whole essay', () => {
    const line = decisionAnsweredLine({ ...ANSWERED, answer: 'x'.repeat(200), links: [] });
    expect(line).toContain('…');
    expect(line).not.toContain('x'.repeat(200));
  });
});

describe('the shipped bundle renders the event with it', () => {
  /**
   * The channel switch used to be checked by slicing the
   * `case 'decision.answered':` arm out of the source and requiring it to say
   * `decisionAnsweredLine(p)`. That is a claim about which function name
   * appears in a file — it passes on an arm that calls the renderer and
   * throws the result away, and it fails on a rename that keeps the sentence
   * identical. What has to hold is that the line a session RECEIVES is the
   * one this renderer builds, so the frames below are pushed down the running
   * bundle's own event stream and the delivered sentence is compared against
   * the renderer's output for the same payload.
   */
  it('ships the guard, and the renderer, in the artifact peers actually load', async () => {
    let h: BundleHarness | undefined;
    try {
      h = await startBundle((req) =>
        req.method === 'GET' && /\/watches$/.test(req.path) ? restoredWatches('doc-1') : {},
      );
      await h.streamOpen();

      // Positive control FIRST, and it is a real frame rather than a literal:
      // an answered decision that DOES annotate something must carry the
      // clause, or "no clause on an empty list" could just be a bundle that
      // lost the sentence altogether.
      h.pushFrame({
        id: 'd:1',
        event: 'decision.answered',
        data: {
          event: 'decision.answered',
          eid: 'e-linked',
          docId: 'doc-1',
          taskId: 't-linked',
          answer: 'Rebuild after the freeze.',
          actor: { id: 'a-someone-else' },
          links: [{ id: 't-other' }],
        },
      });
      const linked = await h.waitForChannel((c) => c.content.includes('t-linked'));
      expect(linked.content).toContain(CLAUSE);

      // The measurement: the same event with an empty `links` — which is what
      // the store emits for most decisions — must not send the reader off to
      // walk a list that has nothing in it.
      h.pushFrame({
        id: 'd:2',
        event: 'decision.answered',
        data: {
          event: 'decision.answered',
          eid: 'e-bare',
          docId: 'doc-1',
          taskId: 't-bare',
          answer: 'Rebuild after the freeze.',
          actor: { id: 'a-someone-else' },
          links: [],
        },
      });
      const bare = await h.waitForChannel((c) => c.content.includes('t-bare'));
      expect(bare.content).not.toContain(CLAUSE);

      // The delivered line IS this renderer's output, not a sentence the arm
      // rebuilt inline that happens to agree about the clause. A long answer
      // is the cheapest way to tell them apart: truncation lives in the
      // renderer, and an inline concat would relay the whole essay.
      const long = 'z'.repeat(200);
      h.pushFrame({
        id: 'd:3',
        event: 'decision.answered',
        data: {
          event: 'decision.answered',
          eid: 'e-long',
          docId: 'doc-1',
          taskId: 't-long',
          answer: long,
          actor: { id: 'a-someone-else' },
          links: [],
        },
      });
      const essay = await h.waitForChannel((c) => c.content.includes('t-long'));
      expect(essay.content).not.toContain(long);
      expect(essay.content).toContain('…');
      expect(essay.content).toBe(
        // No `actor`: the frame's `{ id }` carries no name, and the
        // renderer's `by …` clause keys on the name alone.
        decisionAnsweredLine({ taskId: 't-long', answer: long, links: [] }),
      );
    } finally {
      await h?.stop();
    }
  }, 60_000);
});
