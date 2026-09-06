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
  scrub-check.py --push-tip SHA [--remote NAME] [--already-public SHA]...
                                            # files this push makes public (hook mode)
  scrub-check.py --diff-range A..B          # scan files changed in range
  scrub-check.py --staged                   # scan whole blobs in the git index
  scrub-check.py --staged-added             # scan only the lines the commit ADDS
  scrub-check.py --scan-all-tracked         # scan every tracked file (audit)

TWO GATES, TWO QUESTIONS. `.githooks/pre-commit` asks what this commit ADDS
(`--staged-added`); `.githooks/pre-push` asks what the push MAKES PUBLIC
(whole blobs). The split is the whole point. A commit gate that read whole
blobs would refuse an edit to any file whose untouched lines already carry a
match — a tax on editing near old content, and the reliable way to train
people into SCRUB_SKIP=1. A push gate that read only additions would let a
leak through the moment a branch merged a commit that carried one. Catching
it at commit time is what keeps the remedy cheap: nothing is written yet, so
there is no history to rewrite — and rewriting history is the step an agent
cannot take, which is what made PR 675 the repo owner's problem to fix by
hand. Findings from the push gate name the commit that wrote each line, so
the writer knows whether the remedy is a rewrite or a forward fix.

`--push-tip` narrows the file list to the ones the becoming-public commits
touch. This layer is deterministic, so a merge of `main` never produced the
false positives the Haiku layer did — but the same defect is latent here:
`--diff-range remote..tip` lists every file `main` touched too, so the day a
name is ADDED to the registry, the next branch to merge `main` is blocked on
content that has been public for weeks. Both layers now ask scrub_git.py the
same question about the same push.

WHAT IS READ. In every git-addressed mode the scanner reads the BLOB that
would become public, never the working tree: `--push-tip SHA` and
`--diff-range A..B` read `git show <tip>:<path>` (the tip is SHA, or B), and
`--staged` reads the index. Before this (Urgent-fixes ticket, 2026-09-02) the
file list came from git and the bytes came from disk, so an uncommitted edit
could hide a leak the push carried — or flag one it did not. Only bare paths
read the working tree. A leak in an intermediate commit that the tip no
longer carries is still published as history; the Haiku layer scans the full
patch of every becoming-public commit and is the layer that sees it.

NEVER-ALLOW TYPES. Some file types are always scanned and can never be
allowlisted — not by `scrub-allow`, not by SKIP_PATHS: `.ydoc` (a whole
document corpus), `.jsonl` / `.csv` (data dumps), `.svg` / `.xml` (markup
that is text but reads as an asset), image types, and extension-less files.
These were SKIPPED before, as "binaries", which made them the one place a
leak could travel unread. See NEVER_ALLOW_EXTS.

SCRUB-ALLOW is honoured only as a TRAILING COMMENT TOKEN — `# scrub-allow`,
`// scrub-allow`, `<!-- scrub-allow ... -->`, `/* scrub-allow */` at the end
of the line. The word appearing anywhere in a line used to exempt the line,
which let a string literal or a URL fragment exempt itself.

This tool does NOT read stdin; piping a diff at it is an error, not a scan.

Exit codes: 0 = clean, 1 = leaks found, 2 = setup error.

Bypass entirely with `SCRUB_SKIP=1` (logged; use sparingly).
"""

from __future__ import annotations

import fnmatch
import os
import re
import subprocess
import sys
from typing import Callable, Dict, List, NamedTuple, Optional, Set, Tuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scrub_git  # noqa: E402

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

# File types that are ALWAYS scanned and can NEVER be allowlisted — not by an
# inline `scrub-allow`, not by SKIP_PATHS. Each is a shape in which content
# arrives without anyone having read it line by line: a `.ydoc` is a whole
# document corpus, `.jsonl` and `.csv` are dumps, `.svg`/`.xml` are assets
# that happen to be text, images are opaque, and an extension-less file is
# whatever it is. Before this they were skipped as "binaries", which made
# them the one channel a leak could travel through unread.
# (Urgent-fixes ticket, 2026-09-02.)
NEVER_ALLOW_EXTS = {
    ".ydoc", ".jsonl", ".csv", ".svg", ".xml",
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".tif", ".tiff",
    ".heic", ".heif", ".avif",
}

# Files that are refused OUTRIGHT, whatever they contain: a meeting's raw
# record. `<docname>-raw-transcript.md` (and its `-replay-` reruns) is what
# people said in a room, and the audio beside it is the room itself; both
# live under the server data dir and are gitignored, and this is the second
# lock. No content scan could clear one — a clean transcript is still a
# transcript — so a match here is a finding by itself and `scrub-allow`
# cannot exempt it. (Meeting ticket, 2026-09-02.)
NEVER_PUSH_NAMES = (
    "*-raw-transcript.md",
    "*-raw-transcript-replay-*.md",
)
NEVER_PUSH_EXTS = {
    ".pcm", ".wav", ".mp3", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".flac",
    ".wma", ".aiff", ".aif", ".webm", ".mp4", ".m4v", ".mov", ".mkv",
}

# Specific paths to never scan. The scanner's own files (scrub-check.py,
# scrub-haiku.py) must be skipped because they intentionally mention denylist
# keywords as examples of what to flag — scanning them would block their own
# propagation. Likewise the gitignored docs. A NEVER_ALLOW type listed here
# would still be scanned: that set wins.
SKIP_PATHS = {
    "docs/process/aggregation-log.md",
    "registry.yaml",
    "scripts/scrub-check.py",
    "scripts/scrub-haiku.py",
}

# `scrub-allow` counts only as a TRAILING comment token. A line comment
# (`#`, `//`, `--` for SQL/Lua, `;` for ini/asm) runs to end of line by
# definition; a block comment (`<!-- -->`, `/* */`) must CLOSE at end of
# line, so `/* scrub-allow */ secret` is not exempt. The opener must start
# the line or follow whitespace, so a `#scrub-allow` URL fragment is not an
# opener. Anywhere else in the line the word is just a word.
ALLOW_RX = re.compile(
    r"(?:^|\s)(?:"
    r"(?:#|//|--|;)\s*scrub-allow\b[^\n]*"
    r"|<!--\s*scrub-allow\b[^\n]*?-->\s*"
    r"|/\*\s*scrub-allow\b[^\n]*?\*/\s*"
    r")$"
)


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
                # Accept both `/pattern` and the delimited `/pattern/` most
                # entries are written as. Stripping only the leading slash
                # left a literal trailing `/` on every delimited pattern —
                # they compiled fine and matched nothing, so the gate
                # reported clean while its regex entries were blind.
                body = s[1:]
                if len(body) > 1 and body.endswith("/") and not body.endswith("\\/"):
                    body = body[:-1]
                out.append((body, True))
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


def never_push_reason(path: str) -> Optional[str]:
    """Why this file can never be pushed, or None when it can be scanned."""
    name = os.path.basename(path)
    for pat in NEVER_PUSH_NAMES:
        if fnmatch.fnmatch(name, pat):
            return f"meeting transcript ({pat}) — never pushed, whatever it says"
    ext = os.path.splitext(name)[1].lower()
    if ext in NEVER_PUSH_EXTS:
        return f"audio/video ({ext}) — never pushed"
    return None


def is_never_allow(path: str) -> bool:
    """A type that is always scanned and cannot be allowlisted."""
    ext = os.path.splitext(os.path.basename(path))[1].lower()
    return ext in NEVER_ALLOW_EXTS or ext == ""


def should_scan(path: str) -> bool:
    # Checked FIRST: a never-push file is looked at whatever else says skip,
    # and a never-allow type is scanned even if a path rule below would skip
    # it. Both sets exist so that no rule can quietly widen.
    if never_push_reason(path) is not None:
        return True
    if is_never_allow(path):
        return True
    if path in SKIP_PATHS:
        return False
    ext = os.path.splitext(os.path.basename(path))[1].lower()
    return ext in SCAN_EXTS


def scan_lines(
    path: str, lines: List[Tuple[int, str]], patterns: List[Tuple[str, re.Pattern]]
) -> List[Tuple[int, str, str]]:
    """Return [(line_no, label, line_text)] of matches among `lines`.

    `path` decides only whether an inline `scrub-allow` may exempt a line:
    never in a NEVER_ALLOW type, and elsewhere only as a trailing comment
    token (ALLOW_RX). WHICH lines arrive here is the mode's decision, and it
    is the whole difference between the two gates: the push gate hands over
    every line of the blob it would publish, the commit gate hands over only
    the lines this commit ADDS.
    """
    findings: List[Tuple[int, str, str]] = []
    allow_ok = not is_never_allow(path)
    for line_no, line in lines:
        # A line documenting the gate itself may exempt itself — with a
        # trailing comment, in a type where a comment means something.
        if allow_ok and ALLOW_RX.search(line):
            continue
        for label, rx in patterns:
            if rx.search(line):
                findings.append((line_no, label, line))
                break  # one finding per line is enough
    return findings


def numbered_lines(data: bytes) -> List[Tuple[int, str]]:
    """Every line of a blob, 1-based — what the whole-blob modes scan."""
    text = data.decode("utf-8", errors="replace")
    return list(enumerate(text.split("\n"), 1))


def scan_content(
    path: str, data: bytes, patterns: List[Tuple[str, re.Pattern]]
) -> List[Tuple[int, str, str]]:
    """Whole-blob scan: every line of `data`."""
    return scan_lines(path, numbered_lines(data), patterns)


def scan_file(path: str, patterns: List[Tuple[str, re.Pattern]]) -> List[Tuple[int, str, str]]:
    """Scan a file on disk. Kept for callers that pass bare paths."""
    data = read_worktree(path)
    return [] if data is None else scan_content(path, data, patterns)


def read_worktree(path: str) -> Optional[bytes]:
    try:
        with open(path, "rb") as f:
            return f.read()
    except (OSError, IOError):
        return None


def read_blob(rev: str, path: str) -> Optional[bytes]:
    """The bytes of `path` at `rev` (`""` for the index), or None if absent.

    This is what the push publishes. A file the working tree has since
    edited, or that the tip no longer carries, is read as the tip has it —
    the only version anyone else will ever see.
    """
    try:
        return subprocess.run(
            ["git", "show", f"{rev}:{path}"],
            capture_output=True, check=True,
        ).stdout
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


# Blame is one subprocess per finding, so cap it. Past a few dozen the writer
# has a category problem rather than a line problem, and the un-annotated
# findings still name file and line.
_ATTRIBUTION_BUDGET = [40]


def attribute(
    blame_rev: Optional[str],
    publishing: Optional[set],
    path: str,
    line_no: int,
) -> Optional[str]:
    """One line saying WHICH commit wrote this finding, and whether it is new.

    The push gate reads whole blobs, so it can fire on a line the branch never
    wrote — a file it merely touched. That happened on PR 723, and the writer
    reached for `git commit --amend` on content that had been on the remote
    for weeks. The remedy differs completely between the two cases, so the
    gate now says which one this is instead of leaving it to be worked out.
    """
    if blame_rev is None or _ATTRIBUTION_BUDGET[0] <= 0:
        return None
    _ATTRIBUTION_BUDGET[0] -= 1
    found = scrub_git.blame_line(blame_rev, path, line_no)
    if found is None:
        return None
    sha, subject = found
    short = sha[:9]
    title = f' "{subject}"' if subject else ""
    if publishing is not None and sha in publishing:
        return f"introduced by {short}{title} — this push would publish it (rewrite that commit)"
    return f"already on the remote in {short}{title} — a forward fix is enough"


def tip_of_range(range_spec: str) -> Optional[str]:
    """The publishing side of `A..B` / `A...B` — B. None for a bare rev."""
    for sep in ("...", ".."):
        if sep in range_spec:
            tip = range_spec.rsplit(sep, 1)[1].strip()
            return tip or None
    return None


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


def files_staged_alive() -> List[str]:
    """Staged paths this commit still carries — deletions excluded.

    A commit whose whole point is to REMOVE a file that may never be pushed
    is the fix, not the leak; `--diff-filter=d` (lowercase: exclude) is what
    keeps the never-push refusal from blocking it.
    """
    try:
        out = subprocess.run(
            ["git", "diff", "--cached", "--name-only", "--diff-filter=d"],
            capture_output=True, text=True, check=True,
        ).stdout
        return [f for f in out.strip().split("\n") if f]
    except subprocess.CalledProcessError:
        return []


_HUNK_RX = re.compile(rb"^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@")


def _unquote_path(raw: bytes) -> str:
    """A path as git printed it in a diff header, quoting undone.

    git wraps a path in double quotes and C-escapes it when it contains a
    quote, a backslash or (without core.quotePath=false) a non-ASCII byte.
    Left quoted, the path never matches the one `should_scan` and the
    never-push rules are asked about — the file would be scanned under a
    name that does not exist, which is a miss dressed as a scan.
    """
    text = raw.decode("utf-8", errors="replace")
    if not (len(text) >= 2 and text[0] == '"' and text[-1] == '"'):
        return text
    try:
        return text[1:-1].encode("latin-1", "backslashreplace").decode("unicode_escape")
    except (UnicodeDecodeError, UnicodeEncodeError):
        return text[1:-1]


def staged_added_lines() -> Dict[str, List[Tuple[int, str]]]:
    """{path: [(new_line_no, text)]} — the lines this commit ADDS.

    THE POINT OF THE COMMIT GATE. The push gate reads whole blobs, which is
    right for a push (everything in the blob becomes public) and wrong for a
    commit: touching one line of a file whose other lines already carry a
    match would be refused, and a gate that fires on edits near old content
    is a gate people turn off. Measured on this repo (PR 723): a codemod
    changed one line of a doc whose untouched lines carried a private name,
    the whole-blob read fired, and `git commit --amend` was not available as
    a remedy.

    `--text` so a NEVER_ALLOW type (`.ydoc`, `.csv`, an image) is diffed as
    text rather than summarised as "binary files differ" — those are exactly
    the shapes content arrives in unread. `-U0` so only changed lines appear,
    never their neighbours.
    """
    try:
        out = subprocess.run(
            [
                "git", "-c", "core.quotePath=false", "diff", "--cached",
                "-U0", "--text", "--no-color", "--no-ext-diff", "--find-renames",
            ],
            capture_output=True, check=True,
        ).stdout
    except (subprocess.CalledProcessError, FileNotFoundError):
        return {}

    added: Dict[str, List[Tuple[int, str]]] = {}
    path: Optional[str] = None
    line_no = 0
    in_hunk = False
    for raw in out.split(b"\n"):
        if raw.startswith(b"diff --git "):
            path, in_hunk = None, False
            continue
        # `+++ ` is a file header only BEFORE the first hunk. Inside one it is
        # an added line whose own text starts with `++`, and reading that as a
        # header would silently retarget every line after it.
        if not in_hunk and raw.startswith(b"+++ "):
            target = raw[4:].strip()
            if target == b"/dev/null":
                path = None
            else:
                name = _unquote_path(target)
                path = name[2:] if name[:2] in ("b/", "a/") else name
            continue
        m = _HUNK_RX.match(raw)
        if m:
            in_hunk = True
            line_no = int(m.group(1))
            continue
        if in_hunk and path and raw.startswith(b"+"):
            added.setdefault(path, []).append(
                (line_no, raw[1:].decode("utf-8", errors="replace"))
            )
            line_no += 1
    return added


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

    try:
        rev_args = scrub_git.rev_args_from_cli(args)
    except ValueError as e:
        print(f"[scrub-check] {e}", file=sys.stderr)
        return 2

    # Where the BYTES come from. Every git-addressed mode reads the blob the
    # push would publish; only bare paths read the working tree.
    read: "Callable[[str], Optional[bytes]]" = read_worktree
    # Added-lines mode carries its own line sets; nothing is read by path.
    added: Optional[Dict[str, List[Tuple[int, str]]]] = None
    # For attribution: the rev whose blame answers "who wrote this line", and
    # the commits this run would publish. Both None outside the push modes.
    blame_rev: Optional[str] = None
    publishing: Optional[set] = None
    files: List[str] = []
    if "--staged-added" in args:
        added = staged_added_lines()
        files = files_staged_alive()
    elif rev_args is not None:
        files = scrub_git.push_files(rev_args)
        tip = rev_args[0]
        blame_rev = tip
        publishing = scrub_git.becoming_public_shas(rev_args)
        read = lambda path, _rev=tip: read_blob(_rev, path)
    elif "--diff-range" in args:
        idx = args.index("--diff-range")
        if idx + 1 >= len(args):
            print("[scrub-check] --diff-range needs an argument", file=sys.stderr)
            return 2
        range_spec = args[idx + 1]
        files = files_in_range(range_spec)
        tip = tip_of_range(range_spec)
        if tip is None:
            print(
                f"[scrub-check] --diff-range wants A..B (got {range_spec!r}); "
                "the right-hand side is the tip whose blobs are scanned.",
                file=sys.stderr,
            )
            return 2
        blame_rev = tip
        publishing = scrub_git.becoming_public_shas([range_spec])
        read = lambda path, _rev=tip: read_blob(_rev, path)
    elif "--staged" in args:
        files = files_staged()
        read = lambda path: read_blob("", path)
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
                "  Pass file paths, or --diff-range A..B / --staged / --staged-added /\n"
                "  --scan-all-tracked.",
                file=sys.stderr,
            )
            return 2

    # Filter: keep only files we'd scan and that the source can produce — a
    # path git named that the tip no longer carries (deleted in the push) has
    # no blob to read, and a bare path that is not a file has no bytes.
    #
    # `units` is (path, [(line_no, text)]) in every mode. Whole-blob modes
    # number every line of the blob; added-lines mode carries the diff's own
    # new-side numbers, so a finding still points at a line of the file.
    units: List[Tuple[str, List[Tuple[int, str]]]] = []
    scannable = [f for f in files if should_scan(f)]
    if added is not None:
        for f in scannable:
            lines = added.get(f)
            if lines:
                units.append((f, lines))
        # A never-push file is refused for EXISTING, whatever it adds — a
        # rename or a mode change of one adds no lines at all.
        present = scannable
    else:
        for f in scannable:
            if read is read_worktree and not os.path.isfile(f):
                continue
            data = read(f)
            if data is not None:
                units.append((f, numbered_lines(data)))
        present = [f for f, _ in units]

    if not units and not present:
        return 0

    # Before any pattern source is consulted: a file that can never be pushed
    # is refused even on a machine with no patterns at all. Only files the
    # source can still produce — a deleted one is the fix, not the leak.
    # "Push blocked" is wrong at commit time, and the difference is the useful
    # half of the message: a blocked commit is fixed by editing a file.
    blocked = "Commit blocked" if added is not None else "Push blocked"
    override_cmd = "git commit" if added is not None else "git push"

    refused = [(f, never_push_reason(f)) for f in present if never_push_reason(f)]
    if refused:
        print("[scrub-check] files that are never pushed:", file=sys.stderr)
        for f, why in refused:
            print(f"  {f}  ({why})", file=sys.stderr)
        print(
            f"\n[scrub-check] {len(refused)} refused file(s). {blocked}.\n"
            "[scrub-check] Fix: these belong under the server data dir, not the repo — "
            "remove them from the commit. No allowlist applies.",
            file=sys.stderr,
        )
        return 1

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
    for f, lines in units:
        for line_no, label, line in scan_lines(f, lines, patterns):
            if total == 0:
                print(f"[scrub-check] leaks detected:", file=sys.stderr)
            files_with_findings.add(f)
            snippet = line.strip()
            if len(snippet) > 100:
                snippet = snippet[:97] + "..."
            print(f"  {f}:{line_no}  ({label})", file=sys.stderr)
            print(f"    > {snippet}", file=sys.stderr)
            note = attribute(blame_rev, publishing, f, line_no)
            if note:
                print(f"    {note}", file=sys.stderr)
            total += 1

    if total:
        print(
            f"\n[scrub-check] {total} leak(s) across {len(files_with_findings)} file(s). {blocked}.",
            file=sys.stderr,
        )
        print(
            "[scrub-check] Fix: replace with a generic placeholder, anonymize, or move content to a gitignored path.",
            file=sys.stderr,
        )
        if added is not None:
            print(
                "[scrub-check] Nothing is committed yet — edit the file and re-stage. No history to rewrite.",
                file=sys.stderr,
            )
        elif blame_rev is not None:
            print(
                "[scrub-check] Each finding says which commit wrote the line: one this push\n"
                "  publishes needs the history changed (amend / rebase / a new branch); one\n"
                "  already public needs only a forward commit that anonymizes it.",
                file=sys.stderr,
            )
        print(
            f"[scrub-check] Override (sparingly): SCRUB_SKIP=1 {override_cmd} ...",
            file=sys.stderr,
        )
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
