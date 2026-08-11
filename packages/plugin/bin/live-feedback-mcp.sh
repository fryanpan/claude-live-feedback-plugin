#!/bin/sh
# Launcher for the bundled MCP server.
#
# Why this exists: .mcp.json used to say `"command": "node"`, which only works
# when node happens to be on the launching process's PATH. On a machine where
# node comes from nvm, PATH is set up in ~/.zshrc — so it exists in an
# interactive shell and nowhere else. Sessions started any other way (launchd,
# a GUI app, cron, a non-login shell) died with a bare
#
#     Connection failed (ENOENT): Executable not found in $PATH: "node"
#
# and from inside the session live-feedback was simply absent. Reconnecting
# doesn't help — it reuses the config the session already resolved.
#
# /bin/sh is the one interpreter guaranteed to be present, so it does the
# resolution itself instead of trusting the inherited environment.
#
# Usage: /bin/sh live-feedback-mcp.sh <path-to-mcp/index.js> [args...]

set -u

bundle="${1:-}"
if [ -z "$bundle" ]; then
  echo "live-feedback-mcp: no bundle path given (expected mcp/index.js as \$1)" >&2
  exit 64
fi
shift

# Newest nvm version first: version dirs sort lexically, which is wrong across a
# major boundary (v9 > v10), so compare numerically on each component.
newest_nvm_node() {
  # HOME can be unset in the very environments this script exists for (cron, a
  # sanitized launchd job). Under `set -u` a bare $HOME aborts this function's
  # subshell and prints "HOME: unbound variable" — the fixed locations below are
  # still tried, but that line reads like a crash to whoever is debugging. Default
  # it, and skip the nvm search entirely when there's no root to derive.
  nvm_dir="${NVM_DIR:-}"
  if [ -z "$nvm_dir" ]; then
    [ -n "${HOME:-}" ] || return 1
    nvm_dir="$HOME/.nvm"
  fi
  nvm_root="$nvm_dir/versions/node"
  [ -d "$nvm_root" ] || return 1
  best=''
  best_key=''
  for dir in "$nvm_root"/v*; do
    [ -x "$dir/bin/node" ] || continue
    version="${dir##*/v}"
    # zero-pad each component so a plain string compare orders them correctly
    key=$(echo "$version" | awk -F. '{printf "%05d%05d%05d", $1, $2, $3}')
    if [ -z "$best_key" ] || [ "$key" \> "$best_key" ]; then
      best_key="$key"
      best="$dir/bin/node"
    fi
  done
  [ -n "$best" ] || return 1
  echo "$best"
}

find_node() {
  # 1. Already on PATH (the normal case, and respects an intentional override).
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  # 2. nvm, newest installed version.
  if candidate=$(newest_nvm_node); then
    echo "$candidate"
    return 0
  fi
  # 3. Common fixed locations, in the order a package manager would install them.
  for candidate in \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    /usr/bin/node \
    /snap/bin/node
  do
    [ -x "$candidate" ] && { echo "$candidate"; return 0; }
  done
  return 1
}

node_bin=$(find_node) || {
  echo "live-feedback-mcp: could not find a node binary." >&2
  echo "  Looked on PATH, in \${NVM_DIR:-\$HOME/.nvm}/versions/node, and in" >&2
  echo "  /opt/homebrew/bin, /usr/local/bin, /usr/bin, /snap/bin." >&2
  echo "  Install node, or put it on the PATH the session is launched with." >&2
  exit 127
}

# A seam for the test: prove resolution works without starting a stdio server.
if [ "${LF_MCP_PRINT_NODE:-}" = "1" ]; then
  echo "$node_bin"
  exit 0
fi

exec "$node_bin" "$bundle" "$@"
