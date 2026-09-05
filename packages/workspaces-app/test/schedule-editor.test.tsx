/**
 * The panel's schedule section, driven the way a reader drives it.
 *
 * The property under test is the one Bryan put on the mock: the phrase and the
 * chips are two views of ONE rule. So every case here does something to one
 * view and asserts the OTHER changed — type a sentence and read the chips,
 * click a chip and read the sentence back. A test that only checked the
 * parser would pass while the editor showed a rule nobody could edit.
 *
 * Layout is asserted at both tiers by reading computed styles over the real
 * stylesheet, not by grepping it. Geometry stays a headless-Chromium check.
 *
 * Fixtures are invented; the repo is public.
 */
import { options, render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HubTask, ScheduleWrite } from '../src/hub/hub-board-model.ts';
import { ScheduleEditor } from '../src/hub/schedule-editor.tsx';
import { IPAD, PHONE, installSheets, setViewport, styleOf } from './css-harness.ts';

// A click here is asserted on the very next line, so renders flush inline —
// the same seam the other island suites use.
options.debounceRendering = (cb: () => void) => cb();

const TZ = 'America/Los_Angeles';
/** 2026-09-05 10:00 local, a Saturday. */
const NOW = Date.UTC(2026, 8, 5, 17, 0, 0);

let cleanup: (() => void) | undefined;
let host: HTMLElement | undefined;

afterEach(() => {
  if (host) render(null, host);
  host?.remove();
  host = undefined;
  cleanup?.();
  cleanup = undefined;
  document.body.innerHTML = '';
});

function task(over: Partial<HubTask> = {}): HubTask {
  return {
    id: 't-lamp',
    title: 'Post the harbour digest',
    status: 'todo',
    assignee: 'Lamplighter',
    goal: 'g-lights',
    order: 1,
    after: [],
    links: [],
    transitions: [],
    bodyDocId: 'task:t-lamp',
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  } as HubTask;
}

function mount(over: Partial<HubTask> = {}, onSet = vi.fn(async () => true)) {
  host = document.createElement('div');
  document.body.appendChild(host);
  render(<ScheduleEditor task={task(over)} now={NOW} timezone={TZ} onSet={onSet} />, host);
  return { onSet };
}

const $ = <T extends Element>(sel: string): T => {
  const el = host?.querySelector<T>(sel);
  if (!el) throw new Error(`no ${sel} in the editor`);
  return el;
};
const input = (): HTMLInputElement => $<HTMLInputElement>('.hub-sched-input');
const chipText = (): string[] =>
  [...(host?.querySelectorAll('.hub-sched-chip') ?? [])].map((c) =>
    (c.textContent ?? '').replace(/\s+/g, ' ').trim(),
  );

function type(value: string): void {
  const el = input();
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function click(el: Element | null | undefined): void {
  if (!el) throw new Error('nothing to click');
  (el as HTMLElement).click();
}

describe('an unscheduled row', () => {
  it('shows one affordance and no phrase box', () => {
    mount();
    expect(host?.querySelector('.hub-sched-arm')).not.toBeNull();
    expect(host?.querySelector('.hub-sched-input')).toBeNull();
  });

  it('opens the phrase box when the affordance is tapped', () => {
    mount();
    click(host?.querySelector('.hub-sched-arm'));
    expect(input().value).toBe('');
    // The examples are offered rather than explained — no caption anywhere in
    // the section (owner's standing rule).
    expect(host?.querySelectorAll('.hub-sched-try').length).toBe(4);
  });
});

describe('a phrase derives the chips', () => {
  it('reads "every weekday at 9am" into a cadence, a time and the lit weekdays', () => {
    mount();
    click(host?.querySelector('.hub-sched-arm'));
    type('every weekday at 9am');
    expect(chipText()).toContain('Every weekday');
    expect(chipText()).toContain('9am');
    const lit = [...(host?.querySelectorAll('.hub-sched-day.is-on') ?? [])].map((d) =>
      d.getAttribute('aria-label'),
    );
    expect(lit).toEqual(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']);
  });

  it('reads two times out of "twice a day at 9 and 5"', () => {
    mount();
    click(host?.querySelector('.hub-sched-arm'));
    type('twice a day at 9 and 5');
    expect(chipText()).toContain('9am×');
    expect(chipText()).toContain('5pm×');
  });

  it('reads a one-off as a date and a time, with no repeat controls', () => {
    mount();
    click(host?.querySelector('.hub-sched-arm'));
    type('Sep 10 at 3pm');
    expect(chipText()).toContain('Sep 10');
    expect(chipText()).toContain('3pm');
    expect(host?.querySelector('.hub-sched-days')).toBeNull();
    expect(host?.querySelector('.hub-sched-end')).toBeNull();
  });

  it('keeps the last good chips while a phrase is half-typed, and says the box is wrong', () => {
    mount();
    click(host?.querySelector('.hub-sched-arm'));
    type('every weekday at 9am');
    type('every weekday at nine');
    expect(chipText()).toContain('Every weekday');
    expect(input().getAttribute('aria-invalid')).toBe('true');
  });

  it('will not save a phrase that did not read, and tells assistive tech why', () => {
    const onSet = vi.fn(async () => true);
    mount({}, onSet);
    click(host?.querySelector('.hub-sched-arm'));
    type('every weekday at 9am');
    type('every purple');
    const save = $<HTMLButtonElement>('.hub-sched-save');
    expect(input().getAttribute('aria-invalid')).toBe('true');
    expect(save.disabled).toBe(true);
    const whyId = input().getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(whyId)?.textContent).toBe('did not understand "purple"');
    click(save);
    expect(onSet).not.toHaveBeenCalled();
    // Reading again clears the block, and the description with it.
    type('every weekday at 9am');
    expect(save.disabled).toBe(false);
    expect(input().hasAttribute('aria-describedby')).toBe(false);
  });

  it('offers an example that fills the box and derives from it', () => {
    mount();
    click(host?.querySelector('.hub-sched-arm'));
    const example = [...(host?.querySelectorAll('.hub-sched-try') ?? [])].find(
      (b) => b.textContent === 'every Monday 9:00 until Dec',
    );
    click(example);
    // Verbatim: the chip says what it will put in the box. What it teaches is
    // that the sentence was UNDERSTOOD, which is the chips below it.
    expect(input().value).toBe('every Monday 9:00 until Dec');
    expect(chipText()).toContain('Every Monday');
    expect(chipText()).toContain('Until Dec');
  });
});

describe('a chip edit rewrites the phrase', () => {
  const open = (phrase: string) => {
    const m = mount();
    click(host?.querySelector('.hub-sched-arm'));
    type(phrase);
    return m;
  };

  it('turning a weekday off rewrites the sentence in canonical English', () => {
    open('every weekday at 9am');
    const wed = host?.querySelector('.hub-sched-day[aria-label="Wednesday"]');
    click(wed);
    expect(input().value).toBe('every Monday, Tuesday, Thursday and Friday at 9am');
    expect(chipText()).toContain('Every Monday, Tuesday, Thursday and Friday');
  });

  it('removing a time rewrites the sentence, and the last time cannot be removed', () => {
    open('twice a day at 9 and 5');
    click(host?.querySelector('.hub-sched-x'));
    expect(input().value).toBe('every day at 5pm');
    expect(host?.querySelector('.hub-sched-x')).toBeNull();
  });

  it('adding a time rewrites the sentence', () => {
    open('every day at 9am');
    click(host?.querySelector('.hub-sched-add'));
    expect(input().value).toBe('every day at 9am and 12pm');
  });

  it('cycling the cadence chip walks day → weekday → weekend → day', () => {
    open('every day at 9am');
    const cadence = () => host?.querySelector('.hub-sched-chip[aria-label^="Repeats"]');
    click(cadence());
    expect(input().value).toBe('every weekday at 9am');
    click(cadence());
    expect(input().value).toBe('every weekend at 9am');
    click(cadence());
    expect(input().value).toBe('every day at 9am');
  });

  it('picking an end date adds the clause, and clearing it takes the clause away', () => {
    open('every day at 9am');
    const end = $<HTMLInputElement>('.hub-sched-end-input');
    end.value = '2026-12-01';
    end.dispatchEvent(new Event('change', { bubbles: true }));
    expect(input().value).toBe('every day at 9am until Dec');
    end.value = '';
    end.dispatchEvent(new Event('change', { bubbles: true }));
    expect(input().value).toBe('every day at 9am');
  });

  it('flipping the mode rewrites the sentence, and flipping back restores the rule', () => {
    open('every weekday at 9am');
    const modes = () => [...(host?.querySelectorAll('.hub-sched-mode-btn') ?? [])];
    click(modes()[1]);
    expect(input().value).toBe("1 day after it's done");
    expect(modes()[1]?.getAttribute('aria-pressed')).toBe('true');
    // Back is the rule they left, not the interval it would otherwise derive.
    click(modes()[0]);
    expect(input().value).toBe('every weekday at 9am');
  });

  it('says when the rule is next owed, and says an open instance is what it waits on', () => {
    open('every weekday at 9am');
    // NOW is a Saturday, so the next weekday nine is Monday.
    expect($('.hub-sched-next-v').textContent).toBe('Mon, Sep 7, 9am');
    click([...(host?.querySelectorAll('.hub-sched-mode-btn') ?? [])][1]);
    expect($('.hub-sched-next-v').textContent).not.toBe('');
  });
});

describe('saving and clearing', () => {
  it('sends the rule the chips are showing, with the reader’s zone', async () => {
    const onSet = vi.fn(async () => true);
    mount({}, onSet);
    click(host?.querySelector('.hub-sched-arm'));
    type('every weekday at 9am');
    click(host?.querySelector('.hub-sched-save'));
    await Promise.resolve();
    expect(onSet).toHaveBeenCalledWith({
      rule: { kind: 'calendar', times: [{ hour: 9, minute: 0 }], weekdays: [1, 2, 3, 4, 5] },
      timezone: TZ,
    } satisfies ScheduleWrite);
  });

  it('opens an armed row on its own rule, spelled canonically', () => {
    mount({
      schedule: {
        rule: { kind: 'calendar', times: [{ hour: 9, minute: 0 }], weekdays: [1] },
        timezone: TZ,
        armedAt: NOW,
      },
    });
    expect(input().value).toBe('every Monday at 9am');
    expect(host?.querySelector('.hub-sched-arm')).toBeNull();
    // The buttons say what they do to a rule that already exists.
    expect($('.hub-sched-save').textContent).toBe('Update');
  });

  it('clears the rule with null, which the route reads as an explicit clear', async () => {
    const onSet = vi.fn(async () => true);
    mount(
      {
        schedule: {
          rule: { kind: 'every', everyMs: 1_200_000 },
          armedAt: NOW,
        },
      },
      onSet,
    );
    expect(input().value).toBe('every 20 minutes');
    click([...(host?.querySelectorAll('.hub-sched-actions .hub-btn') ?? [])][0]);
    await Promise.resolve();
    expect(onSet).toHaveBeenCalledWith(null);
  });
});

describe('the section at both tiers', () => {
  it('lays the phrase box, chips and buttons out on the panel’s scale at 1180x820', () => {
    cleanup = installSheets('hub.css', 'styles.css', 'tokens.css');
    setViewport(IPAD);
    mount({ schedule: { rule: { kind: 'every', everyMs: 1_200_000 }, armedAt: NOW } });
    // The phrase box is a touch target and the chips clear the 28px floor, so
    // nothing in the section is a mouse-only hit area on the iPad.
    expect(styleOf($('.hub-sched-nl')).minHeight).toBe('44px');
    expect(styleOf($('.hub-sched-chip')).minHeight).toBe('32px');
    // The next-run line rides the right edge beside the mode control, which is
    // what keeps the section four rows tall where height is scarce.
    expect(styleOf($('.hub-sched-next')).marginLeft).toBe('auto');
    expect(styleOf($('.hub-sched-actions')).justifyContent).toBe('flex-end');
  });

  it('drops the next-run line to its own row and splits the buttons at 430px', () => {
    cleanup = installSheets('hub.css', 'styles.css', 'tokens.css');
    setViewport(PHONE);
    mount({ schedule: { rule: { kind: 'every', everyMs: 1_200_000 }, armedAt: NOW } });
    const next = styleOf($('.hub-sched-next'));
    expect(next.marginLeft).toBe('0px');
    expect(next.width).toBe('100%');
    expect(styleOf($('.hub-sched-save')).flex).toBe('1 1 auto');
    // …and the phrase box is still the primary control, not shrunk away.
    expect(styleOf($('.hub-sched-nl')).minHeight).toBe('44px');
  });
});
