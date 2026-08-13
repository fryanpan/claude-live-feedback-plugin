#!/usr/bin/env python3
"""Pre-push leak scanner. Used by `.githooks/pre-push`.

Scans content for project-name / PII leaks BEFORE it leaves the local machine.
The principle: once a push lands on GitHub and a PR is opened against it, the
content is public-record forever (PR descriptions and commits can't be removed).
This gate fires at push time so a leak can be caught and fixed before that.

Two sources of patterns:
1. **Registry**: top-level keys under `projects:` in the repo's own
   `registry.yaml`, else the fleet registry (see REGISTRY_CANDIDATES). When a
   new project is added to the registry, its name is automatically protected.
2. **Denylist**: hand-curated patterns (see DENYLIST_CANDIDATES). One pattern
   per line. Plain strings match literally (case-insensitive). Prefix with `/`
   for a regex. Lines starting with `#` are comments.

`SCRUB_REGISTRY` / `SCRUB_DENYLIST` point either source elsewhere. They are
AUTHORITATIVE: they replace the whole search for that source, including the
repo-local registry.yaml. A source that was expected and did not resolve is a
hard failure (exit 2) — see `decide_sources` for what "expected" means.

Usage:
  scrub-check.py file [file...]            # scan named files
  scrub-check.py --diff-range A..B          # scan files changed in range
  scrub-check.py --staged                   # scan files in git index
  scrub-check.py --scan-all-tracked         # scan every tracked file (audit)

This tool does NOT read stdin; piping a diff at it is an error, not a scan.

Exit codes: 0 = clean, 1 = leaks found, 2 = setup error.

Bypass entirely with `SCRUB_SKIP=1` (logged; use sparingly).
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from typing import Dict, List, NamedTuple, Optional, Set, Tuple

# Both pattern sources are CANDIDATE LISTS, current location first.
#
# These paths move. The fleet repo was renamed once already, and the constant
# pointing at the old path did not fail loudly — `find_registry()` simply
# returned None, zero project names compiled, and every push passed the
# project-name check by not running it. Nothing surfaced it, because the only
# guard fired when the pattern list was COMPLETELY empty and the hand-curated
# denylist kept it non-empty. A scanner that can't see anything must say so;
# silently scanning nothing and exiting 0 is the worst behavior available.
#
# An env override is AUTHORITATIVE — it replaces the candidate list rather
# than heading it. Falling back from an explicit override to a machine path
# would let the self-test silently pass against the real fleet config, which
# is the same "I scanned something, just not what you think" failure this
# whole change exists to remove.
REGISTRY_OVERRIDE = os.environ.get("SCRUB_REGISTRY")
DENYLIST_OVERRIDE = os.environ.get("SCRUB_DENYLIST")

REGISTRY_CANDIDATES = (
    [REGISTRY_OVERRIDE]
    if REGISTRY_OVERRIDE
    else [
        os.path.expanduser("~/dev/ai-team-lead/registry.yaml"),
        os.path.expanduser("~/dev/ai-project-support/registry.yaml"),
    ]
)
DENYLIST_CANDIDATES = (
    [DENYLIST_OVERRIDE]
    if DENYLIST_OVERRIDE
    else [
        os.path.expanduser("~/.config/team-lead/scrub-denylist.txt"),
        os.path.expanduser("~/.config/conductor/scrub-denylist.txt"),
    ]
)

# What each source tried, for the message when it comes up empty. NOT a
# decision input: a source can fail to resolve and be irrelevant (the fleet
# registry, in a repo that carries its own registry.yaml). Deciding off
# "something warned" conflates "missing" with "not needed".
_TRIED: Dict[str, List[str]] = {}

# One spelling of "not found", everywhere: None. The first version of this
# resolver had two — `None` from `_resolve_source` and "a path that doesn't
# exist" from the old constants — and the two guards downstream each picked a
# different one, which is how the stranger-clone escape hatch became
# unreachable while looking correct.


def _resolve_source(label: str, candidates: List[Optional[str]]) -> Optional[str]:
    """First candidate that exists on disk, else None."""
    for path in candidates:
        if path and os.path.isfile(path):
            return path
    _TRIED[label] = [p for p in candidates if p]
    return None


FLEET_REGISTRY = _resolve_source("registry", REGISTRY_CANDIDATES)
DENYLIST_PATH = _resolve_source("denylist", DENYLIST_CANDIDATES)

# Text file extensions we scan. Everything else is skipped (binaries, lockfiles).
SCAN_EXTS = {
    ".md", ".py", ".sh", ".bash", ".zsh", ".yml", ".yaml", ".json", ".jsonc",
    ".js", ".ts", ".jsx", ".tsx", ".html", ".css", ".scss", ".txt", ".rst",
    ".toml", ".env", ".envrc",
}

# Specific paths to never scan. The scanner's own files (scrub-check.py,
# scrub-haiku.py) must be skipped because they intentionally mention denylist
# keywords as examples of what to flag — scanning them would block their own
# propagation. Likewise the gitignored docs.
SKIP_PATHS = {
    "docs/process/aggregation-log.md",
    "registry.yaml",
    "scripts/scrub-check.py",
    "scripts/scrub-haiku.py",
}


def repo_root() -> Optional[str]:
    try:
        return subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


def main_repo_name() -> Optional[str]:
    """Name of the main repo, correct even from inside a linked worktree.

    `--git-common-dir` points at the main repo's `.git` regardless of which
    worktree we're in, so its parent directory is the real repo name.
    """
    try:
        common = subprocess.run(
            ["git", "rev-parse", "--git-common-dir"],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None
    if not common:
        return None
    git_dir = os.path.abspath(common)
    if os.path.basename(git_dir) == ".git":
        return os.path.basename(os.path.dirname(git_dir))
    # Bare repos: /path/to/repo.git -> repo
    return os.path.basename(git_dir).removesuffix(".git") or None


def find_registry() -> Optional[str]:
    """The registry to scan against: override, else repo-local, else fleet.

    The override comes FIRST, ahead of the repo-local `registry.yaml`.
    Otherwise `SCRUB_REGISTRY` means "authoritative except in repos that carry
    their own registry" — and those are exactly the repos where it matters.
    A self-test that points at a fixture would silently read the real fleet
    registry, find none of its planted names, and report clean: a positive
    control scanning the wrong data, which is the failure the authoritative
    override exists to prevent.
    """
    if REGISTRY_OVERRIDE:
        return FLEET_REGISTRY  # already existence-checked by _resolve_source
    root = repo_root()
    if root:
        local = os.path.join(root, "registry.yaml")
        if os.path.isfile(local):
            return local
    return FLEET_REGISTRY


class SourceDecision(NamedTuple):
    verdict: str          # "scan" | "skip" | "refuse"
    missing: List[str]
    strict: bool          # is this machine expected to be configured?


def decide_sources(
    registry: Optional[str],
    fleet_registry: Optional[str],
    denylist: Optional[str],
    require_sources: bool,
) -> SourceDecision:
    """Whether we have enough to scan, told apart from whether we should refuse.

    Pure, so the table test can reach every combination — including the ones no
    env override can produce, because an authoritative override suppresses the
    repo-local registry lookup by design. That gap is exactly where the second
    resolver bug lived: a machine with no fleet config, in a repo that tracks
    its own `registry.yaml`, had every push refused with a message about paths
    that were never its owner's. Any branch reachable only in the field needs a
    seam like this one, or it is untested by construction.

    `strict` — "this machine is expected to be configured" — is inferred from
    the MACHINE-level sources only. A repo-local registry.yaml deliberately does
    not count: it arrives with the clone, so counting it would read every
    stranger as a fleet machine with a broken install.
    """
    missing = []
    if registry is None:
        missing.append("registry")
    if denylist is None:
        missing.append("denylist")

    strict = fleet_registry is not None or denylist is not None or require_sources

    if not missing:
        return SourceDecision("scan", missing, strict)
    if strict:
        return SourceDecision("refuse", missing, strict)
    if registry is None:
        # Nothing at all, and nothing was expected: a stranger's clone.
        return SourceDecision("skip", missing, strict)
    # A repo-local registry and nothing else: fewer patterns than a fleet
    # machine has, but real ones. Scan with what we've got.
    return SourceDecision("scan", missing, strict)


def load_project_names(registry_path: Optional[str]) -> Set[str]:
    """Top-level project keys under `projects:` in registry.yaml.

    Skips names that would cause heavy false-positive load:
      - Names without a hyphen AND under 6 chars (e.g. `tasks`, `crm`) — collide
        with common English words. The operator can still flag them precisely via the
        hand-curated denylist if he wants stricter matching.
      - The current repo's own name (a repo legitimately self-references in its
        README, CLAUDE.md, plugin metadata, etc).
    """
    names: Set[str] = set()
    cleared: Set[str] = set()
    if not registry_path:
        return names
    in_projects = False
    current: Optional[str] = None
    with open(registry_path) as f:
        for line in f:
            if re.match(r"^projects:\s*$", line):
                in_projects = True
                continue
            if not in_projects:
                continue
            m = re.match(r"^  ([a-zA-Z][a-zA-Z0-9_-]*):\s*$", line)
            if m:
                current = m.group(1)
                names.add(current)
                continue
            if current and re.match(r"^    (public|mentionable):\s*true\b", line):
                cleared.add(current)
                continue
            # Hit a non-indented line that isn't blank/comment — projects block ended.
            if line and not line[0].isspace() and not line.lstrip().startswith("#"):
                break

    # Drop names that are too generic to safely match by themselves.
    names = {n for n in names if "-" in n or len(n) >= 6}

    # Drop projects the registry has cleared, under either of two keys. They
    # mean different things and the difference is load-bearing:
    #
    #   public: true       — the GitHub repo is public TODAY. A fact other
    #                        tooling relies on; it has to stay literally true.
    #   mentionable: true  — the operator has cleared the name for public
    #                        mention while the repo is still private (a flip is
    #                        planned, or the name is going in a blog post first).
    #
    # The gate only ever asks "is this name safe to say", so both drop out. The
    # split exists so answering that question never requires asserting a repo is
    # public when it isn't. Not dropping them is its own failure: the fleet's
    # public tooling gets referenced in docs and learnings constantly, and a gate
    # that fires on nearly every push trains people into SCRUB_SKIP=1.
    names -= cleared

    # Drop the current repo's own name — a repo's own README / CLAUDE.md / plugin
    # metadata legitimately mentions itself; we don't want to flag self-references.
    #
    # Use the MAIN repo's name, not the working tree's. In a linked worktree
    # (`.claude/worktrees/<branch>`), `--show-toplevel` is the worktree path, so
    # basename() is the branch's directory name and the real repo name never gets
    # discarded — every self-reference then trips the gate. Most fleet work
    # happens in worktrees, so that lands as constant false positives.
    self_name = main_repo_name()
    if self_name:
        names.discard(self_name)

    return names


def load_denylist() -> List[Tuple[str, bool]]:
    """Return (pattern, is_regex) tuples. Missing file => empty list."""
    out: List[Tuple[str, bool]] = []
    if not DENYLIST_PATH:
        return out
    with open(DENYLIST_PATH) as f:
        for raw in f:
            s = raw.strip()
            if not s or s.startswith("#"):
                continue
            if s.startswith("/"):
                out.append((s[1:], True))
            else:
                out.append((s, False))
    return out


def build_patterns(names: Set[str], denylist: List[Tuple[str, bool]]) -> List[Tuple[str, re.Pattern]]:
    """Compile all match patterns. Names use a hyphen-aware word boundary."""
    patterns: List[Tuple[str, re.Pattern]] = []
    for name in sorted(names):
        # (?<![\w-]) and (?![\w-]) keep e.g. `some-proj` from matching inside `super-some-proj-foo`.
        rx = re.compile(r"(?<![\w-])" + re.escape(name) + r"(?![\w-])", re.IGNORECASE)
        patterns.append((f"registry-project: {name}", rx))
    for raw, is_regex in denylist:
        try:
            body = raw if is_regex else re.escape(raw)
            patterns.append((f"denylist: {raw}", re.compile(body, re.IGNORECASE)))
        except re.error as e:
            print(f"[scrub-check] bad regex in denylist: {raw!r} ({e})", file=sys.stderr)
    return patterns


def should_scan(path: str) -> bool:
    if path in SKIP_PATHS:
        return False
    base = os.path.basename(path)
    # Allow extensionless files only if their name suggests text (e.g., .githooks/pre-push)
    ext = os.path.splitext(base)[1].lower()
    if ext in SCAN_EXTS:
        return True
    # Files with no extension that live in .githooks/ or scripts/ are typically text
    if not ext and ("/.githooks/" in "/" + path + "/" or path.startswith("scripts/")):
        return True
    return False


def scan_file(path: str, patterns: List[Tuple[str, re.Pattern]]) -> List[Tuple[int, str, str]]:
    """Return [(line_no, label, line_text)] of matches."""
    findings: List[Tuple[int, str, str]] = []
    try:
        with open(path, "rb") as f:
            data = f.read()
        text = data.decode("utf-8", errors="replace")
    except (OSError, IOError):
        return findings
    for line_no, line in enumerate(text.split("\n"), 1):
        # Skip lines that are intentional examples documenting the gate itself.
        if "scrub-allow" in line:
            continue
        for label, rx in patterns:
            if rx.search(line):
                findings.append((line_no, label, line))
                break  # one finding per line is enough
    return findings


def files_in_range(range_spec: str) -> List[str]:
    try:
        out = subprocess.run(
            ["git", "diff", "--name-only", range_spec],
            capture_output=True, text=True, check=True,
        ).stdout
        return [f for f in out.strip().split("\n") if f]
    except subprocess.CalledProcessError:
        return []


def files_staged() -> List[str]:
    try:
        out = subprocess.run(
            ["git", "diff", "--cached", "--name-only"],
            capture_output=True, text=True, check=True,
        ).stdout
        return [f for f in out.strip().split("\n") if f]
    except subprocess.CalledProcessError:
        return []


def all_tracked_files() -> List[str]:
    try:
        out = subprocess.run(
            ["git", "ls-files"],
            capture_output=True, text=True, check=True,
        ).stdout
        return [f for f in out.strip().split("\n") if f]
    except subprocess.CalledProcessError:
        return []


def main() -> int:
    if os.environ.get("SCRUB_SKIP") == "1":
        print("[scrub-check] SCRUB_SKIP=1 set — bypassing scan.", file=sys.stderr)
        return 0

    args = sys.argv[1:]

    if "--help" in args or "-h" in args:
        print(__doc__)
        return 0

    if "--diff-range" in args:
        idx = args.index("--diff-range")
        if idx + 1 >= len(args):
            print("[scrub-check] --diff-range needs an argument", file=sys.stderr)
            return 2
        files = files_in_range(args[idx + 1])
    elif "--staged" in args:
        files = files_staged()
    elif "--scan-all-tracked" in args:
        files = all_tracked_files()
    else:
        files = args
        if not args:
            # This tool does NOT read stdin. Piping a diff into it used to scan
            # nothing and exit 0 — a clean-looking pass that established
            # nothing, which is the same bug as a stale source path in a third
            # costume. Silence is what let all of these run for weeks.
            print(
                "[scrub-check] no files given, and this tool does not read stdin.\n"
                "  Pass file paths, or --diff-range A..B / --staged / --scan-all-tracked.",
                file=sys.stderr,
            )
            return 2

    # Filter: keep only files we'd scan and that exist on disk.
    files = [f for f in files if should_scan(f) and os.path.isfile(f)]

    if not files:
        return 0

    registry = find_registry()
    decision = decide_sources(
        registry=registry,
        fleet_registry=FLEET_REGISTRY,
        denylist=DENYLIST_PATH,
        require_sources=os.environ.get("SCRUB_REQUIRE_SOURCES") == "1",
    )

    if decision.verdict == "refuse":
        print("[scrub-check] pattern source missing — refusing to pass:", file=sys.stderr)
        for label in decision.missing:
            tried = ", ".join(_TRIED.get(label, [])) or "(nothing configured)"
            print(f"  no {label} found — tried: {tried}", file=sys.stderr)
        print(
            "\n[scrub-check] Another source resolved, so this machine is expected to have\n"
            "  them all. A half-configured gate scans with half its patterns and still\n"
            "  exits 0, which is how this went unnoticed for weeks. Fix the path or\n"
            "  restore the file. Override for one push with SCRUB_SKIP=1.",
            file=sys.stderr,
        )
        return 2

    if decision.verdict == "skip":
        print(
            "[scrub-check] no pattern sources on this machine — nothing to scan against.",
            file=sys.stderr,
        )
        return 0

    project_names = load_project_names(registry)
    denylist = load_denylist()
    patterns = build_patterns(project_names, denylist)

    if not patterns:
        if not decision.strict:
            return 0
        print(
            "[scrub-check] sources resolved but compiled zero patterns — refusing to pass.",
            file=sys.stderr,
        )
        return 2

    total = 0
    files_with_findings = set()
    for f in files:
        for line_no, label, line in scan_file(f, patterns):
            if total == 0:
                print(f"[scrub-check] leaks detected:", file=sys.stderr)
            files_with_findings.add(f)
            snippet = line.strip()
            if len(snippet) > 100:
                snippet = snippet[:97] + "..."
            print(f"  {f}:{line_no}  ({label})", file=sys.stderr)
            print(f"    > {snippet}", file=sys.stderr)
            total += 1

    if total:
        print(
            f"\n[scrub-check] {total} leak(s) across {len(files_with_findings)} file(s). Push blocked.",
            file=sys.stderr,
        )
        print(
            "[scrub-check] Fix: replace with a generic placeholder, anonymize, or move content to a gitignored path.",
            file=sys.stderr,
        )
        print(
            "[scrub-check] Override (sparingly): SCRUB_SKIP=1 git push ...",
            file=sys.stderr,
        )
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
