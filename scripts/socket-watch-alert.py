#!/usr/bin/env python3
"""Turn a socket-watch state change into one comment on the board.

The watcher logged WARN to its CSV for eight hours before the Mac ran out of
kernel TCP control blocks on 2026-09-04 and told nobody. A line in a file
nobody tails is not an alert. This is the part that speaks.

Two rules shape everything here:

  * ONE post per state change, not one per sample. At a 15s cadence a WARN
    that lasts eight hours is 1,920 samples; a comment per sample is worse
    than silence, because the row it lands on becomes unreadable. The last
    posted state lives in a small file next to the CSV, and the post happens
    only when the new state differs from it.

  * The state file is written only after the post SUCCEEDS. A server that is
    down (or a Mac already so far out of sockets that the request cannot be
    made — the exact case this exists for) must leave the watcher still
    owing the alert, so the next sample tries again.

The message is written for someone reading a phone notification: what the
number is, which way it is moving, how long is left, and a link to the row.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

# The point at which the Mac stopped opening sockets on 2026-09-04. The
# projection counts down to this, so "hours left" means hours of real
# headroom rather than hours to an arbitrary threshold.
DEFAULT_CEILING = 163000
DEFAULT_TASK_ID = "t-kkAtJxK85M4O"
DEFAULT_WORKSPACE_ID = "w-DRa7BgNaZkqh"
DEFAULT_BASE_URL = "http://127.0.0.1:8787"

# The watcher's own identity on the board. `agent-<slug of the name>` is the
# same derivation `agentIdForName` uses in packages/core/src/identity.ts, and
# the color is what `hashToColor` gives that name — so the comment is
# attributed to a stable "Socket Watch" author rather than to the shared
# "agent" category the server refuses.
AUTHOR = {
    "id": "agent-socket-watch",
    "name": "Socket Watch",
    "kind": "known",
    "color": "#4d9dcb",
}

METRIC = "leaked TCP blocks (pcbcount minus enumerable sockets)"

# Below this much history the rate is noise, not a trend: a single 15s sample
# pair scaled to an hour swings by tens of thousands.
MIN_SPAN_HOURS = 5 / 60


def parse_ts(raw: str) -> datetime | None:
    """One CSV timestamp, or None if the row is malformed."""
    try:
        return datetime.strptime(raw.strip(), "%Y-%m-%dT%H:%M:%SZ").replace(
            tzinfo=timezone.utc
        )
    except (ValueError, AttributeError):
        return None


def read_samples(csv_path: str) -> list[tuple[datetime, int]]:
    """Every (timestamp, leak) pair the CSV can be trusted to hold.

    Rows the sampler wrote while a metric was unavailable carry an empty
    field; they are skipped rather than read as zero, because a zero here
    would invent a collapse to zero and with it a wildly wrong rate.
    """
    out: list[tuple[datetime, int]] = []
    try:
        with open(csv_path, newline="", encoding="utf-8") as fh:
            for row in csv.DictReader(fh):
                ts = parse_ts(row.get("ts", ""))
                if ts is None:
                    continue
                try:
                    pcb = int(row["pcbcount"])
                    enumerable = int(row["enumerable_sockets"])
                except (KeyError, TypeError, ValueError):
                    continue
                out.append((ts, pcb - enumerable))
    except OSError:
        return []
    return out


def hourly_rate(samples: list[tuple[datetime, int]], leak_now: int) -> float | None:
    """Change in the leak metric per hour over the last hour of samples.

    Anchored to the newest CSV row rather than to wall-clock now, so a
    watcher restarted after a gap reports the trend of the samples it
    actually has instead of dividing by the gap. Returns None when the
    history is too short to mean anything.
    """
    if not samples:
        return None
    newest_ts = samples[-1][0]
    window_start = newest_ts.timestamp() - 3600
    in_window = [s for s in samples if s[0].timestamp() >= window_start]
    if not in_window:
        return None
    oldest_ts, oldest_leak = in_window[0]
    span_hours = (newest_ts.timestamp() - oldest_ts.timestamp()) / 3600
    if span_hours < MIN_SPAN_HOURS:
        return None
    return (leak_now - oldest_leak) / span_hours


def hours_to_ceiling(leak_now: int, rate: float | None, ceiling: int) -> float | None:
    """Hours of headroom left at the current rate, or None if not climbing."""
    if rate is None or rate <= 0:
        return None
    remaining = ceiling - leak_now
    if remaining <= 0:
        return 0.0
    return remaining / rate


def fmt_count(n: float) -> str:
    return f"{round(n):,}"


def fmt_hours(hours: float) -> str:
    if hours < 1:
        return "Under an hour"
    return f"About {round(hours)} hours"


def compose(
    status: str,
    leak: int,
    rate: float | None,
    hours: float | None,
    canary: str,
    link: str,
    ceiling: int,
) -> str:
    """The comment body. Under 60 words in every branch — see the test."""
    row_link = f"[Socket leak row]({link})"
    if status == "OK":
        if rate is not None and rate < 0:
            trend = f"falling {fmt_count(abs(rate))}/hr"
        else:
            trend = "steady"
        return (
            f"Socket leak cleared. Back to {fmt_count(leak)} {METRIC}, {trend}. "
            f"No longer heading for the {fmt_count(ceiling)} failure point. {row_link}"
        )

    if rate is None:
        trend = "rate not yet known"
    elif rate > 0:
        trend = f"climbing {fmt_count(rate)}/hr"
    else:
        trend = "not climbing"

    # The canary is the load-bearing check: it asks the machine to actually
    # make a socket. Once it fails there is no headroom left to project, so
    # the projection sentence is replaced by what already happened.
    if canary and canary != "ok":
        return (
            f"Socket leak CRITICAL. The Mac is already refusing new sockets. "
            f"{fmt_count(leak)} {METRIC}, {trend}. {row_link}"
        )

    head = "Socket leak WARN." if status == "WARN" else "Socket leak CRITICAL."
    if hours is None:
        projection = "Not climbing right now."
    else:
        projection = (
            f"{fmt_hours(hours)} to the {fmt_count(ceiling)} failure point, "
            "where the Mac stops opening sockets."
        )
    return f"{head} {fmt_count(leak)} {METRIC}, {trend}. {projection} {row_link}"


def post(base_url: str, task_id: str, text: str, request_id: str, timeout: float) -> None:
    """Open the comment on the task's own doc.

    Mirrors what `create_thread` sends (packages/mcp/src/thread-create.ts): a
    subject anchor, because the comment is about the task rather than about
    any phrase in it. `requestId` makes a retry after a timeout idempotent —
    the server returns the thread the first attempt already made.
    """
    doc_id = urllib.parse.quote(f"task:{task_id}", safe="")
    url = f"{base_url}/api/docs/{doc_id}/threads"
    body = json.dumps(
        {
            "author": AUTHOR,
            "text": text,
            "anchor": {"kind": "subject"},
            "requestId": request_id,
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, headers={"content-type": "application/json"}, method="POST"
    )
    with urllib.request.urlopen(req, timeout=timeout) as res:
        res.read()


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--status", required=True, choices=["OK", "WARN", "CRITICAL"])
    p.add_argument("--leak", required=True, type=int, help="pcbcount minus enumerable sockets")
    p.add_argument("--canary", default="ok")
    p.add_argument("--csv", default=os.environ.get("SOCKET_WATCH_LOG", ""))
    p.add_argument("--state", default=os.environ.get("SOCKET_WATCH_STATE", ""))
    p.add_argument("--base-url", default=os.environ.get("SOCKET_WATCH_BASE_URL", DEFAULT_BASE_URL))
    p.add_argument("--task-id", default=os.environ.get("SOCKET_WATCH_TASK_ID", DEFAULT_TASK_ID))
    p.add_argument(
        "--workspace-id",
        default=os.environ.get("SOCKET_WATCH_WORKSPACE_ID", DEFAULT_WORKSPACE_ID),
    )
    p.add_argument("--ceiling", type=int, default=int(os.environ.get("SOCKET_WATCH_CEILING", DEFAULT_CEILING)))
    p.add_argument("--timeout", type=float, default=10.0)
    p.add_argument(
        "--dry-run",
        action="store_true",
        default=bool(os.environ.get("SOCKET_WATCH_DRY_RUN")),
        help="print the post that would be made, send nothing",
    )
    args = p.parse_args(argv)

    if not args.state:
        return fail("--state (or SOCKET_WATCH_STATE) is required")
    if not args.csv:
        return fail("--csv (or SOCKET_WATCH_LOG) is required")

    previous = ""
    try:
        with open(args.state, encoding="utf-8") as fh:
            previous = fh.read().strip()
    except OSError:
        previous = ""

    if previous == args.status:
        return 0
    # A watcher starting fresh on a healthy machine has nothing to announce.
    # Record where it came in, so the FIRST crossing is still a change.
    if not previous and args.status == "OK":
        return remember(args.state, args.status)

    samples = read_samples(args.csv)
    rate = hourly_rate(samples, args.leak)
    hours = hours_to_ceiling(args.leak, rate, args.ceiling)
    link = f"/workspaces/{args.workspace_id}?task={args.task_id}"
    text = compose(args.status, args.leak, rate, hours, args.canary, link, args.ceiling)
    stamp = samples[-1][0].strftime("%Y%m%dT%H%M%SZ") if samples else "no-samples"
    request_id = f"socket-watch-{args.status}-{stamp}"

    if args.dry_run:
        print(f"[dry-run] POST {args.base_url}/api/docs/task:{args.task_id}/threads")
        print(f"[dry-run] requestId {request_id}")
        print(f"[dry-run] {text}")
        return remember(args.state, args.status)

    try:
        post(args.base_url, args.task_id, text, request_id, args.timeout)
    except (urllib.error.URLError, OSError, TimeoutError) as exc:
        # Deliberately does NOT write the state file: the alert is still owed.
        print(f"socket-watch-alert: post failed ({exc}) — will retry", file=sys.stderr)
        return 1
    print(f"socket-watch-alert: posted {args.status}")
    return remember(args.state, args.status)


def remember(state_path: str, status: str) -> int:
    try:
        with open(state_path, "w", encoding="utf-8") as fh:
            fh.write(f"{status}\n")
    except OSError as exc:
        print(f"socket-watch-alert: could not write {state_path} ({exc})", file=sys.stderr)
        return 1
    return 0


def fail(message: str) -> int:
    print(f"socket-watch-alert: {message}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
