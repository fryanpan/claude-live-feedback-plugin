/*
 * The Home-pane mockup is a single self-contained HTML file whose every control
 * re-renders the whole pane by reassigning `innerHTML`. That makes anything the
 * reader has TYPED and not yet sent a thing the page can silently destroy: the
 * recipe textarea was re-emitted from the module-level RECIPE, and the reply
 * boxes were re-emitted empty, so "Mark caught up", the stepper, Skip, an A/B
 * switch or the phone toggle all discarded unsent text with no warning.
 *
 * Each case here carries a positive control asserting the re-render ACTUALLY
 * RAN — without it, a "fix" that simply stopped re-rendering would pass every
 * preservation assertion while breaking the page.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const MOCKUP = join(HERE, '../../../demos/lf-home-pane-mockup-v1.html');

type Mockup = {
  render: () => void;
  markRead: () => void;
  step: (d: number) => void;
  skip: (id: string) => void;
  setPhone: (v: boolean) => void;
  setQueue: (m: string) => void;
  setDetail: (m: string) => void;
  toggleRecipe: () => boolean;
  nudge: (line: string) => void;
  rerun: () => void;
  answerFree: (id: string) => void;
  undoAnswer: (id: string) => void;
  resetAll: () => void;
  recipe: () => string;
};

/*
 * The mockup ships as one HTML file with one inline <script>; there is no module
 * to import, so the harness runs that exact script text. `new Function` (rather
 * than a bundler or a rewrite) is what keeps this test honest: it evaluates the
 * shipped source verbatim, and the function scope lets each test re-declare the
 * script's top-level `const`s from scratch. The input is a file in this repo,
 * not anything a user supplies.
 */
function load(): Mockup {
  const html = readFileSync(MOCKUP, 'utf8');
  const bodyStart = html.indexOf('<body>') + '<body>'.length;
  const scriptStart = html.indexOf('<script>');
  const scriptEnd = html.indexOf('</script>');
  expect(scriptStart).toBeGreaterThan(bodyStart);
  document.body.innerHTML = html.slice(bodyStart, scriptStart);
  const script = html.slice(scriptStart + '<script>'.length, scriptEnd);
  const api = new Function(
    `${script}\nreturn { render, markRead, step, skip, setPhone, setQueue, setDetail,
       toggleRecipe, nudge, rerun, answerFree, undoAnswer, resetAll, recipe: () => RECIPE };`,
  )() as Mockup;
  // The page renders on load; if it did not, every assertion below is vacuous.
  expect(document.getElementById('brief')).toBeTruthy();
  return api;
}

const rcp = () => document.getElementById('rcp') as HTMLTextAreaElement | null;
const scope = () => document.getElementById('scope') as HTMLSelectElement | null;
const reply = (id: string) => document.getElementById(`free-${id}`) as HTMLTextAreaElement | null;
const briefFoot = () => document.querySelector('.brief-foot')?.textContent ?? '';
const stepPos = () => document.querySelector('.stepper .pos')?.textContent?.trim() ?? '';

/** Open the recipe panel and type an extra instruction into it. */
function typeIntoRecipe(api: Mockup, line: string): string {
  api.toggleRecipe();
  const box = rcp();
  expect(box).toBeTruthy();
  const edited = `${(box as HTMLTextAreaElement).value}\n- ${line}`;
  (box as HTMLTextAreaElement).value = edited;
  return edited;
}

describe('home pane mockup — typed text survives a re-render', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('keeps an edited recipe when Mark caught up re-renders the pane', () => {
    const api = load();
    const edited = typeIntoRecipe(api, 'Always name the blocker.');
    expect(briefFoot()).toContain('Mark caught up'); // control: before state

    api.markRead();

    expect(briefFoot()).toContain('Caught up'); // control: the pane really re-rendered
    expect(rcp()?.value).toBe(edited);
    expect(api.recipe()).toContain('Always name the blocker.');
  });

  it('keeps an edited recipe across the stepper, Skip, an A/B switch and the phone toggle', () => {
    const api = load();
    const edited = typeIntoRecipe(api, 'Name the person who is blocked.');

    api.step(1);
    expect(stepPos()).toBe('2 of 5'); // control: the stepper moved
    expect(rcp()?.value).toBe(edited);

    api.skip('d1');
    expect(rcp()?.value).toBe(edited);

    api.setQueue('stack');
    expect(document.querySelector('.stepper .pos')?.textContent).toContain('stack'); // control
    expect(rcp()?.value).toBe(edited);

    api.setDetail('disclosure');
    expect(document.querySelector('.disclosure')).toBeTruthy(); // control
    expect(rcp()?.value).toBe(edited);

    api.setPhone(true);
    expect(document.getElementById('stage')?.classList.contains('phone')).toBe(true); // control
    expect(rcp()?.value).toBe(edited);
  });

  it('keeps an edited recipe when the recipe panel is closed and reopened', () => {
    const api = load();
    const edited = typeIntoRecipe(api, 'Say what is NOT waiting on anyone.');

    api.toggleRecipe(); // close
    expect(document.querySelector('.recipe')?.classList.contains('show')).toBe(false); // control
    api.toggleRecipe(); // reopen

    expect(document.querySelector('.recipe')?.classList.contains('show')).toBe(true);
    expect(rcp()?.value).toBe(edited);
  });

  it('appends a nudge to the edited instructions rather than to the seed', () => {
    const api = load();
    typeIntoRecipe(api, 'Always name the blocker.');

    api.nudge('Too long — cut it to five sentences.');

    const after = rcp()?.value ?? '';
    expect(after).toContain('Always name the blocker.');
    expect(after).toContain('Too long — cut it to five sentences.');
    expect(api.recipe()).toBe(after);
  });

  it('keeps the chosen coverage window across a re-render', () => {
    const api = load();
    api.toggleRecipe();
    const sel = scope();
    expect(sel?.options.length).toBe(3);
    (sel as HTMLSelectElement).selectedIndex = 1;

    api.markRead();

    expect(briefFoot()).toContain('Caught up'); // control
    expect(scope()?.selectedIndex).toBe(1);
  });

  it('keeps an unsent reply when the stepper moves away and back', () => {
    const api = load();
    api.step(1);
    expect(stepPos()).toBe('2 of 5'); // control: we are on the task card
    const box = reply('t1');
    expect(box).toBeTruthy();
    (box as HTMLTextAreaElement).value = 'Keep it for the reconciler only.';

    api.step(1);
    expect(stepPos()).toBe('3 of 5'); // control: we really left the card
    expect(reply('t1')).toBeNull();
    api.step(-1);

    expect(stepPos()).toBe('2 of 5');
    expect(reply('t1')?.value).toBe('Keep it for the reconciler only.');
  });

  it('keeps unsent replies to several items at once in the stacked queue', () => {
    const api = load();
    api.setQueue('stack');
    (reply('d1') as HTMLTextAreaElement).value = 'Two hops, and prune later.';
    (reply('t1') as HTMLTextAreaElement).value = 'Remove it for the mobile client.';

    api.setPhone(true);

    expect(document.getElementById('stage')?.classList.contains('phone')).toBe(true); // control
    expect(reply('d1')?.value).toBe('Two hops, and prune later.');
    expect(reply('t1')?.value).toBe('Remove it for the mobile client.');
  });

  it('clears a reply once it has been sent, and reset clears every draft', () => {
    const api = load();
    api.step(1);
    (reply('t1') as HTMLTextAreaElement).value = 'Remove it and let both callers fail.';
    api.answerFree('t1');

    // control: the send landed, and the running order says so
    expect(document.querySelector('.bound')?.textContent).toContain(
      'answered: Remove it and let both callers fail.',
    );

    api.undoAnswer('t1');
    api.step(1);
    expect(stepPos()).toBe('2 of 5');
    expect(reply('t1')?.value).toBe(''); // a sent reply is not a lingering draft

    (reply('t1') as HTMLTextAreaElement).value = 'draft again';
    const edited = typeIntoRecipe(api, 'A line I typed.');
    expect(rcp()?.value).toBe(edited);

    api.resetAll();

    expect(rcp()?.value).not.toContain('A line I typed.');
    expect(api.recipe()).not.toContain('A line I typed.');
    api.step(1);
    expect(reply('t1')?.value).toBe('');
  });
});
