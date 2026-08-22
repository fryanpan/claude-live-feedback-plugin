/**
 * A link's format is decided by WHERE IT LANDS, and the skills have to agree
 * on that in one voice.
 *
 * The failure this pins, measured 2026-08-21: an agent posted a raw URL into a
 * board comment and was right to, by its own reading. `working-in-a-workspace`
 * said to use relative inline links in a workspace; `diff-review` said to hand
 * the URL over "as a bare URL on its own line" and `embedding-widget` said the
 * same about a mockup URL it had just told you to post as a REPLY. Neither of
 * the last two named a destination, so both read as universal, and the more
 * specific-sounding instruction won.
 *
 * Both spellings are correct — for different destinations. Terminal chat gets
 * a bare URL on its own line because chat autolinkers eat the trailing `)` of
 * a markdown link. A workspace surface renders markdown, so a raw URL there is
 * just an unreadable one. The bug was never the advice; it was advice stated
 * without its scope.
 *
 * Content assertions on shipped SKILL.md files, in the style of
 * skills-declare-once.test.ts — peers install the FILE, so the file is what
 * gets pinned. Every guard here runs over every shipped skill rather than a
 * listed few, so a skill added tomorrow is covered without an edit.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS = join(HERE, '../../plugin/skills');
const GENERAL_DIR = 'working-in-a-workspace';
const GENERAL = readFileSync(join(SKILLS, GENERAL_DIR, 'SKILL.md'), 'utf8');

const SHIPPED: Array<[string, string]> = readdirSync(SKILLS, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(SKILLS, d.name, 'SKILL.md')))
  .map((d) => [d.name, readFileSync(join(SKILLS, d.name, 'SKILL.md'), 'utf8')]);

/**
 * One line, lower-cased. Same reason as in skills-declare-once.test.ts: these
 * files are hard-wrapped at ~76 columns, so a multi-word phrase only matches
 * when the wrap happens not to land inside it — survivable for a positive
 * assertion, silently GREEN for a `not.toMatch`.
 */
const flatten = (s: string): string => s.replace(/\s+/g, ' ').toLowerCase();

/** The section that owns the rule. Its exact spelling is what the other
 *  skills point at, so it is a constant rather than a repeated literal. */
const SECTION = 'use links effectively';

/**
 * Every way the chat spelling is said across the shipped skills. A skill may
 * say it — it is correct advice — but only with its destination attached.
 *
 * Built fresh at each use rather than shared: a `g` regex carries `lastIndex`
 * between calls, so a reused one silently starts a later search mid-string and
 * misses what it was pointed at.
 */
const bareUrl = (flags = ''): RegExp =>
  new RegExp('bare(?:,)?(?: url)?,? (?:and )?on its own line', flags);

/** How far from the phrase the qualifier may sit. One sentence, generously
 *  measured: the longest current instance runs ~120 characters from the phrase
 *  to the word `chat`, across a line wrap. */
const NEAR = 200;

/**
 * Just the "Use Links Effectively" section, flattened. Scoped rather than
 * matched against the whole file because the phrases here are ordinary — "in a
 * workspace" appears three sections earlier, and a whole-file match would go
 * green off that sentence with the link rule deleted.
 */
const linkSection = (): string => {
  const body = GENERAL.split(/^## Use Links Effectively$/m)[1] ?? '';
  return flatten(body.split(/^## /m)[0] ?? '');
};

describe('the general skill owns the rule, and states both halves', () => {
  it('has the section the other skills point at', () => {
    expect(GENERAL).toMatch(/^## Use Links Effectively$/m);
    // POSITIVE CONTROL for the slicer: an empty section would satisfy every
    // `not`-shaped read below and most `toMatch` ones would simply fail
    // loudly — but the section boundary is the part worth proving.
    expect(linkSection().length).toBeGreaterThan(100);
  });

  it('gives the workspace destination the inline relative spelling', () => {
    // This is the operator's own sentence and it is quoted here so a reword
    // has to be deliberate — today's whole round of fixes came from agents
    // growing this file's prose.
    expect(linkSection()).toContain(
      'when you share links in a workspace, use relative urls and make them inline using appropriate link text instead of the raw url',
    );
  });

  it('gives the chat destination the bare-on-its-own-line spelling', () => {
    // The addition. Without it the sentence above is the only instruction in
    // the file that names a destination, and every other skill's "bare URL on
    // its own line" has nothing to be the exception to.
    const s = linkSection();
    expect(s).toMatch(/in terminal chat/);
    expect(s).toMatch(bareUrl());
  });
});

describe('no skill teaches a bare URL without naming its destination', () => {
  const offenders: string[] = [];
  let occurrences = 0;

  for (const [name, raw] of SHIPPED) {
    const flat = flatten(raw);
    for (const m of flat.matchAll(bareUrl('g'))) {
      occurrences++;
      const at = m.index ?? 0;
      const window = flat.slice(Math.max(0, at - NEAR), at + m[0].length + NEAR);
      if (!window.includes('chat')) offenders.push(`${name}: …${window}…`);
    }
  }

  it('every bare-URL instruction sits within a sentence of "chat"', () => {
    expect(offenders).toEqual([]);
  });

  // POSITIVE CONTROL: the loop above is vacuous if the phrase stopped matching
  // — a rewording, a new wrap, a bad path — and a vacuous loop passes exactly
  // like a clean one. This asserts the probe still finds real instances.
  it('the probe finds the bare-URL phrase where it is known to live', () => {
    expect(occurrences).toBeGreaterThanOrEqual(2);
    expect(flatten(GENERAL)).toMatch(bareUrl());
  });
});

describe('the two spellings cannot drift apart again', () => {
  it('every skill that hands a URL over points at the one section', () => {
    // A skill may state either spelling, but only as a pointer to the section
    // that holds both — that is what keeps a future edit to one of them from
    // leaving the other behind.
    const missing: string[] = [];
    for (const [name, raw] of SHIPPED) {
      if (name === GENERAL_DIR) continue;
      const flat = flatten(raw);
      const teaches = bareUrl().test(flat) || flat.includes('inline relative link');
      if (!teaches) continue;
      if (!flat.includes(SECTION) || !flat.includes(GENERAL_DIR)) missing.push(name);
    }
    expect(missing).toEqual([]);
  });

  // POSITIVE CONTROL for the guard above: it is vacuous if no skill outside
  // the general one talks about link format at all.
  it('more than one skill hands a URL over', () => {
    const talkers = SHIPPED.filter(([name, raw]) => {
      if (name === GENERAL_DIR) return false;
      const flat = flatten(raw);
      return bareUrl().test(flat) || flat.includes('inline relative link');
    });
    expect(talkers.length).toBeGreaterThanOrEqual(3);
  });

  /**
   * A pointer is a quoted section name followed, within a sentence, by the
   * name of the skill that holds it — `"Use Links Effectively" in
   * claude-workspaces:working-in-a-workspace`. Only that order is matched.
   *
   * The reverse order was tried and dropped: `<skill name> … "<anything>"`
   * fires on the next quoted phrase in the file whatever it is, and in
   * live-review-meeting that is an example of what to say in a thread. A guard
   * that flags prose gets deleted; one that only sees real pointers survives.
   */
  const pointers = (flat: string): string[] =>
    [...flat.matchAll(new RegExp(`"([^"]{4,60})"[^"]{0,${NEAR}}?${GENERAL_DIR}`, 'g'))].map((m) =>
      (m[1] ?? '').trim(),
    );

  it('a quoted section name in a cross-skill pointer exists in the target', () => {
    // `embedding-widget` pointed at "Present the work itself in context" in the
    // general skill — a section that has never existed there. A pointer to a
    // heading that is not there reads as a broken install rather than as a
    // stale reference, and sends the reader hunting.
    const dangling: string[] = [];
    for (const [name, raw] of SHIPPED) {
      if (name === GENERAL_DIR) continue;
      for (const quoted of pointers(flatten(raw))) {
        if (!flatten(GENERAL).includes(quoted)) dangling.push(`${name}: "${quoted}"`);
      }
    }
    expect(dangling).toEqual([]);
  });

  // POSITIVE CONTROL: the same probe, over the same haystack, must find real
  // pointers — otherwise "no dangling names" above means "nothing was read".
  it('the pointer probe finds the section name being pointed at', () => {
    const found = SHIPPED.filter(
      ([name, raw]) => name !== GENERAL_DIR && pointers(flatten(raw)).includes(SECTION),
    ).map(([n]) => n);
    expect(found).toContain('diff-review');
    expect(found.length).toBeGreaterThanOrEqual(3);
  });
});
