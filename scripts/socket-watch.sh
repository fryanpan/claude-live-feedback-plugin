#!/bin/bash
# socket-watch.sh — catch TCP socket-pool exhaustion BEFORE the machine tips over,
# and record enough per-process detail that the next ENOBUFS event is diagnosable.
#
#   ./socket-watch.sh            # one-shot status line; exit 0 ok / 1 warn / 2 critical
#   ./socket-watch.sh --watch    # sample every 60s, append CSV, shout on trouble
#
# The canary is the load-bearing check: it asks the machine to actually make
# sockets. Under global exhaustion that fails with ENOBUFS regardless of which
# process is to blame. pcbcount is the leading indicator; the holder list is what
# makes the next event attributable, which is exactly what was missing last time.

LOG="${SOCKET_WATCH_LOG:-$HOME/Library/Logs/socket-watch.csv}"
WARN=${SOCKET_WATCH_WARN:-120000}
INTERVAL=${SOCKET_WATCH_INTERVAL:-60}

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

sample() {
  local ts pcb ns mbuf cn status top
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  pcb=$(sysctl -n net.inet.tcp.pcbcount 2>/dev/null)
  ns=$(netstat -an -p tcp 2>/dev/null | tail -n +3 | wc -l | tr -d ' ')
  mbuf=$(netstat -m 2>/dev/null | awk '/allocated to network/{gsub(/[()%]/,"",$(NF-2)); print $(NF-2)}')
  cn=$(canary)
  top=$(lsof -nP -iTCP -w 2>/dev/null | tail -n +2 | awk '{print $1"/"$2}' | sort | uniq -c | sort -rn | head -5 | awk '{printf "%s=%s ",$2,$1}')

  if [ "$cn" != "ok" ]; then status=CRITICAL
  elif [ -n "$pcb" ] && [ "$pcb" -ge "$WARN" ]; then status=WARN
  else status=OK
  fi

  printf '%s,%s,%s,%s,%s,%s,"%s"\n' "$ts" "$status" "$pcb" "$ns" "$mbuf" "$cn" "$top" >> "$LOG"
  echo "$ts $status pcbcount=$pcb enumerable=$ns mbuf_in_use=${mbuf}% socket()=$cn"
  echo "  holders: $top"
  case $status in CRITICAL) return 2 ;; WARN) return 1 ;; *) return 0 ;; esac
}

[ -f "$LOG" ] || echo 'ts,status,pcbcount,enumerable_sockets,mbuf_pct,canary,top_holders' > "$LOG"

if [ "$1" = "--watch" ]; then
  while :; do
    sample; rc=$?
    [ $rc -ge 1 ] && echo "!!! socket pressure (rc=$rc) — see $LOG" >&2
    sleep "$INTERVAL"
  done
else
  sample
fi
