"""What a push actually makes public — the range both scrub layers scan.

Shared by `scrub-check.py` (regex) and `scrub-haiku.py` (AI), so the two
layers can never drift into asking different questions about the same push.

**The question this answers, and the one it replaces.** The hook used to hand
each layer `git diff <remote_sha>..<local_sha>` — a comparison of two TREES.
When the pushed tip is a merge of `main`, every line `main` gained since the
branch point is an *addition* in that comparison, even though it has been
public on `origin/main` for days. Measured on this repo: a branch whose own
change was two README lines presented 7,516 insertions across 64 files, and
the Haiku layer flagged content it had already let through. Since the
conventions tell every branch to merge `main` before its final push, the gate
fired on the normal path and the only available response was `SCRUB_SKIP=1` —
the exact dynamic recorded in learnings.md under "A false positive on a
REMOVAL is the worst false positive available", one level up.

So ask about COMMITS, not trees: everything reachable from the pushed tip that
is not reachable from a ref the remote already has. A commit drops out only
when it is already public, so this can only ever remove false positives — it
cannot hide a new addition.

Two details that are load-bearing rather than stylistic:

- **`--cc` on `git log --patch`.** By default `git log -p` prints NO diff for a
  merge commit, and a merge is exactly where conflict resolution can introduce
  text present in neither parent. Probed both ways: with `--cc` a string
  written during a conflict resolution appears; without it, it does not. Drop
  `--cc` and this "fix" starts hiding real leaks in the one commit type it was
  written for.
- **Remote-tracking refs are the definition of "already public".** They can be
  stale (nobody fetched), and then some already-public commit is scanned
  again. That failure mode is the status quo — a false positive — never a miss.
"""

from __future__ import annotations

import re
import subprocess
from typing import Iterable, List, Optional


def _is_zero(sha: str) -> bool:
    """git hands the hook an all-zeroes sha for "the remote has no such ref"."""
    return bool(sha) and set(sha) == {"0"}


def push_rev_args(
    tip: str,
    remote_glob: Optional[str] = "origin",
    already_public: Iterable[str] = (),
) -> List[str]:
    """Rev arguments selecting the commits this push would make public.

    Pure — no git calls — so the table test can reach every shape.

    `remote_glob` is None for "every remote-tracking ref". `already_public`
    carries the sha git reports for the ref being updated, which is
    authoritative in a way the local remote-tracking ref is not; all-zero
    ("the branch does not exist there yet") and duplicate entries drop out.
    """
    args = [tip, "--not", "--remotes" if remote_glob is None else f"--remotes={remote_glob}"]
    seen = set()
    for sha in already_public:
        if not sha or _is_zero(sha) or sha in seen:
            continue
        seen.add(sha)
        args.append(sha)
    return args


def resolve_remote_glob(name: Optional[str]) -> Optional[str]:
    """The remote name if this repo has one by that name, else every remote.

    `git push <url>` hands the hook a URL rather than a name, and
    `--remotes=<url>` matches nothing — which would silently widen the scan to
    the branch's whole history. Widening is safe, but only by accident, so
    resolve it deliberately.
    """
    if not name:
        return None
    try:
        out = subprocess.run(
            ["git", "remote"], capture_output=True, text=True, check=True,
        ).stdout.split()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None
    return name if name in out else None


def rev_args_from_cli(argv: List[str]) -> Optional[List[str]]:
    """`--push-tip <sha> [--remote <name>] [--already-public <sha>]...` -> rev args.

    None when `--push-tip` is absent, so a caller can fall back to its older
    modes. Parsed here rather than in each script so the two layers cannot
    drift into scanning different ranges of the same push.
    """
    if "--push-tip" not in argv:
        return None
    tip = ""
    remote: Optional[str] = "origin"
    public: List[str] = []
    i = 0
    while i < len(argv):
        flag = argv[i]
        if flag in ("--push-tip", "--remote", "--already-public"):
            if i + 1 >= len(argv):
                raise ValueError(f"{flag} needs a value")
            value = argv[i + 1]
            if flag == "--push-tip":
                tip = value
            elif flag == "--remote":
                remote = value
            else:
                public.append(value)
            i += 2
            continue
        i += 1
    if not tip:
        raise ValueError("--push-tip needs a value")
    return push_rev_args(tip, resolve_remote_glob(remote), public)


def _git(args: List[str]) -> str:
    try:
        return subprocess.run(
            args, capture_output=True, text=True, check=True,
        ).stdout
    except (subprocess.CalledProcessError, FileNotFoundError):
        return ""


# Git's own commit-metadata lines in `git log --patch` output: the `Author:`
# header at column 0, and identity trailers indented four spaces inside the
# commit message. Diff content can NEVER match — added lines start with `+`,
# removed with `-` — so file content that merely looks like a trailer is out
# of reach by construction, not by judgment.
_METADATA_IDENTITY_LINE = re.compile(
    r"^(?P<prefix>(?:Author|Commit|Committer): +"
    r"| {4}(?:Co-authored-by|Signed-off-by|Committer): *)"
    r"(?P<identity>\S.*?) *$",
    re.IGNORECASE,
)

IDENTITY_PLACEHOLDER = "<commit identity already public on the remote>"


def public_commit_identities(remote_glob: Optional[str] = None) -> set:
    """Author/committer identities on commits the remote already has."""
    out = _git([
        "git", "log", "--format=%an <%ae>%n%cn <%ce>",
        "--remotes" if remote_glob is None else f"--remotes={remote_glob}",
    ])
    return {line.strip() for line in out.splitlines() if line.strip()}


def redact_public_identities(patch: str, identities: Iterable[str]) -> str:
    """Blank commit-metadata identity lines the remote has already published.

    Measured on PR #198: the Haiku layer flagged the commit author trailer —
    the identity on every commit already public on origin/main — as a leak
    across 11 file/line pairs and blocked the push, and the only exit was
    SCRUB_SKIP_HAIKU=1. A gate that fires on the normal path trains people
    to bypass it, which is worse than the finding it produces.

    Narrow on purpose, in both dimensions: only git's OWN metadata lines
    (the regex cannot reach diff content), and only identities already
    reachable from a remote-tracking ref — an email introduced in file
    content, or a co-author the remote has never seen, still goes to Haiku
    exactly as before.
    """
    known = set(identities)
    if not known:
        return patch
    lines = []
    for line in patch.split("\n"):
        m = _METADATA_IDENTITY_LINE.match(line)
        if m and m.group("identity").strip() in known:
            line = m.group("prefix") + IDENTITY_PLACEHOLDER
        lines.append(line)
    return "\n".join(lines)


def push_patch(rev_args: List[str]) -> str:
    """The patch text of the becoming-public commits, messages included.

    Commit messages ride along because they become public too, and the tree
    diff this replaces never showed them. Commit-metadata identities the
    remote already carries are redacted — they publish nothing new, and the
    Haiku layer has blocked a push over its own author trailer (PR #198).
    """
    patch = _git([
        "git", "log", "--patch", "--cc", "--reverse", "--no-color", *rev_args,
    ])
    return redact_public_identities(patch, public_commit_identities())


def push_files(rev_args: List[str]) -> List[str]:
    """Paths touched by the becoming-public commits, de-duplicated."""
    out = _git([
        "git", "log", "--name-only", "--pretty=format:", "--no-color", "--cc", *rev_args,
    ])
    seen = set()
    files = []
    for line in out.split("\n"):
        path = line.strip()
        if path and path not in seen:
            seen.add(path)
            files.append(path)
    return files
