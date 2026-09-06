#!/bin/bash
# Is this clone's leak gate actually installed?
#
# `.githooks/pre-commit` and `.githooks/pre-push` do nothing until git is told
# where to look, and git's default is `.git/hooks` — so a fresh clone is
# UNPROTECTED and looks exactly like a protected one. Nothing fails, nothing
# prints, and the first sign is a leak reaching a commit. This runs from
# `postinstall`, so the setup step everyone already does (`bun install`) is the
# one that says so.
#
# Called from postinstall with `|| true`: a warning must never be able to fail
# an install. Called directly as `bun run check:hooks`, it exits 1 when the
# hooks are not installed, because then someone is asking a yes/no question.

set -u

root="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
# No hooks to install (a tarball, a vendored copy) — nothing to say.
[ -d "$root/.githooks" ] || exit 0

current="$(git -C "$root" config --get core.hooksPath 2>/dev/null || true)"

case "$current" in
  ".githooks"|"$root/.githooks")
    echo "[hooks] core.hooksPath=$current — commit + push leak gates are installed."
    exit 0
    ;;
esac

{
  echo ""
  echo "  ⚠  git hooks are NOT installed in this clone."
  echo ""
  if [ -n "$current" ]; then
    echo "     core.hooksPath is '$current', which is not this repo's .githooks."
  else
    echo "     core.hooksPath is unset, so git is reading .git/hooks — which is empty."
  fi
  echo "     The pre-commit and pre-push leak gates therefore never run, and a"
  echo "     clone with no gate looks exactly like a clone that passes it."
  echo ""
  echo "     Install them (once per clone):"
  echo ""
  echo "         git config core.hooksPath .githooks"
  echo ""
} >&2
exit 1
