/**
 * What the nightly browser run measures, and what counts as a regression.
 *
 * `ui:shot` renders a page in headless Chrome and prints what it saw. It does
 * not judge. Everything that turns a reading into a verdict lives here, as
 * pure functions over a recorded probe payload — so the judgements are unit
 * tested against real captures, including MUTATED captures that reproduce the
 * bugs each check is named after. A browser check nobody has ever seen go red
 * is a screenshot with extra steps.
 *
 * Nothing in this file spawns a process, reads a file or touches a network.
 */

/* ===== The payload scripts/ui-nightly-probe.js returns ===== */

export interface NavItemReading {
  label: string;
  right: number;
  hitsSelf: boolean;
  hitTag: string | null;
}

export interface HoverSiteReading {
  /** Inside an `@media (…hover…)` block. */
  guarded: boolean;
  /** Does that block match on THIS emulated device? Null when unguarded. */
  matchesHere: boolean | null;
}

export interface HoverRuleReading {
  selector: string;
  found: number;
  sites: HoverSiteReading[];
  unreadableSheets: number;
}

export interface ShellChildReading {
  id: string;
  gridRow: string;
  top: number;
  bottom: number;
}

export interface ShellReading {
  bottom: number;
  tracks: string;
  mainTop: number | null;
  mainBottom: number | null;
  inFlow: ShellChildReading[];
}

export interface ProbeReading {
  innerWidth: number;
  innerHeight: number;
  scrollWidth: number;
  clientWidth: number;
  hoverSupported: boolean;
  navItems: NavItemReading[];
  hoverRules: HoverRuleReading[];
  shell: ShellReading | null;
}

/* ===== Shots: which page, at which viewport ===== */

export type PageKind = 'board' | 'doc';
export type Preset = 'ipad' | 'phone';

export interface Shot {
  id: string;
  page: PageKind;
  preset: Preset;
  /** Selector `ui:shot --wait-for` polls before measuring. */
  waitFor: string;
}

/**
 * Four renders: the board and a markdown doc, each at the two viewports
 * docs/product/design-mobile.md names. The phone shots are where the layout
 * bugs this suite exists for actually appeared; the iPad shots are Bryan's own
 * device and the positive control for the hover checks — the same assertion
 * has to come out the other way on a pointer device, or it is not reading the
 * device at all.
 */
export const SHOTS: readonly Shot[] = [
  { id: 'board-phone', page: 'board', preset: 'phone', waitFor: '.board-nav' },
  { id: 'board-ipad', page: 'board', preset: 'ipad', waitFor: '.board-nav' },
  { id: 'doc-phone', page: 'doc', preset: 'phone', waitFor: '#main' },
  { id: 'doc-ipad', page: 'doc', preset: 'ipad', waitFor: '#main' },
];

/* ===== Checks ===== */

export interface Check {
  id: string;
  /** Which shot's reading it judges. */
  shot: string;
  /** One line, in the report, saying what holding means. */
  says: string;
  /** Null passes; a string is the failure, and is the whole error message. */
  run: (r: ProbeReading) => string | null;
}

/** Sub-pixel slack. Layout lands on fractions; a regression does not. */
const EPSILON = 1;

/**
 * A tap on a bottom tab must reach that tab.
 *
 * The widget's launcher is a fixed 48px bubble in the bottom-right corner at
 * the maximum z-index, and at ≤900px the board nav is a fixed bottom bar on
 * the same edge. At 430px the bubble sat over the centre of the rightmost tab
 * and swallowed it. board.css reserves the bubble's column; this is the
 * hit-test that says the reservation is wide enough — the per-PR test can only
 * check that the arithmetic in the stylesheet still adds up.
 */
function navClearsWidget(r: ProbeReading): string | null {
  // Control first. An empty list would pass every assertion below it.
  if (r.navItems.length < 3) {
    return `only ${r.navItems.length} visible .board-nav-item — the probe lost its subject, so this check proved nothing`;
  }
  const covered = r.navItems.filter((n) => !n.hitsSelf);
  if (covered.length === 0) return null;
  return covered
    .map(
      (n) => `tab "${n.label}" (right edge ${n.right}px) hit-tests to <${n.hitTag}>, not to itself`,
    )
    .join('; ');
}

/**
 * Nothing may push the page wider than its viewport.
 *
 * Measured against `documentElement.clientWidth`, NOT `window.innerWidth`.
 * Under touch emulation the visual viewport GROWS to whatever the content
 * needs — a 900px-wide body at a 430px device reports `innerWidth` 900 — so
 * the one comparison that looks obvious is the one that can never fail. The
 * layout viewport stays at the device width, and that is the number a reader's
 * screen actually is.
 */
function noHorizontalOverflow(r: ProbeReading): string | null {
  if (r.scrollWidth > r.clientWidth + EPSILON) {
    return `content is ${r.scrollWidth}px wide in a ${r.clientWidth}px viewport — ${
      Math.round((r.scrollWidth - r.clientWidth) * 100) / 100
    }px of it is off the side`;
  }
  return null;
}

/**
 * `#main` reaches the bottom of `#shell`.
 *
 * `#shell` is a three-row grid and the meeting strip is `display: none` on
 * every doc that is not a meeting — and a `display: none` element is not a
 * grid item at all, so under auto-placement `#main` took the strip's track and
 * the last track went empty, leaving a dead band at the bottom of the window
 * that hit-tested to `#shell` rather than to the editor. It measured 40px at
 * 1180x820 and 105px at 430px wide. Explicit `grid-row` on the three in-flow
 * children is the fix; this is the only check in the repo that can see the
 * GEOMETRY rather than the declarations.
 */
function shellMainReachesBottom(r: ProbeReading): string | null {
  if (!r.shell) return '#shell is not on this page — the probe lost its subject';
  if (r.shell.mainBottom === null) return '#main is not on this page — the probe lost its subject';
  const gap = r.shell.bottom - r.shell.mainBottom;
  if (gap > EPSILON) {
    return (
      `#main ends ${Math.round(gap * 100) / 100}px above the bottom of #shell — ` +
      `a dead band that hit-tests to the shell. Tracks: ${r.shell.tracks}; ` +
      `in-flow children: ${r.shell.inFlow.map((c) => `${c.id}@row ${c.gridRow}`).join(', ')}`
    );
  }
  return null;
}

/**
 * Hover treatments stay inside `@media (hover: hover)`, and that guard
 * resolves the way the device demands.
 *
 * On touch there is no hover state to leave: the accent border a `:hover` rule
 * paints sticks to the last-tapped option, and on a decision option a stuck
 * accent border reads as a recorded choice. The per-PR test reads the
 * stylesheet as text because a layout-free runner cannot evaluate a media
 * query; here the query is evaluated by the device it is about.
 *
 * `expectMatch` is what makes this two checks rather than one: the same rules
 * must be INERT on the emulated phone and LIVE on the iPad. A guard that
 * matched everywhere, or nowhere, fails one side or the other.
 */
function hoverGuardsResolve(expectMatch: boolean) {
  return (r: ProbeReading): string | null => {
    if (r.hoverSupported !== expectMatch) {
      return `this viewport reports (hover: hover) = ${r.hoverSupported}, expected ${expectMatch} — the emulation is not what this check assumes`;
    }
    const problems: string[] = [];
    for (const rule of r.hoverRules) {
      if (rule.unreadableSheets > 0) {
        problems.push(
          `${rule.unreadableSheets} stylesheet(s) could not be read, so "${rule.selector} is guarded" was never actually checked`,
        );
        continue;
      }
      // Control: the rule is still spelled this way at all. A renamed selector
      // must fail loudly rather than pass with an empty result set.
      if (rule.found === 0) {
        problems.push(`no rule matching ${rule.selector} is in the page's stylesheets`);
        continue;
      }
      const unguarded = rule.sites.filter((s) => !s.guarded).length;
      if (unguarded > 0) {
        problems.push(`${unguarded} copy of ${rule.selector} sits outside @media (hover: hover)`);
      }
      const wrongWay = rule.sites.filter((s) => s.guarded && s.matchesHere !== expectMatch).length;
      if (wrongWay > 0) {
        problems.push(
          `${wrongWay} guarded copy of ${rule.selector} resolves to ${!expectMatch} here, expected ${expectMatch}`,
        );
      }
    }
    return problems.length ? problems.join('; ') : null;
  };
}

export const CHECKS: readonly Check[] = [
  {
    id: 'nav-clears-widget',
    shot: 'board-phone',
    says: 'every bottom tab hit-tests to itself with the feedback bubble on the page',
    run: navClearsWidget,
  },
  {
    id: 'shell-main-reaches-bottom-phone',
    shot: 'doc-phone',
    says: '#main reaches the bottom of #shell at 430px',
    run: shellMainReachesBottom,
  },
  {
    id: 'shell-main-reaches-bottom-ipad',
    shot: 'doc-ipad',
    says: '#main reaches the bottom of #shell at 1180x820',
    run: shellMainReachesBottom,
  },
  {
    id: 'hover-guards-inert-on-touch',
    shot: 'board-phone',
    says: 'decision-option hover rules are inert on an emulated phone',
    run: hoverGuardsResolve(false),
  },
  {
    id: 'hover-guards-live-on-pointer',
    shot: 'board-ipad',
    says: 'the same rules are live on a pointer device',
    run: hoverGuardsResolve(true),
  },
  ...SHOTS.map((s) => ({
    id: `no-horizontal-overflow-${s.id}`,
    shot: s.id,
    says: `${s.id} does not scroll sideways`,
    run: noHorizontalOverflow,
  })),
];

/* ===== Verdicts ===== */

export interface CheckVerdict {
  id: string;
  shot: string;
  says: string;
  ok: boolean;
  detail: string | null;
}

/**
 * Judge every check against the readings collected for its shot.
 *
 * A shot with NO reading is a failure of every check that depends on it, not a
 * skip — a browser that never rendered is the loudest regression there is, and
 * the one most likely to be read as "nothing to report".
 */
export function judge(readings: ReadonlyMap<string, ProbeReading | Error>): CheckVerdict[] {
  return CHECKS.map((check) => {
    const reading = readings.get(check.shot);
    if (reading === undefined) {
      return { ...check, ok: false, detail: `shot "${check.shot}" was never taken` };
    }
    if (reading instanceof Error) {
      return { ...check, ok: false, detail: `shot "${check.shot}" failed: ${reading.message}` };
    }
    const detail = check.run(reading);
    return { id: check.id, shot: check.shot, says: check.says, ok: detail === null, detail };
  });
}

/** The run's report, as it appears in the workflow log. */
export function formatReport(verdicts: readonly CheckVerdict[]): string {
  const width = Math.max(...verdicts.map((v) => v.id.length), 5);
  const lines = verdicts.map(
    (v) => `  ${v.ok ? 'PASS' : 'FAIL'}  ${v.id.padEnd(width)}  ${v.says}`,
  );
  const failed = verdicts.filter((v) => !v.ok);
  const out = ['Nightly UI checks', ...lines];
  if (failed.length) {
    out.push('', `${failed.length} of ${verdicts.length} checks failed:`);
    for (const v of failed) out.push(`  ${v.id}: ${v.detail}`);
  } else {
    out.push('', `All ${verdicts.length} checks passed.`);
  }
  return out.join('\n');
}

/** 0 when every check held, 1 otherwise. */
export function exitCode(verdicts: readonly CheckVerdict[]): number {
  return verdicts.every((v) => v.ok) ? 0 : 1;
}
