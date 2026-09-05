/**
 * The security documentation is only useful if the three pieces point at each
 * other: CLAUDE.md sends a reader to the architecture summary, the summary
 * sends them to the per-release checklist, and `ship-it` actually runs the
 * checklist instead of leaving it to be remembered.
 *
 * Each link is a plain string in a file nothing type-checks, so each one can
 * be broken by a rename that compiles, passes every other suite, and shows up
 * only as a checklist nobody ran. That is what this pins.
 *
 * The last case is the one that matters most: it does not assert that
 * `ship-it` MENTIONS the rule, it extracts the file-matching regex the skill
 * tells an agent to run and checks that the regex really selects the security
 * surface — with a negative control, so a pattern that matched everything
 * would fail here rather than pass vacuously.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..', '..', '..');
const read = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8');

const ARCHITECTURE_DOC = 'docs/architecture/security.md';
const REVIEW_RULE = '.claude/rules/security-review.md';
const SHIP_IT = '.claude/skills/ship-it/SKILL.md';

/** The seven headings, in order. The PR-body template at the end of the rule
 *  numbers the same seven, so a heading added without a template row — or the
 *  reverse — leaves the checklist and the thing a lead reads out of step. */
const CHECKLIST_HEADINGS = [
  'New routes gated',
  'New inputs validated',
  'No secrets in any artifact',
  'Share scope unchanged',
  'Tokens through one signing module',
  'Webhook replay protection intact',
  'Deploy and refresh still loopback-only',
];

describe('security docs are wired together', () => {
  it('CLAUDE.md links the architecture summary', () => {
    const claudeMd = read('CLAUDE.md');
    expect(claudeMd).toContain(`(${ARCHITECTURE_DOC})`);
    // In the architecture-summaries list, not merely somewhere in the file —
    // the list is what tells a reader the doc exists at all.
    const list = claudeMd.slice(claudeMd.indexOf('## Architecture summaries'));
    expect(list.slice(0, list.indexOf('\n## ', 3))).toContain(ARCHITECTURE_DOC);
  });

  it('the architecture summary exists and carries a boundary diagram', () => {
    const doc = read(ARCHITECTURE_DOC);
    expect(doc).toContain('```mermaid');
    // Every gate the checklist asks about has to be findable from the map.
    for (const gate of [
      'isGatedWrite',
      'shareScopeAllows',
      'isListedFile',
      'classifyHost',
      'authorizeAgentCaller',
    ]) {
      expect(doc).toContain(gate);
    }
    expect(doc).toContain(REVIEW_RULE.replace('.claude/rules/', ''));
  });

  it('the review rule lists all seven checklist headings in order', () => {
    const rule = read(REVIEW_RULE);
    const found = [...rule.matchAll(/^### \d+\. (.+)$/gm)].map((m) => m[1]);
    expect(found).toEqual(CHECKLIST_HEADINGS);
  });

  it('the review rule ships a PR-body template with a row per heading', () => {
    const rule = read(REVIEW_RULE);
    const template = rule.slice(rule.indexOf('## Security review'));
    for (let i = 1; i <= CHECKLIST_HEADINGS.length; i++) {
      expect(template).toContain(`${i}.`);
    }
  });

  it('ship-it names the review rule and puts the answers in the PR body', () => {
    const skill = read(SHIP_IT);
    expect(skill).toContain('.claude/rules/security-review.md');
    expect(skill).toContain('## Security review');
  });

  it("ship-it's file-matching pattern really selects the security surface", () => {
    const skill = read(SHIP_IT);
    // Pull the pattern the skill tells an agent to run, rather than restating
    // it here — a copy in this file would keep passing after the skill's
    // pattern was edited.
    const match = skill.match(/grep -E '([^']+)'/);
    expect(match).not.toBeNull();
    const pattern = new RegExp((match as RegExpMatchArray)[1]);

    const security = [
      'packages/server/src/middleware/write-gate.ts',
      'packages/server/src/middleware/host-guard.ts',
      'packages/server/src/auth/session.ts',
      'packages/server/src/auth/widget-token.ts',
      // The proof that a caller IS the agent whose event feed it asks for.
      // Two routes read one agent's whole subscription, and the id that
      // addresses them is a hash of a name anyone on the board can read, so
      // the gate is the only thing standing there.
      'packages/server/src/auth/agent-token.ts',
      'packages/server/src/share/url-signing.ts',
      'packages/server/src/recall-webhook-auth.ts',
      'packages/server/src/fs-scan.ts',
      'packages/server/src/server.ts',
      'packages/server/src/bin.ts',
      // The two halves that came OUT of server.ts and kept its surface: the
      // Access verifiers and host lists (access-deps.ts) and the roster,
      // sessions and widget tokens (identity-setup.ts). Without these the
      // split would have quietly taken the sign-in chain off the trigger.
      'packages/server/src/access-deps.ts',
      'packages/server/src/identity-setup.ts',
      // …and the third: the agent-merge route's loopback / cf-ray / browser
      // refusals came out of server.ts with it. A merge moves lead seats and
      // re-keys an agent's deliveries fleet-wide, which is exactly the kind
      // of change the security pass exists to catch.
      'packages/server/src/routes/agent-identity.ts',
      // …and the fourth: the request-admission run — the default-deny host
      // gate, the Access branch each host decision selects, and the
      // external-access master switch — came out of `fetch` in A17. It is
      // the door itself, so a PR that edits only this file must still answer
      // the checklist; without this row the split would have taken the whole
      // host gate off the trigger.
      'packages/server/src/request-admission.ts',
      // …and the fifth, which is NOT an auth surface and is on the list
      // anyway. Shell and static serving holds the three static roots and
      // the containment checks over them, serves a mockup from an absolute
      // path the room was bound to, and `/widget/` sits on the share-host
      // allowlist. Checklist items 1, 2 and 4 — name the gate on a moved
      // route, what rejects a hostile file path, did share scope widen —
      // all land on this file, so a PR that edits only it must still answer
      // them.
      'packages/server/src/shell-static.ts',
      // …and the sixth, which is on the list by its nature rather than by
      // argument. Every route in it ends in a LONG-LIVED connection, and a
      // websocket is authorized exactly once — at its upgrade. The Origin
      // checks that stand in for CORS on `/audio/` and `/y/`, the per-bot
      // token that is the whole authentication for `/recall/`, the sign-in
      // carry that makes an editing socket read-only, the `shareId` and
      // `shareMember` stamps the revocation sweeps hunt by, and the share
      // visitor's refusal from the agent-level stream all live here. A gate
      // moved or reordered in this file cannot be caught later by a request
      // that arrives afterwards, because there is no afterwards.
      'packages/server/src/upgrade-stream.ts',
      // …and the seventh, which is the other half of the fourth. Admission
      // decides who the boundary proved; THIS file decides which proof is
      // written down as the author, and it holds the widget-token gate whose
      // identity it ranks. The precedence bug it documents — a header
      // outranking the email Cloudflare confirmed, letting a request choose
      // which of two proven identities to be recorded as — is exactly the
      // shape the checklist exists to catch, and it lives in the ordering of
      // four lines inside one function.
      'packages/server/src/request-attribution.ts',
      // …and the eighth, which is the other half of the sixth. A19 put the
      // upgrade on this list because a websocket is authorized once; this is
      // the file that then holds that authorization for the socket's whole
      // life. `open` is what makes a share-stamped socket reachable by the
      // revocation sweeps — a stamp that never reaches `trackShareSocket` is
      // a connection no sweep can find — and `message` is where a frame is
      // handed to a room, which is the read the share scope was deciding
      // about in the first place.
      'packages/server/src/socket-handlers.ts',
    ];
    for (const path of security) expect(pattern.test(path)).toBe(true);

    // Negative control. Without these a pattern like `.` would satisfy every
    // assertion above and the conditional step would fire on every PR, which
    // is the same as not having a condition.
    const unrelated = [
      'docs/architecture/security.md',
      'packages/widget/src/widget.ts',
      'packages/workspaces-app/src/styles.css',
      'packages/server/src/summarize.ts',
      'README.md',
    ];
    for (const path of unrelated) expect(pattern.test(path)).toBe(false);
  });
});
