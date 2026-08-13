#!/usr/bin/env python3
"""Pre-push leak scanner. Used by `.githooks/pre-push`.

Scans content for project-name / PII leaks BEFORE it leaves the local machine.
The principle: once a push lands on GitHub and a PR is opened against it, the
content is public-record forever (PR descriptions and commits can't be removed).
This gate fires at push time so a leak can be caught and fixed before that.

Two sources of patterns:
1. **Registry**: top-level keys under `projects:` in the repo's `registry.yaml`
   (or, if not present, the fleet registry at `~/dev/ai-project-support/registry.yaml`).
   When a new project is added to the registry, its name is automatically protected.
2. **Denylist**: hand-curated patterns at `~/.config/conductor/scrub-denylist.txt`.
   One pattern per line. Plain strings match literally (case-insensitive). Prefix
   with `/` for a regex. Lines starting with `#` are comments.

Usage:
  scrub-check.py file [file...]            # scan named files
  scrub-check.py --diff-range A..B          # scan files changed in range
  scrub-check.py --staged                   # scan files in git index
  scrub-check.py --scan-all-tracked         # scan every tracked file (audit)

Exit codes: 0 = clean, 1 = leaks found, 2 = setup error.

Bypass entirely with `SCRUB_SKIP=1` (logged; use sparingly).
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from typing import List, Optional, Set, Tuple

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
REGISTRY_CANDIDATES = (
    [os.environ["SCRUB_REGISTRY"]]
    if os.environ.get("SCRUB_REGISTRY")
    else [
        os.path.expanduser("~/dev/ai-team-lead/registry.yaml"),
        os.path.expanduser("~/dev/ai-project-support/registry.yaml"),
    ]
)
DENYLIST_CANDIDATES = (
    [os.environ["SCRUB_DENYLIST"]]
    if os.environ.get("SCRUB_DENYLIST")
    else [
        os.path.expanduser("~/.config/team-lead/scrub-denylist.txt"),
        os.path.expanduser("~/.config/conductor/scrub-denylist.txt"),
    ]
)

# Collected at import, printed by main() — resolving at import keeps the
# module-level constants other functions read, but a warning printed on
# `--help` would be noise.
_SOURCE_WARNINGS: List[str] = []


def _resolve_source(label: str, candidates: List[Optional[str]]) -> Optional[str]:
    """First candidate that exists on disk, or None with a warning recorded."""
    for path in candidates:
        if path and os.path.isfile(path):
            return path
    tried = ", ".join(p for p in candidates if p) or "(nothing configured)"
    _SOURCE_WARNINGS.append(f"no {label} found — tried: {tried}")
    return None


FLEET_REGISTRY = _resolve_source("fleet registry", REGISTRY_CANDIDATES)
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
    """Local registry.yaml at repo root, else fleet fallback."""
    root = repo_root()
    if root:
        local = os.path.join(root, "registry.yaml")
        if os.path.isfile(local):
            return local
    # Already existence-checked by _resolve_source.
    return FLEET_REGISTRY


def load_project_names(registry_path: Optional[str]) -> Set[str]:
    """Top-level project keys under `projects:` in registry.yaml.

    Skips names that would cause heavy false-positive load:
      - Names without a hyphen AND under 6 chars (e.g. `tasks`, `crm`) — collide
        with common English words. Bryan can still flag them precisely via the
        hand-curated denylist if he wants stricter matching.
      - The current repo's own name (a repo legitimately self-references in its
        README, CLAUDE.md, plugin metadata, etc).
    """
    names: Set[str] = set()
    public: Set[str] = set()
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
            if current and re.match(r"^    public:\s*true\b", line):
                public.add(current)
                continue
            # Hit a non-indented line that isn't blank/comment — projects block ended.
            if line and not line[0].isspace() and not line.lstrip().startswith("#"):
                break

    # Drop names that are too generic to safely match by themselves.
    names = {n for n in names if "-" in n or len(n) >= 6}

    # Drop projects the registry marks `public: true`. A name that already
    # lives in a public GitHub repo — or that the operator has cleared for
    # public mention — is safe to say, so flagging it protects nothing while
    # the cost is real: the fleet's own public tooling gets referenced in docs
    # and learnings constantly, and a gate that fires on nearly every push
    # trains people into SCRUB_SKIP=1. That is the same failure as a dead
    # gate, arriving by a different door.
    names -= public

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
        # (?<![\w-]) and (?![\w-]) keep `personal-crm` from matching inside `super-personal-crm-foo`.
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

    # Filter: keep only files we'd scan and that exist on disk.
    files = [f for f in files if should_scan(f) and os.path.isfile(f)]

    if not files:
        return 0

    # A source that was EXPECTED and didn't resolve fails the push. The old
    # guard checked "no patterns at all", which is one notch too low: with the
    # registry path stale and the denylist present, the gate compiled 15
    # patterns, looked configured, and never ran the project-name half.
    #
    # "Expected" is inferred rather than declared: if either source resolved,
    # this is a fleet machine and both are expected, so a missing one is a
    # broken install. If neither resolved, this is a stranger's clone of a
    # public repo with no fleet config to be missing — say so and get out of
    # the way. `SCRUB_REQUIRE_SOURCES=1` turns that soft case hard.
    registry = find_registry()
    resolved = sum(1 for s in (registry, DENYLIST_PATH) if s)

    if resolved == 0 and os.environ.get("SCRUB_REQUIRE_SOURCES") != "1":
        print(
            "[scrub-check] no pattern sources on this machine — nothing to scan against.",
            file=sys.stderr,
        )
        for w in _SOURCE_WARNINGS:
            print(f"[scrub-check]   {w}", file=sys.stderr)
        return 0

    if _SOURCE_WARNINGS:
        print("[scrub-check] pattern source missing — refusing to pass:", file=sys.stderr)
        for w in _SOURCE_WARNINGS:
            print(f"  {w}", file=sys.stderr)
        print(
            "\n[scrub-check] The other source resolved, so this machine is expected to have\n"
            "  both. A half-configured gate scans with half its patterns and still exits 0,\n"
            "  which is how this went unnoticed for weeks. Fix the path or restore the file.\n"
            "  Override for one push with SCRUB_SKIP=1.",
            file=sys.stderr,
        )
        return 2

    project_names = load_project_names(registry)
    denylist = load_denylist()
    patterns = build_patterns(project_names, denylist)

    if not patterns:
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
