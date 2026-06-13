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

FLEET_REGISTRY = os.path.expanduser("~/dev/ai-project-support/registry.yaml")
DENYLIST_PATH = os.path.expanduser("~/.config/conductor/scrub-denylist.txt")

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


def find_registry() -> Optional[str]:
    """Local registry.yaml at repo root, else fleet fallback."""
    root = repo_root()
    if root:
        local = os.path.join(root, "registry.yaml")
        if os.path.isfile(local):
            return local
    if os.path.isfile(FLEET_REGISTRY):
        return FLEET_REGISTRY
    return None


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
    if not registry_path:
        return names
    in_projects = False
    with open(registry_path) as f:
        for line in f:
            if re.match(r"^projects:\s*$", line):
                in_projects = True
                continue
            if not in_projects:
                continue
            m = re.match(r"^  ([a-zA-Z][a-zA-Z0-9_-]*):\s*$", line)
            if m:
                names.add(m.group(1))
                continue
            # Hit a non-indented line that isn't blank/comment — projects block ended.
            if line and not line[0].isspace() and not line.lstrip().startswith("#"):
                break

    # Drop names that are too generic to safely match by themselves.
    names = {n for n in names if "-" in n or len(n) >= 6}

    # Drop the current repo's own name — a repo's own README / CLAUDE.md / plugin
    # metadata legitimately mentions itself; we don't want to flag self-references.
    root = repo_root()
    if root:
        self_name = os.path.basename(root)
        names.discard(self_name)

    return names


def load_denylist() -> List[Tuple[str, bool]]:
    """Return (pattern, is_regex) tuples. Missing file => empty list."""
    out: List[Tuple[str, bool]] = []
    if not os.path.isfile(DENYLIST_PATH):
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

    registry = find_registry()
    project_names = load_project_names(registry)
    denylist = load_denylist()
    patterns = build_patterns(project_names, denylist)

    if not patterns:
        print(
            "[scrub-check] no patterns configured (no registry.yaml, no denylist) — skipping.",
            file=sys.stderr,
        )
        return 0

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
