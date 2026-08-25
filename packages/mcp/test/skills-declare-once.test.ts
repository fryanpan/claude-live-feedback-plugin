/**
 * The skills are how the fleet learns that declaring once is enough.
 *
 * The tool descriptions carry the mechanics, but a tool description is read at
 * the moment a tool is about to be called — and the whole point of this ticket
 * is that an agent never thinks to call anything, because silence from a
 * subscription it never made is indistinguishable from nobody having
 * commented. The skills are the surface that is read at SESSION START, before
 * the mistake, so the seat contract has to be legible there.
 *
 * These are content assertions on shipped SKILL.md files, in the spirit of
 * plugin-version-reported.test.ts: the artifact peers install is the file, so
 * the file is what gets pinned.
 *
 * SHAPE NOTE: the lead skill is operator-authored and deliberately minimal —
 * four sections, ~45 lines. The operational liveness material used to sit in a
 * `running-a-workspace-hub` skill beside it; that skill is gone, and its
 * content now lives in the description of the tool that owns each piece
 * (`set_workspace_lead` for the declare-once behaviour, `list_watched_docs`
 * for the quiet-board probe, `attach_agent` for the non-lead path). A tool
 * description is read when the tool is about to be called and costs nothing on
 * every other turn, which is the trade that retired the skill. What stays here
 * is the seat CONTRACT: one bare call, it covers surfaces created later,
 * events queue across a disconnect, and a quiet session has to say so.
 *
 * The negative guards run across every shipped skill, because a wrong sentence
 * — or a pointer to a skill that no longer ships — can come back anywhere.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS = join(HERE, '../../plugin/skills');
const LEAD = readFileSync(join(SKILLS, 'leading-a-workspace/SKILL.md'), 'utf8');
const GENERAL = readFileSync(join(SKILLS, 'working-in-a-workspace/SKILL.md'), 'utf8');

/** Every skill the plugin actually ships, discovered rather than listed — a
 *  skill added tomorrow is covered by the guards below without an edit here. */
const SHIPPED: Array<[string, string]> = readdirSync(SKILLS, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(SKILLS, d.name, 'SKILL.md')))
  .map((d) => [d.name, readFileSync(join(SKILLS, d.name, 'SKILL.md'), 'utf8')]);

/** Skills that were retired. A dangling name in a skill, a triage line or a
 *  tool description reads as a skill the agent failed to FIND, not as one that
 *  no longer exists — which sends the reader looking for a broken install. */
const RETIRED = ['running-a-workspace-hub', 'handling-a-goal-change', 'reviewing-task-shape'];

/**
 * One line, lower-cased. Every assertion below that searches for a PHRASE runs
 * against this rather than the raw file.
 *
 * These SKILL.md files are hard-wrapped at ~76 columns, so a multi-word search
 * only matches when the wrap happens not to have landed inside it — and where
 * the wrap lands is decided by an unrelated edit three sentences earlier. That
 * is survivable for a positive assertion, which goes loudly red. It is not
 * survivable for a `not.toMatch`, which goes quietly GREEN: it reports the
 * banned sentence as absent from the file that contains it.
 *
 * This is not hypothetical. At ecaf378, the last commit before the delivery
 * claim was corrected, two skills carried "Delivery is gated on a heartbeat
 * inside the ~5-minute window" and `not.toMatch(/gated on a heartbeat/)` fired
 * on exactly one of them — the other file's line break fell between `a` and
 * `heartbeat`. Collapsing the whitespace removes the coin flip.
 *
 * Structural assertions (`/^## …$/m`, frontmatter) keep using the raw text —
 * they are ABOUT line boundaries, and flattening would destroy what they check.
 */
const flatten = (s: string): string => s.replace(/\s+/g, ' ').toLowerCase();

describe('the wrong delivery claims cannot come back in any skill', () => {
  for (const [name, raw] of SHIPPED) {
    it(`${name} does not claim delivery is gated on a heartbeat window`, () => {
      // The rule: HEARTBEAT_FRESH_MS (~5 min) feeds the DISPLAYED away label;
      // delivery rides the observed clock, `max(lastHeartbeat, lastToolCallAt)`.
      // So a ~5-minute claim about display is fine and a heartbeat-window claim
      // about DELIVERY is not, and only the second is banned. Runs on the
      // flattened text — see the note on `flatten` for why the raw file lets a
      // line wrap hide the sentence.
      expect(flatten(raw)).not.toMatch(/gated on a heartbeat/);
      // And the retired hub's display-vs-delivery fusion stays gone.
      expect(flatten(raw)).not.toMatch(/away and triage requests queue/);
    });
  }

  // POSITIVE CONTROL: the loop above is vacuous if SHIPPED is empty, which is
  // exactly what a wrong path or a deleted directory would produce.
  it('reads a non-empty set of shipped skills', () => {
    expect(SHIPPED.length).toBeGreaterThan(1);
    expect(SHIPPED.map(([n]) => n)).toContain('leading-a-workspace');
  });
});

describe('the lead skill states the seat contract', () => {
  it('names the bare one-argument declaration, and only that form', () => {
    expect(LEAD).toMatch(/set_workspace_lead\(workspaceId\)/);
    expect(flatten(LEAD)).toMatch(/no second argument/);
  });

  it('says the declaration covers surfaces created later', () => {
    expect(flatten(LEAD)).toMatch(/created later/);
  });

  it('says events queue across a disconnect instead of dropping', () => {
    // The durable-queue model: the queue is the record, delivery is the fast
    // path. A lead that reads this knows a gap is a backlog, not a loss.
    expect(flatten(LEAD)).toMatch(/disconnect/);
    expect(flatten(LEAD)).toMatch(/remain queued|queued for when you reconnect/);
  });

  it('says a quiet session stops being sent work', () => {
    // The one thing the seat contract cannot leave to a tool description: an
    // agent that has declared reads "I am covered", and the attachment lapses
    // anyway unless the server keeps seeing the session. Nothing prompts a
    // call here, so there is no tool description to read at the right moment.
    expect(LEAD).toMatch(/heartbeat\(workspaceId\)/);
    expect(flatten(LEAD)).toMatch(/seen recently/);
  });

  it('requires the general skill as background instead of repeating it', () => {
    expect(LEAD).toMatch(/working-in-a-workspace/);
    expect(flatten(LEAD)).toMatch(/deliberately not repeated/);
  });

  it('claims checking every task against the standard for the seat, off the events it already gets', () => {
    // The server no longer addresses a per-row ask at the lead; the duty is
    // continuous and its trigger is the ordinary event stream. A skill that
    // said only "check every task" would leave an agent waiting to be asked.
    expect(LEAD).toMatch(/every task you \*see\*/);
    expect(flatten(LEAD)).toMatch(/task\.created/);
  });
});

describe('positive controls — guidance that must survive the edit', () => {
  it('the lead skill still leads with priority order and not-stopping', () => {
    expect(LEAD).toMatch(/^## 3\. Work in priority order — including over the primary user$/m);
    expect(flatten(LEAD)).toMatch(/not until the batch drains/);
  });

  it('the general skill still carries the task standard and the review vocabulary', () => {
    expect(GENERAL).toMatch(/<persona> can <do x> so that <goal y>/);
    expect(GENERAL).toContain('add_review_item(taskId, review)');
    expect(GENERAL).toContain('review_type: "decision"');
    expect(GENERAL).toContain('review_type: "question"');
  });

  it('no substantive sentence appears in two shipped skills', () => {
    // The drift guard, stated mechanically: the lead skill says its shared
    // ground is "deliberately not repeated here", so any long line present
    // verbatim in two files is a copy that will rot in one place.
    //
    // FENCED LINES ARE EXEMPT, and that is not a hole. A code block is an API
    // call, not a sentence — `set_workspace_lead(workspaceId) // no second
    // argument` legitimately appears wherever the seat is discussed, and
    // banning it would push the files into paraphrasing the same call two
    // ways, which is the drift this guard exists to catch.
    const prose = (t: string) => {
      const out = new Set<string>();
      let fenced = false;
      for (const raw of t.split('\n')) {
        const l = raw.trim();
        if (l.startsWith('```')) {
          fenced = !fenced;
          continue;
        }
        if (fenced || l.length <= 60 || l.startsWith('#') || l.startsWith('---')) continue;
        out.add(l);
      }
      return out;
    };
    const files: Array<[string, Set<string>]> = SHIPPED.map(([n, raw]) => [n, prose(raw)]);
    const dups: string[] = [];
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const [an, a] = files[i] as [string, Set<string>];
        const [bn, b] = files[j] as [string, Set<string>];
        for (const l of a) if (b.has(l)) dups.push(`${an} + ${bn}: ${l}`);
      }
    }
    expect(dups).toEqual([]);
  });

  it('the retired skills are gone and nothing still points at them', () => {
    // `reviewing-task-shape` was absorbed by the lead seat's §2, which owns
    // checking every row against the standard. `handling-a-goal-change` went
    // because the operations do the task movement themselves — removing a band
    // sweeps its tasks, a reorder carries them, and `set_goal_list` refuses a
    // removal that would strand work. `running-a-workspace-hub` went because
    // its content belongs in the description of the tool that owns it.
    for (const gone of RETIRED) {
      expect(existsSync(join(SKILLS, gone))).toBe(false);
      for (const [name, raw] of SHIPPED) {
        expect(`${name}: ${raw}`).not.toContain(gone);
      }
    }
    // POSITIVE CONTROL: the same probe over the same haystack finds a skill
    // that DOES ship, so a green run above means "absent", not "nothing read".
    expect(
      SHIPPED.some(([, raw]) => raw.includes('claude-workspaces:working-in-a-workspace')),
    ).toBe(true);
  });

  it('no skill still teaches the removed workspace text goal', () => {
    // `set_workspace_goal` wrote a single north-star paragraph on the
    // workspace. It is gone: a board's goals are the ordered LIST now. A skill
    // that still names the verb teaches a call whose route answers 410, and
    // the agent reads that as its own install being broken.
    for (const [name, raw] of SHIPPED) {
      expect(`${name}: ${raw}`).not.toContain('set_workspace_goal');
    }
    // POSITIVE CONTROL: the surviving goal verbs ARE taught somewhere, so the
    // absence above is a removal rather than a haystack that stopped loading.
    expect(SHIPPED.some(([, raw]) => raw.includes('set_goal_list'))).toBe(true);
    expect(SHIPPED.some(([, raw]) => raw.includes('set_task_goal'))).toBe(true);
  });

  it('every skill declares a frontmatter name, and it matches the directory', () => {
    // `embedding-widget/` ships as `embedding-feedback-widget` and has since
    // it was written. Renaming either half changes the name peers invoke, so
    // it is listed as a known exception rather than silently accommodated by
    // weakening the check for everyone.
    const KNOWN_MISMATCH: Record<string, string> = {
      'embedding-widget': 'embedding-feedback-widget',
    };
    for (const [dir, raw] of SHIPPED) {
      const declared = /^name: (.+)$/m.exec(raw)?.[1];
      expect(`${dir}: ${declared}`).toBe(`${dir}: ${KNOWN_MISMATCH[dir] ?? dir}`);
    }
  });
});
