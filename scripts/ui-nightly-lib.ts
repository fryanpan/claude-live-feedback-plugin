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
  /** `<body>` carries `signin-gated` — the app decided it may not write. */
  signedOut: boolean;
  navItems: NavItemReading[];
  hoverRules: HoverRuleReading[];
  shell: ShellReading | null;
}

/* ===== Shots: which page, in which posture, at which viewport ===== */

export type PageKind = 'board' | 'doc';
export type Preset = 'ipad' | 'phone';

/**
 * Which server the shot renders against.
 *
 * `signed-in` is `CW_REQUIRE_SIGNIN_TO_WRITE=0`. `signed-out` is `=1` with a
 * browser that has proven nobody — what a reader following a shared link gets.
 * They are different LAYOUTS, not one layout with a banner added: the second
 * mounts `.signin-bar` as a fourth in-flow child of `#shell` and re-declares
 * the shell's track list (`body.signin-gated #shell` in styles.css).
 */
export type Posture = 'signed-in' | 'signed-out';

export interface Shot {
  id: string;
  page: PageKind;
  preset: Preset;
  posture: Posture;
  /** Selector `ui:shot --wait-for` polls before measuring. */
  waitFor: string;
}

/**
 * Six renders: the board and a markdown doc at the two viewports
 * docs/product/design-mobile.md names, plus the doc again signed out. The
 * phone shots are where the layout bugs this suite exists for actually
 * appeared; the iPad shots are Bryan's own device and the positive control for
 * the hover checks — the same assertion has to come out the other way on a
 * pointer device, or it is not reading the device at all.
 *
 * WHY THE GATED PAIR EXISTS. This job ran only `CW_REQUIRE_SIGNIN_TO_WRITE=0`,
 * and its own header called the other posture "a different layout that
 * deserves its own checks" — a correct sentence standing in for a check nobody
 * had written. So it went green every night on a page it never rendered, while
 * the signed-out doc shipped the exact dead band `shell-main-reaches-bottom`
 * exists to catch: `#main` ending 3px above the bottom of `#shell` at 1180x820
 * and 55px at 430px, that band hit-testing to the shell. Two more renders is
 * what it costs for this job to be about the app rather than about one of its
 * two postures.
 *
 * The BOARD is deliberately not duplicated. Its bar is an ordinary flow child
 * inserted under `.board-topbar`, with no grid to be placed in, so a second
 * posture would ask it nothing the first already does.
 */
export const SHOTS: readonly Shot[] = [
  {
    id: 'board-phone',
    page: 'board',
    preset: 'phone',
    posture: 'signed-in',
    waitFor: '.board-nav',
  },
  { id: 'board-ipad', page: 'board', preset: 'ipad', posture: 'signed-in', waitFor: '.board-nav' },
  { id: 'doc-phone', page: 'doc', preset: 'phone', posture: 'signed-in', waitFor: '#main' },
  { id: 'doc-ipad', page: 'doc', preset: 'ipad', posture: 'signed-in', waitFor: '#main' },
  {
    id: 'doc-phone-gated',
    page: 'doc',
    preset: 'phone',
    posture: 'signed-out',
    // The bar, not `#main`: `#main` is in the markup either way, so waiting on
    // it would let a shot that never gated proceed and be judged as if it had.
    waitFor: '.signin-bar',
  },
  {
    id: 'doc-ipad-gated',
    page: 'doc',
    preset: 'ipad',
    posture: 'signed-out',
    waitFor: '.signin-bar',
  },
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
 * The page the shot MEANT to render is the page it rendered.
 *
 * The control for every gated check, and the reason the gated shots are worth
 * anything. `CW_REQUIRE_SIGNIN_TO_WRITE=1` is a server setting; whether the
 * browser then decides it cannot write depends on a session lookup that
 * `fetchWriteAccess` deliberately fails OPEN on a timeout, a 404 or junk. So a
 * gated shot can come back as an ordinary signed-in page — and every geometry
 * check below would pass on it, reporting the posture as healthy on evidence
 * from the other one. That is the exact shape of the bug these shots were
 * added for, one level up.
 *
 * Asserted BOTH ways: the signed-in shots must NOT be gated. A build where the
 * bar mounted for everybody would otherwise satisfy the gated side while
 * silently changing the page every reader sees.
 */
function postureRendered(expectSignedOut: boolean) {
  return (r: ProbeReading): string | null => {
    if (r.signedOut !== expectSignedOut) {
      return (
        `<body> ${r.signedOut ? 'carries' : 'does not carry'} \`signin-gated\`, expected ` +
        `${expectSignedOut ? 'it to' : 'it not to'} — this shot measured the other posture, ` +
        'so every other check on it judged the wrong page'
      );
    }
    if (!expectSignedOut) return null;
    if (!r.shell) return '#shell is not on this page — the probe lost its subject';
    const bar = r.shell.inFlow.find((c) => c.id === '.signin-bar');
    if (!bar) {
      return (
        "no `.signin-bar` among #shell's in-flow children — the class is on <body> but the " +
        `bar is not a grid item, so the fourth track has nothing in it. In flow: ${
          r.shell.inFlow.map((c) => `${c.id}@row ${c.gridRow}`).join(', ') || '(none)'
        }`
      );
    }
    if (bar.gridRow === 'auto') {
      return (
        'the sign-in bar is AUTO-PLACED. Every other in-flow child of #shell is pinned by ' +
        '`grid-row`, so the one that is not takes whichever row is free and pushes the ' +
        'flexible track off the end — which is how the dead band came back. It needs ' +
        '`body.signin-gated .signin-bar { grid-row: 2 }` in styles.css'
      );
    }
    return null;
  };
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
 *
 * It runs on the SIGNED-OUT doc too, and had to: that posture adds a fourth
 * in-flow child and a fourth track and shipped the same band again — 3px at
 * 1180x820, 55px at 430px — with nothing rendering the page to notice.
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
    id: 'shell-main-reaches-bottom-gated-phone',
    shot: 'doc-phone-gated',
    says: '#main reaches the bottom of #shell at 430px with the sign-in bar mounted',
    run: shellMainReachesBottom,
  },
  {
    id: 'shell-main-reaches-bottom-gated-ipad',
    shot: 'doc-ipad-gated',
    says: '#main reaches the bottom of #shell at 1180x820 with the sign-in bar mounted',
    run: shellMainReachesBottom,
  },
  // The control pair for the two above, and its own negative on the signed-in
  // side. Without these, a gated shot that quietly rendered the signed-in page
  // would report the gated posture healthy on the wrong page's evidence.
  ...SHOTS.filter((s) => s.page === 'doc').map((s) => ({
    id: `posture-rendered-${s.id}`,
    shot: s.id,
    says:
      s.posture === 'signed-out'
        ? `${s.id} really is the signed-out shell, bar mounted and placed`
        : `${s.id} really is the signed-in shell, with no sign-in bar`,
    run: postureRendered(s.posture === 'signed-out'),
  })),
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
