import { describe, expect, it } from 'vitest';
import {
  CHECKS,
  type CheckVerdict,
  type ProbeReading,
  SHOTS,
  exitCode,
  formatReport,
  judge,
} from './ui-nightly-lib.ts';

/**
 * The nightly browser run's verdicts, judged against RECORDED payloads.
 *
 * Every reading below was captured by `bun run ui:nightly` against a real
 * headless Chrome on 2026-09-05, and every "broken" reading was captured the
 * same way after deliberately breaking the rule the check is named after:
 *
 *   nav-clears-widget          padding-right on the clearance rule → 0
 *   shell-main-reaches-bottom  `#main { grid-row: 3 }` deleted
 *   hover-guards               `@media (hover: hover)` → `@media (min-width: 1px)`
 *   no-horizontal-overflow     `body.board-body { min-width: 900px }`
 *
 * The signed-out readings in `the signed-out doc` needed no break at all: they
 * are what a browser returned on 2026-09-06 against the shipped stylesheet,
 * where `body.signin-gated #shell` declared a fourth track and no placement to
 * go with it. That is the reading this job could not have produced before,
 * because it only ever rendered the other posture.
 *
 * They are here rather than as prose because a check that has never been seen
 * to fail is a screenshot with extra steps — and two of these assertions were
 * VACUOUS when first written and were caught by exactly this exercise. The
 * hover check read `CSSMediaRule.matches`, which does not exist, so every
 * guard resolved to `false` and only the pointer-side control noticed. The
 * overflow check compared against `documentElement.scrollWidth`, which
 * `body { overflow: hidden }` pins to the viewport on every page of this app,
 * and then against `window.innerWidth`, which GROWS under touch emulation to
 * whatever the content needs. Both passed a 900px-wide body at 430px.
 */

/** A reading with nothing wrong with it; spread and mutate per test. */
function goodBoardPhone(): ProbeReading {
  return {
    innerWidth: 430,
    innerHeight: 932,
    scrollWidth: 430,
    clientWidth: 430,
    hoverSupported: false,
    signedOut: false,
    navItems: [
      { label: 'Home', right: 138.25, hitsSelf: true, hitTag: 'svg' },
      { label: 'Tasks', right: 211.5, hitsSelf: true, hitTag: 'svg' },
      { label: 'My Tasks', right: 284.75, hitsSelf: true, hitTag: 'svg' },
      { label: 'Activity', right: 358, hitsSelf: true, hitTag: 'svg' },
    ],
    hoverRules: [
      {
        selector: '.board-decide-option:hover',
        found: 1,
        sites: [{ guarded: true, matchesHere: false }],
        unreadableSheets: 0,
      },
      {
        selector: '.thread-item-option:hover',
        found: 1,
        sites: [{ guarded: true, matchesHere: false }],
        unreadableSheets: 0,
      },
    ],
    shell: null,
  };
}

function goodBoardIpad(): ProbeReading {
  const r = goodBoardPhone();
  return {
    ...r,
    innerWidth: 1180,
    innerHeight: 820,
    scrollWidth: 1180,
    clientWidth: 1180,
    hoverSupported: true,
    hoverRules: r.hoverRules.map((h) => ({
      ...h,
      sites: h.sites.map((s) => ({ ...s, matchesHere: true })),
    })),
  };
}

function goodDoc(width: number, height: number): ProbeReading {
  return {
    innerWidth: width,
    innerHeight: height,
    scrollWidth: width,
    clientWidth: width,
    hoverSupported: width > 1100,
    signedOut: false,
    navItems: [],
    hoverRules: goodBoardPhone().hoverRules,
    shell: {
      bottom: height,
      tracks: `48px 0px ${height - 48}px`,
      mainTop: 48,
      mainBottom: height,
      inFlow: [
        { id: 'topbar', gridRow: '1', top: 0, bottom: 48 },
        { id: 'main', gridRow: '3', top: 48, bottom: height },
      ],
    },
  };
}

/**
 * The signed-out doc, captured the same way on 2026-09-06, after the
 * four-track grid got the placements to match it. Topbar row 1, bar row 2, the
 * hidden strip's row 3 at zero, the doc in row 4 — which is the flexible
 * track, so `#main` reaches the bottom and there is no band to tap into.
 *
 * The bar's track is `auto`, and these numbers are why that is not a detail:
 * 33px at 1180x820 but 49px at 430px, where its two spans wrap to a second
 * line. The rule this replaced gave the bar a fixed 48px.
 */
function goodGatedDoc(width: number, height: number): ProbeReading {
  const bar = width <= 430 ? 49 : 33;
  return {
    ...goodDoc(width, height),
    signedOut: true,
    shell: {
      bottom: height,
      tracks: `48px ${bar}px 0px ${height - 48 - bar}px`,
      mainTop: 48 + bar,
      mainBottom: height,
      // Document order, as the probe walks `#shell.children`: the bar is
      // inserted FIRST and rendered SECOND.
      inFlow: [
        { id: '.signin-bar', gridRow: '2', top: 48, bottom: 48 + bar },
        { id: 'topbar', gridRow: '1', top: 0, bottom: 48 },
        { id: 'main', gridRow: '4', top: 48 + bar, bottom: height },
      ],
    },
  };
}

function goodRun(): Map<string, ProbeReading | Error> {
  return new Map<string, ProbeReading | Error>([
    ['board-phone', goodBoardPhone()],
    ['board-ipad', goodBoardIpad()],
    ['doc-phone', goodDoc(430, 932)],
    ['doc-ipad', goodDoc(1180, 820)],
    ['doc-phone-gated', goodGatedDoc(430, 932)],
    ['doc-ipad-gated', goodGatedDoc(1180, 820)],
  ]);
}

const failing = (v: readonly CheckVerdict[]) => v.filter((x) => !x.ok).map((x) => x.id);
const detailOf = (v: readonly CheckVerdict[], id: string) =>
  v.find((x) => x.id === id)?.detail ?? '';

describe('the nightly run on a healthy build', () => {
  it('passes every check', () => {
    const verdicts = judge(goodRun());
    expect(failing(verdicts)).toEqual([]);
    expect(exitCode(verdicts)).toBe(0);
  });

  it('judges every check, and every check names a shot that is actually taken', () => {
    const verdicts = judge(goodRun());
    expect(verdicts).toHaveLength(CHECKS.length);
    const shotIds = new Set(SHOTS.map((s) => s.id));
    for (const check of CHECKS) expect(shotIds.has(check.shot), check.id).toBe(true);
  });
});

describe('nav-clears-widget', () => {
  it('fails when a tab hit-tests to the widget, and names the tab', () => {
    // Recorded with the clearance rule's padding-right set to 0: the fixed
    // 48px bubble sits over the centre of the rightmost tab.
    const broken = goodBoardPhone();
    broken.navItems[3] = {
      label: 'Activity',
      right: 430,
      hitsSelf: false,
      hitTag: 'claude-feedback-widget',
    };
    const verdicts = judge(new Map(goodRun()).set('board-phone', broken));
    expect(failing(verdicts)).toEqual(['nav-clears-widget']);
    expect(detailOf(verdicts, 'nav-clears-widget')).toContain('Activity');
    expect(detailOf(verdicts, 'nav-clears-widget')).toContain('claude-feedback-widget');
  });

  it('fails rather than passes when the probe found no tabs at all', () => {
    // The vacuous case. An empty list satisfies "every tab hits itself".
    const broken = { ...goodBoardPhone(), navItems: [] };
    const verdicts = judge(new Map(goodRun()).set('board-phone', broken));
    expect(failing(verdicts)).toContain('nav-clears-widget');
    expect(detailOf(verdicts, 'nav-clears-widget')).toContain('proved nothing');
  });
});

describe('shell-main-reaches-bottom', () => {
  // The two numbers below are what `#main { grid-row: 3 }` deleted actually
  // measured, and they are the numbers styles.css records for the shipped bug.
  it.each([
    ['doc-ipad', 1180, 820, 780, 40],
    ['doc-phone', 430, 932, 831.66, 100.34],
  ])('fails on %s, reporting the %spx band', (shot, w, h, mainBottom, gap) => {
    const broken = goodDoc(w as number, h as number);
    if (!broken.shell) throw new Error('fixture lost its shell');
    broken.shell.mainBottom = mainBottom as number;
    broken.shell.inFlow[1] = { id: 'main', gridRow: 'auto', top: 48, bottom: mainBottom as number };
    const verdicts = judge(new Map(goodRun()).set(shot as string, broken));
    const id =
      shot === 'doc-ipad' ? 'shell-main-reaches-bottom-ipad' : 'shell-main-reaches-bottom-phone';
    expect(failing(verdicts)).toEqual([id]);
    expect(detailOf(verdicts, id)).toContain(`${gap}px above`);
    expect(detailOf(verdicts, id)).toContain('main@row auto');
  });

  it('fails rather than passes when #shell is missing entirely', () => {
    const broken = { ...goodDoc(430, 932), shell: null };
    const verdicts = judge(new Map(goodRun()).set('doc-phone', broken));
    expect(detailOf(verdicts, 'shell-main-reaches-bottom-phone')).toContain('lost its subject');
  });

  it('tolerates sub-pixel rounding', () => {
    const near = goodDoc(430, 932);
    if (!near.shell) throw new Error('fixture lost its shell');
    near.shell.mainBottom = 931.5;
    expect(failing(judge(new Map(goodRun()).set('doc-phone', near)))).toEqual([]);
  });
});

/**
 * The signed-out posture, and the reading this whole pair of shots was added
 * for. Every payload below is what a browser actually returned BEFORE the
 * placements were added — not an invented mutation — so these say what the
 * nightly would have reported on the night the bug shipped, had it rendered
 * the page at all.
 */
describe('the signed-out doc', () => {
  /** The gated doc exactly as it shipped: bar unplaced, #main in row 3 of 4. */
  function asShipped(width: number, height: number): ProbeReading {
    const topbar = width <= 430 ? 45 : 37;
    const mainBottom = width <= 430 ? 876.66 : 817;
    return {
      ...goodGatedDoc(width, height),
      shell: {
        bottom: height,
        tracks: width <= 430 ? '45px 48px 783.656px 55.3438px' : '37px 48px 732px 3px',
        mainTop: topbar + 48,
        mainBottom,
        inFlow: [
          { id: '.signin-bar', gridRow: 'auto', top: topbar, bottom: topbar + 48 },
          { id: 'topbar', gridRow: '1', top: 0, bottom: topbar },
          { id: 'main', gridRow: '3', top: topbar + 48, bottom: mainBottom },
        ],
      },
    };
  }

  it.each([
    ['doc-ipad-gated', 1180, 820, 3],
    ['doc-phone-gated', 430, 932, 55.34],
  ])('catches the band the gated grid shipped on %s (%spx)', (shot, w, h, gap) => {
    const verdicts = judge(
      new Map(goodRun()).set(shot as string, asShipped(w as number, h as number)),
    );
    const geometry = `shell-main-reaches-bottom-gated-${shot === 'doc-ipad-gated' ? 'ipad' : 'phone'}`;
    // BOTH fire, and that is the point: the band is the symptom and the
    // unplaced bar is the cause, so the log names the fix and not just the gap.
    expect(failing(verdicts).sort()).toEqual([`posture-rendered-${shot}`, geometry].sort());
    expect(detailOf(verdicts, geometry)).toContain(`${gap}px above`);
    expect(detailOf(verdicts, geometry)).toContain('.signin-bar@row auto');
    expect(detailOf(verdicts, `posture-rendered-${shot}`)).toContain('AUTO-PLACED');
  });

  it('fails when a gated shot came back as the ordinary signed-in page', () => {
    // The failure that would make every other gated check vacuous: the server
    // was gated, the browser was not, and the geometry read healthy because it
    // was measuring the page that has always been fine.
    const wrongPage = { ...goodDoc(430, 932), signedOut: false };
    const verdicts = judge(new Map(goodRun()).set('doc-phone-gated', wrongPage));
    expect(failing(verdicts)).toEqual(['posture-rendered-doc-phone-gated']);
    expect(detailOf(verdicts, 'posture-rendered-doc-phone-gated')).toContain(
      'does not carry `signin-gated`',
    );
  });

  it('fails when the class is on <body> but no bar became a grid item', () => {
    const noBar = goodGatedDoc(430, 932);
    if (!noBar.shell) throw new Error('fixture lost its shell');
    noBar.shell.inFlow = noBar.shell.inFlow.filter((c) => c.id !== '.signin-bar');
    const verdicts = judge(new Map(goodRun()).set('doc-phone-gated', noBar));
    expect(failing(verdicts)).toEqual(['posture-rendered-doc-phone-gated']);
    expect(detailOf(verdicts, 'posture-rendered-doc-phone-gated')).toContain('not a grid item');
  });

  /**
   * The control on the OTHER side. Without it, `postureRendered` could be
   * satisfied by a build that mounted the bar for everybody — the gated shots
   * would pass and the page every signed-in reader sees would have silently
   * gained a row.
   */
  it('control: a signed-in shot that gained the gated class fails too', () => {
    const gatedEverywhere = { ...goodDoc(1180, 820), signedOut: true };
    const verdicts = judge(new Map(goodRun()).set('doc-ipad', gatedEverywhere));
    expect(failing(verdicts)).toEqual(['posture-rendered-doc-ipad']);
    expect(detailOf(verdicts, 'posture-rendered-doc-ipad')).toContain('carries `signin-gated`');
  });
});

describe('hover guards', () => {
  it('fails BOTH sides when a hover treatment leaves the media guard', () => {
    // Recorded with `@media (hover: hover)` rewritten to `@media (min-width: 1px)`.
    const unguard = (r: ProbeReading): ProbeReading => ({
      ...r,
      hoverRules: [
        { ...r.hoverRules[0], sites: [{ guarded: false, matchesHere: null }] },
        r.hoverRules[1],
      ],
    });
    const verdicts = judge(
      new Map(goodRun())
        .set('board-phone', unguard(goodBoardPhone()))
        .set('board-ipad', unguard(goodBoardIpad())),
    );
    expect(failing(verdicts)).toEqual([
      'hover-guards-inert-on-touch',
      'hover-guards-live-on-pointer',
    ]);
    expect(detailOf(verdicts, 'hover-guards-inert-on-touch')).toContain(
      'outside @media (hover: hover)',
    );
  });

  it('fails when the selector has been renamed away', () => {
    const broken = goodBoardPhone();
    broken.hoverRules[0] = { ...broken.hoverRules[0], found: 0, sites: [] };
    const verdicts = judge(new Map(goodRun()).set('board-phone', broken));
    expect(detailOf(verdicts, 'hover-guards-inert-on-touch')).toContain(
      'no rule matching .board-decide-option:hover',
    );
  });

  it('fails when a stylesheet could not be read, rather than reporting "no such rule"', () => {
    const broken = goodBoardPhone();
    broken.hoverRules = broken.hoverRules.map((h) => ({ ...h, unreadableSheets: 1 }));
    const verdicts = judge(new Map(goodRun()).set('board-phone', broken));
    expect(detailOf(verdicts, 'hover-guards-inert-on-touch')).toContain('never actually checked');
  });

  /**
   * The control that caught the real bug. `CSSMediaRule` has no `matches`, so
   * the first version of the probe reported `false` for every guard on every
   * device — which is exactly what a correct phone reading looks like. Only
   * the pointer side could tell the two apart.
   */
  it('control: a guard that resolves false EVERYWHERE fails the pointer side', () => {
    const alwaysInert = goodBoardIpad();
    alwaysInert.hoverRules = alwaysInert.hoverRules.map((h) => ({
      ...h,
      sites: h.sites.map((s) => ({ ...s, matchesHere: false })),
    }));
    const verdicts = judge(new Map(goodRun()).set('board-ipad', alwaysInert));
    expect(failing(verdicts)).toEqual(['hover-guards-live-on-pointer']);
    expect(detailOf(verdicts, 'hover-guards-live-on-pointer')).toContain('expected true');
  });

  it('fails when the emulated device is not the one the check assumes', () => {
    const broken = { ...goodBoardPhone(), hoverSupported: true };
    const verdicts = judge(new Map(goodRun()).set('board-phone', broken));
    expect(detailOf(verdicts, 'hover-guards-inert-on-touch')).toContain('the emulation is not');
  });
});

describe('no-horizontal-overflow', () => {
  it('fails on content wider than the LAYOUT viewport', () => {
    // Recorded with `body.board-body { min-width: 900px }` at the 430px preset.
    // Note innerWidth: touch emulation grew the visual viewport to 900 to fit
    // the content, so innerWidth compares equal and clientWidth is the only
    // reading that still knows the device is 430 wide.
    const broken = { ...goodBoardPhone(), innerWidth: 900, scrollWidth: 900, clientWidth: 430 };
    const verdicts = judge(new Map(goodRun()).set('board-phone', broken));
    expect(failing(verdicts)).toEqual(['no-horizontal-overflow-board-phone']);
    expect(detailOf(verdicts, 'no-horizontal-overflow-board-phone')).toContain(
      '900px wide in a 430px viewport',
    );
  });

  it('control: comparing against innerWidth would have passed that same reading', () => {
    const broken = { ...goodBoardPhone(), innerWidth: 900, scrollWidth: 900, clientWidth: 430 };
    expect(broken.scrollWidth > broken.innerWidth).toBe(false);
  });
});

describe('a shot that never rendered', () => {
  it('fails every check that depended on it, naming the browser error', () => {
    const readings = new Map(goodRun());
    readings.set('board-phone', new Error('--wait-for ".board-nav" never matched'));
    const verdicts = judge(readings);
    expect(failing(verdicts)).toEqual([
      'nav-clears-widget',
      'hover-guards-inert-on-touch',
      'no-horizontal-overflow-board-phone',
    ]);
    expect(detailOf(verdicts, 'nav-clears-widget')).toContain('never matched');
    expect(exitCode(verdicts)).toBe(1);
  });

  it('fails, rather than skips, when a shot is missing from the run', () => {
    const readings = new Map(goodRun());
    readings.delete('doc-ipad');
    const verdicts = judge(readings);
    expect(failing(verdicts)).toContain('shell-main-reaches-bottom-ipad');
    expect(detailOf(verdicts, 'shell-main-reaches-bottom-ipad')).toContain('was never taken');
  });
});

describe('the report', () => {
  it('lists every check and says the run was clean', () => {
    const text = formatReport(judge(goodRun()));
    expect(text).toContain(`All ${CHECKS.length} checks passed.`);
    for (const check of CHECKS) expect(text).toContain(check.id);
    expect(text).not.toContain('FAIL');
  });

  it('puts the failure detail under the table, so a log tail carries it', () => {
    const readings = new Map(goodRun());
    const broken = goodBoardPhone();
    broken.navItems[3] = { label: 'Activity', right: 430, hitsSelf: false, hitTag: 'div' };
    readings.set('board-phone', broken);
    const text = formatReport(judge(readings));
    expect(text).toContain('FAIL  nav-clears-widget');
    expect(text).toContain(`1 of ${CHECKS.length} checks failed:`);
    expect(text.indexOf('checks failed:')).toBeGreaterThan(text.indexOf('FAIL  nav-clears-widget'));
  });
});
