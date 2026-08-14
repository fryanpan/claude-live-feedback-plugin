#!/usr/bin/env python3
"""Non-vacuity test for the pre-push leak gate.

The gate's failure mode is not "it flags the wrong thing" — it is "it sees
nothing and exits 0." That happened here for weeks: the fleet registry path
went stale in a rename, `find_registry()` returned None, zero project names
compiled, and every push passed the project-name check by not running it. The
hand-curated denylist kept the pattern list non-empty, so the one guard that
existed never fired.

A scanner whose only assertion is an absence proves nothing until you have
shown it can see a presence. So every case below plants something the scanner
MUST find, or asserts a specific refusal — and it runs against fixtures via
the SCRUB_REGISTRY / SCRUB_DENYLIST overrides, so it works identically on a
laptop with the real fleet config and on a CI runner with none of it.

Run: python3 scripts/scrub-selftest.py    (exit 0 = gate is alive)
"""

from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRUB = os.path.join(HERE, "scrub-check.py")

# Invented names. `zephyr-*` is not a real project and never will be; the
# hyphen matters because the scanner drops short unhyphenated names as too
# generic to match safely.
PRIVATE_PROJECT = "zephyr-private-proj"
PUBLIC_PROJECT = "zephyr-public-proj"
MENTIONABLE_PROJECT = "zephyr-cleared-proj"
# Lives only in a repo-local registry.yaml, never in the fixture registry — so
# a hit on it proves the repo-local file was read, and a miss proves it wasn't.
DECOY_PROJECT = "zephyr-decoy-proj"
DENY_TOKEN = "quokkaburra"

REGISTRY = f"""\
projects:
  {PRIVATE_PROJECT}:
    path: ~/dev/{PRIVATE_PROJECT}
  {PUBLIC_PROJECT}:
    path: ~/dev/{PUBLIC_PROJECT}
    public: true
  {MENTIONABLE_PROJECT}:
    path: ~/dev/{MENTIONABLE_PROJECT}
    mentionable: true
"""

DENYLIST = f"# fixture denylist\n{DENY_TOKEN}\n"

failures: list[str] = []


def run(paths: list[str], registry: str | None, denylist: str | None, cwd: str | None = None, **env_extra):
    env = dict(os.environ)
    env.pop("SCRUB_SKIP", None)
    env.pop("SCRUB_REQUIRE_SOURCES", None)
    # Always set both, so the real machine config can never leak into a case.
    env["SCRUB_REGISTRY"] = registry if registry else os.path.join(tempfile.gettempdir(), "scrub-selftest-absent-registry.yaml")
    env["SCRUB_DENYLIST"] = denylist if denylist else os.path.join(tempfile.gettempdir(), "scrub-selftest-absent-denylist.txt")
    env.update(env_extra)
    return subprocess.run(
        [sys.executable, SCRUB, *paths], capture_output=True, text=True, env=env, cwd=cwd
    )


def clean_git_env() -> dict[str, str]:
    """The environment minus every variable that redirects git at a repo.

    This suite runs from `.githooks/pre-push`, where git has exported GIT_DIR
    (and friends) pointing at the repo being pushed. Inheriting that, a
    `git init` in a temp directory does not initialize the temp directory —
    it re-initializes the repo GIT_DIR names, and when GIT_DIR is a linked
    worktree's gitdir it writes `core.bare = true` into the SHARED config,
    i.e. the primary checkout's. That checkout then refuses `git status`,
    `git pull`, and every worktree command with "this operation must be run
    in a work tree".

    It cost weeks of intermittent breakage that looked like a Claude Code
    worktree bug, because it only ever happened on a push and the config
    change carried no author. Strip the variables instead of guessing which
    ones matter: the list git exports to hooks is not a contract.
    """
    env = dict(os.environ)
    for key in list(env):
        if key.startswith("GIT_"):
            del env[key]
    return env


def make_repo_with_registry(path: str, project: str) -> None:
    """A git repo carrying its own registry.yaml at the root.

    This shape is the whole reason two resolver bugs shipped invisibly: the
    repo they were written in has no root registry.yaml, so `find_registry`'s
    local-file branch never fired, and every case below passed. In a repo that
    HAS one, the branch fires first and the override loses. A fixture that
    only ever exercises one of the two shapes cannot see the difference.
    """
    os.makedirs(path, exist_ok=True)
    subprocess.run(["git", "init", "-q"], cwd=path, check=True,
                   capture_output=True, env=clean_git_env())
    with open(os.path.join(path, "registry.yaml"), "w") as f:
        f.write(f"projects:\n  {project}:\n    path: ~/dev/{project}\n")


def check_git_env_isolation() -> None:
    """`git init` in a fixture must not reach the repo being pushed.

    This suite runs from `.githooks/pre-push`, and git exports GIT_DIR (plus
    friends) into every hook subprocess. A `git init` that inherits that
    environment does NOT initialize the directory you passed as cwd — it
    re-initializes the repo GIT_DIR names, and because the cwd isn't that
    repo's worktree it records `core.bare = true`. The real checkout then
    refuses `git status`, `git pull`, and every worktree command with "this
    operation must be run in a work tree", which is how a self-test blew up
    the repo it was defending, once per push, for weeks.

    The shape matters, and getting it wrong makes this test vacuous: GIT_DIR
    naming a plain repo's `.git` is harmless — `git init` just reinitializes
    it and leaves core.bare alone. It is GIT_DIR naming a LINKED WORKTREE's
    gitdir that writes `core.bare = true`, into the shared config, i.e. the
    primary checkout's. Every agent in this repo pushes from a worktree, so
    that is the shape that actually happens.

    The victim is a throwaway repo, not the real one — but it stands in the
    same relation, so this catches the bug without breaking anything.
    """
    with tempfile.TemporaryDirectory() as tmp:
        victim = os.path.join(tmp, "victim")
        os.makedirs(victim)
        # This suite's OWN setup has to be isolated too — run from the hook,
        # an inherited GIT_DIR would build the fixture inside the real repo.
        clean = clean_git_env()
        subprocess.run(["git", "init", "-q"], cwd=victim, check=True,
                       capture_output=True, env=clean)
        subprocess.run(["git", "commit", "-q", "--allow-empty", "-m", "seed"],
                       cwd=victim, check=True, capture_output=True, env=clean)
        worktree = os.path.join(tmp, "victim-wt")
        subprocess.run(["git", "worktree", "add", "-q", worktree, "-b", "probe"],
                       cwd=victim, check=True, capture_output=True, env=clean)
        # What git exports to a hook run from that worktree. Ask git rather
        # than building the path: the gitdir is named after the worktree
        # DIRECTORY, not the branch, and a hand-built path that doesn't exist
        # makes this whole case pass vacuously.
        hook_git_dir = subprocess.run(
            ["git", "rev-parse", "--absolute-git-dir"],
            cwd=worktree, capture_output=True, text=True, check=True, env=clean,
        ).stdout.strip()
        expect("git-env isolation: the worktree gitdir resolves",
               0 if os.path.isdir(hook_git_dir) else 1, 0, hook_git_dir)

        def bare_flag() -> str:
            r = subprocess.run(
                ["git", "config", "--file", os.path.join(victim, ".git", "config"), "core.bare"],
                capture_output=True, text=True,
            )
            return r.stdout.strip()

        # Positive control: the victim is a normal, non-bare repo right now, so
        # "still false" below is a claim about the fixture call rather than
        # about a flag that was never set.
        expect("git-env isolation: victim starts non-bare", 0 if bare_flag() == "false" else 1, 0,
               f"core.bare={bare_flag()!r}")

        prior = dict(os.environ)
        os.environ["GIT_DIR"] = hook_git_dir
        try:
            make_repo_with_registry(os.path.join(tmp, "fixture"), "some-project")
        finally:
            os.environ.clear()
            os.environ.update(prior)

        expect("git-env isolation: fixture init leaves the outer repo alone",
               0 if bare_flag() == "false" else 1, 0,
               f"core.bare={bare_flag()!r} — GIT_DIR leaked into the fixture's git init")


def expect(label: str, got: int, want: int, out: str = "") -> None:
    if got == want:
        print(f"  ok    {label}")
    else:
        print(f"  FAIL  {label}: exit {got}, expected {want}")
        if out.strip():
            print("        " + out.strip().replace("\n", "\n        "))
        failures.append(label)


def check_decision_table() -> None:
    """Every (registry, fleet, denylist, require) combination, at the seam.

    The env-level cases below cannot reach all of these: an authoritative
    override suppresses the repo-local registry lookup, so "no machine config,
    but this repo carries its own registry.yaml" is unreachable from outside —
    and that is precisely the row where the stranger-clone escape hatch was
    dead code. A branch only reachable in the field is untested by
    construction, so it gets tested here instead.
    """
    spec = importlib.util.spec_from_file_location("scrub_check", SCRUB)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    R, F, D = "/reg.yaml", "/fleet.yaml", "/deny.txt"
    cases = [
        # (registry, fleet_registry, denylist, require) -> verdict
        ((R, F, D, False), "scan",   "fully configured machine"),
        ((None, None, D, False), "refuse", "denylist present, no registry at all"),
        ((R, F, None, False), "refuse", "registry present, denylist missing"),
        ((None, None, None, False), "skip", "nothing anywhere: a stranger's clone"),
        ((None, None, None, True), "refuse", "...unless SCRUB_REQUIRE_SOURCES"),
        # The row env overrides can't produce, and the one that was broken:
        ((R, None, None, False), "scan", "repo-local registry only, no fleet config"),
        ((R, None, None, True), "refuse", "...still refused under REQUIRE_SOURCES"),
        ((R, None, D, False), "scan", "repo-local registry + machine denylist"),
    ]
    for (registry, fleet, denylist, require), want, label in cases:
        got = mod.decide_sources(
            registry=registry, fleet_registry=fleet,
            denylist=denylist, require_sources=require,
        ).verdict
        expect(f"decide_sources: {label}", 0 if got == want else 1, 0,
               f"got {got!r}, wanted {want!r}")


def main() -> int:
    check_git_env_isolation()
    check_decision_table()
    with tempfile.TemporaryDirectory() as tmp:
        registry = os.path.join(tmp, "registry.yaml")
        denylist = os.path.join(tmp, "denylist.txt")
        absent = os.path.join(tmp, "does-not-exist")
        with open(registry, "w") as f:
            f.write(REGISTRY)
        with open(denylist, "w") as f:
            f.write(DENYLIST)

        def fixture(name: str, body: str) -> str:
            p = os.path.join(tmp, name)
            with open(p, "w") as f:
                f.write(body)
            return p

        leaky = fixture("leaky.md", f"We reuse the approach from {PRIVATE_PROJECT} here.\n")
        public_ref = fixture("public.md", f"Built on {PUBLIC_PROJECT}, which is public.\n")
        mentionable_ref = fixture("cleared.md", f"A post about {MENTIONABLE_PROJECT}, cleared to name.\n")
        denied = fixture("denied.md", f"An aside mentioning {DENY_TOKEN} in passing.\n")
        clean = fixture("clean.md", "Nothing sensitive here at all.\n")
        allowed = fixture("allowed.md", f"{PRIVATE_PROJECT} <!-- scrub-allow: documenting the gate -->\n")

        print("scrub gate self-test")

        # The positive control. If this ever passes-as-clean, the gate is blind
        # and every other result in this file is worthless.
        r = run([leaky], registry, denylist)
        expect("catches a private registry project name", r.returncode, 1, r.stderr)

        r = run([denied], registry, denylist)
        expect("catches a denylist pattern", r.returncode, 1, r.stderr)

        # public: true must suppress. Without this the gate fires on nearly
        # every push and trains people into SCRUB_SKIP=1.
        r = run([public_ref], registry, denylist)
        expect("ignores a project marked public: true", r.returncode, 0, r.stderr)

        # mentionable: true means "cleared to say out loud, repo still private".
        # It must suppress exactly like public does — the gate only ever asks
        # whether a name is safe to say — without anyone having to assert a
        # private repo is public to get that answer.
        r = run([mentionable_ref], registry, denylist)
        expect("ignores a project marked mentionable: true", r.returncode, 0, r.stderr)

        r = run([clean], registry, denylist)
        expect("passes a clean file", r.returncode, 0, r.stderr)

        r = run([allowed], registry, denylist)
        expect("honors an inline scrub-allow", r.returncode, 0, r.stderr)

        # The exact shape of the production bug: one source resolves, the
        # other silently doesn't. Must refuse rather than scan with half its
        # patterns and report success.
        r = run([clean], registry, absent)
        expect("refuses when the denylist is missing", r.returncode, 2, r.stderr)

        r = run([clean], absent, denylist)
        expect("refuses when the registry is missing", r.returncode, 2, r.stderr)

        # A stranger cloning the public repo has no fleet config to be
        # missing — get out of their way, unless asked not to.
        r = run([clean], absent, absent)
        expect("skips cleanly when no source exists at all", r.returncode, 0, r.stderr)

        r = run([clean], absent, absent, SCRUB_REQUIRE_SOURCES="1")
        expect("SCRUB_REQUIRE_SOURCES makes that case hard", r.returncode, 2, r.stderr)

        # The third costume of the same bug: this tool does not read stdin, so
        # piping a diff at it scanned nothing and exited 0. A clean result that
        # established nothing is worse than an error.
        r = run([], registry, denylist)
        expect("refuses when given no files (does not read stdin)", r.returncode, 2, r.stderr)

        # --- Cases below run from INSIDE a repo that carries its own
        # registry.yaml. Everything above passes in both shapes; these two only
        # fail in this one, which is why they exist.
        local_repo = os.path.join(tmp, "repo-with-registry")
        make_repo_with_registry(local_repo, DECOY_PROJECT)
        decoy_ref = fixture("decoy.md", f"Mentions {DECOY_PROJECT}, which only the repo-local registry protects.\n")

        # Two-sided, and it has to be: an override that loses to the repo-local
        # file makes every case above scan the wrong registry while still
        # reporting exactly what the test expects to see.
        r = run([leaky], registry, denylist, cwd=local_repo)
        expect("SCRUB_REGISTRY beats a repo-local registry.yaml", r.returncode, 1, r.stderr)

        r = run([decoy_ref], registry, denylist, cwd=local_repo)
        expect("...and the repo-local registry is then not consulted", r.returncode, 0, r.stderr)

        # The stranger-clone escape hatch, in the shape where it was dead code:
        # with a repo-local registry present, `resolved` could never reach 0, so
        # a clone with no fleet config had every push blocked by a message about
        # paths that were never theirs.
        r = run([clean], absent, absent, cwd=local_repo)
        expect("a clone with no fleet config still pushes (local registry present)", r.returncode, 0, r.stderr)

    if failures:
        print(f"\n{len(failures)} self-test failure(s): {', '.join(failures)}")
        print("The leak gate is not doing what it claims. Do not trust a clean push.")
        return 1
    print("\nall good — the gate can see.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
