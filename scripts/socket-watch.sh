#!/bin/bash
# socket-watch.sh — catch TCP socket-pool exhaustion BEFORE the machine tips over,
# and record enough per-process detail that the next ENOBUFS event is diagnosable.
#
#   ./socket-watch.sh              # one-shot status line; exit 0 ok / 1 warn / 2 critical
#   ./socket-watch.sh --watch      # sample every 60s, append CSV, alert on trouble
#   ./socket-watch.sh --dry-run    # never post; print the comment that would go out
#
# The canary is the load-bearing check: it asks the machine to actually make
# sockets. Under global exhaustion that fails with ENOBUFS regardless of which
# process is to blame. The leak metric below is the leading indicator; the
# holder list is what makes the next event attributable.
#
# WHAT CHANGED, AND WHY. This script logged WARN to the CSV for eight hours
# before the Mac ran out of kernel TCP control blocks on 2026-09-04 and told
# nobody — a line in a file nobody tails is not an alert. Two changes:
#
#   * The threshold is read against pcbcount MINUS the sockets netstat can
#     enumerate, not against pcbcount alone. The difference is the leak: the
#     control blocks the kernel is holding that no socket accounts for, which
#     is the quantity that climbed to ~163,000 and stopped the machine. Live
#     traffic moves pcbcount too, and judging on it alone confuses a busy
#     minute with a leak.
#   * Every state change (OK→WARN, WARN→CRITICAL, back to OK) is posted once
#     as a comment on the board's socket-leak row. See socket-watch-alert.py
#     for the once-per-change rule and the message.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

LOG="${SOCKET_WATCH_LOG:-$HOME/Library/Logs/socket-watch.csv}"
# The last posted state, next to the CSV: ~/Library/Logs/socket-watch.state.
STATE="${SOCKET_WATCH_STATE:-${LOG%.csv}.state}"
WARN=${SOCKET_WATCH_WARN:-120000}
CRITICAL=${SOCKET_WATCH_CRITICAL:-150000}
INTERVAL=${SOCKET_WATCH_INTERVAL:-60}
ALERTER="${SOCKET_WATCH_ALERTER:-$HERE/socket-watch-alert.py}"

WATCH=
DRY=
for arg in "$@"; do
  case "$arg" in
    --watch) WATCH=1 ;;
    --dry-run) DRY=--dry-run ;;
    *) echo "unknown argument: $arg" >&2; exit 64 ;;
  esac
done

canary() {
  python3 - <<'INNER' 2>/dev/null || echo probe-failed
import socket, errno
ss = []
try:
    for _ in range(16):
        ss.append(socket.socket(socket.AF_INET, socket.SOCK_STREAM))
    print("ok")
except OSError as e:
    print(errno.errorcode.get(e.errno, e.errno))
finally:
    for s in ss:
        s.close()
INNER
}

# One state change, one comment. Never allowed to take the watcher down with
# it: a failed post is reported and retried on the next sample, because the
# alerter only records the state it actually delivered.
alert() {
  local status="$1" leak="$2" cn="$3"
  [ -n "$leak" ] || return 0
  python3 "$ALERTER" \
    --status "$status" --leak "$leak" --canary "$cn" \
    --csv "$LOG" --state "$STATE" $DRY || true
}

sample() {
  local ts pcb ns mbuf cn status top leak
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  pcb=$(sysctl -n net.inet.tcp.pcbcount 2>/dev/null)
  ns=$(netstat -an -p tcp 2>/dev/null | tail -n +3 | wc -l | tr -d ' ')
  mbuf=$(netstat -m 2>/dev/null | awk '/allocated to network/{gsub(/[()%]/,"",$(NF-2)); print $(NF-2)}')
  cn=$(canary)
  top=$(lsof -nP -iTCP -w 2>/dev/null | tail -n +2 | awk '{print $1"/"$2}' | sort | uniq -c | sort -rn | head -5 | awk '{printf "%s=%s ",$2,$1}')

  # The leak: control blocks the kernel holds that no enumerable socket
  # accounts for. Empty when sysctl could not answer — an unknown is left
  # unknown rather than read as zero.
  leak=
  if [ -n "$pcb" ] && [ -n "$ns" ]; then leak=$((pcb - ns)); fi

  if [ "$cn" != "ok" ]; then status=CRITICAL
  elif [ -n "$leak" ] && [ "$leak" -ge "$CRITICAL" ]; then status=CRITICAL
  elif [ -n "$leak" ] && [ "$leak" -ge "$WARN" ]; then status=WARN
  else status=OK
  fi

  printf '%s,%s,%s,%s,%s,%s,"%s"\n' "$ts" "$status" "$pcb" "$ns" "$mbuf" "$cn" "$top" >> "$LOG"
  echo "$ts $status pcbcount=$pcb enumerable=$ns leaked=$leak mbuf_in_use=${mbuf}% socket()=$cn"
  echo "  holders: $top"
  alert "$status" "$leak" "$cn"
  case $status in CRITICAL) return 2 ;; WARN) return 1 ;; *) return 0 ;; esac
}

[ -f "$LOG" ] || echo 'ts,status,pcbcount,enumerable_sockets,mbuf_pct,canary,top_holders' > "$LOG"

if [ -n "$WATCH" ]; then
  while :; do
    sample; rc=$?
    [ $rc -ge 1 ] && echo "!!! socket pressure (rc=$rc) — see $LOG" >&2
    sleep "$INTERVAL"
  done
else
  sample
fi
