#!/usr/bin/env python3
"""Haiku-based diff scrub pass — catches leaks the regex check can't.

Invoked by .githooks/pre-push AFTER scripts/scrub-check.py passes. The regex
check is fast and deterministic for known patterns (registry project names,
denylist entries). Haiku adds a context-aware AI scan for things the regex
can't anticipate: unrecognized real names, contextual identifiers, quotes
that reveal a private person, financial/health specifics in personal context.

Usage:
  scrub-haiku.py --diff-range A..B    # scan diff in range
  scrub-haiku.py                       # read diff from stdin

Exit codes:
  0  clean (or Haiku unavailable — defensive non-block)
  1  leaks found — push blocked
  2  setup error (treated as 0 by the hook so missing key / network blip
     doesn't break pushes; the regex check still ran)

Bypass entirely with SCRUB_SKIP=1. Skip just Haiku with SCRUB_SKIP_HAIKU=1.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

MODEL = "claude-haiku-4-5-20251001"
API_URL = "https://api.anthropic.com/v1/messages"
API_TIMEOUT_SEC = 30
# Approx chars-to-tokens (Anthropic English ~3.5 chars/token; be conservative at 4).
# 80K tokens of diff caps out a Haiku call comfortably.
MAX_DIFF_CHARS = 80_000 * 4

SYSTEM_PROMPT = """You are a sensitive-content scanner. You will be shown a git diff that's about to be pushed to a public GitHub repository. Your job is to spot anything that would leak private information once that push lands.

**What counts as a leak (flag it):**
- Real personal names (other than the repo's documented author / committer in standard metadata like LICENSE or package author tags)
- Email addresses, phone numbers, postal addresses, SSNs, financial account numbers
- Specific dollar amounts in personal context (taxes, donations, balances, salaries)
- Tax-document names tied to a specific person (Form 8606, Schedule D, kiddie tax, IRA backdoor, capital loss carryover, etc.)
- Health/medical specifics (CGM readings, HbA1c values, medications, diagnoses, doctor visits)
- Specific travel destinations + dates in personal context (e.g., "Berlin trip in June")
- Names of OTHER private projects — codenames the maintainer hasn't already published elsewhere
- API keys, OAuth tokens, bot tokens, Discord user IDs, webhook secrets
- Private internal URLs (Linear/Notion/Asana IDs that aren't already shared publicly)
- Quoted chat conversations or first-person snippets that identify a private person
- Filesystem paths containing a real username (e.g., `/Users/realname/...`)

**What does NOT count as a leak (don't flag):**
- The repo's own name in self-references (a repo's README / CLAUDE.md / package metadata legitimately names itself)
- The author/maintainer name in standard metadata fields
- Public technical references (Anthropic, Claude, GitHub URLs to known public repos, well-known libraries)
- Generic placeholders: <user>, <your-tailnet>, your-username/example, my-project, the user
- Function/variable/class names, programming jargon, code comments about the code itself
- Standard package descriptions ("a Python module that does X")

**Output format — respond in EXACTLY this shape:**

If clean:
VERDICT: CLEAN

If leaks found:
VERDICT: LEAKS_FOUND
LEAKS:
- <file>:<line> — <one-line description of leak>
- <file>:<line> — <one-line description of leak>

Be conservative — when borderline, flag it. The human can override with SCRUB_SKIP=1 after reviewing your reasoning."""


def call_haiku(diff_content: str) -> int:
    # Prefer SCRUB_HAIKU_API_KEY so this layer can use a key separate from
    # general-purpose Anthropic usage (better audit + isolated billing).
    api_key = os.environ.get("SCRUB_HAIKU_API_KEY") or os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print(
            "[scrub-haiku] no API key (SCRUB_HAIKU_API_KEY or ANTHROPIC_API_KEY) — skipping Haiku check.",
            file=sys.stderr,
        )
        return 2

    body = json.dumps({
        "model": MODEL,
        "max_tokens": 1024,
        "system": SYSTEM_PROMPT,
        "messages": [{
            "role": "user",
            "content": f"Scan this diff for leaks:\n\n```diff\n{diff_content}\n```",
        }],
    }).encode("utf-8")

    req = urllib.request.Request(
        API_URL,
        data=body,
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=API_TIMEOUT_SEC) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        print(f"[scrub-haiku] HTTP {e.code} from Anthropic API: {body[:200]}", file=sys.stderr)
        return 2
    except (urllib.error.URLError, json.JSONDecodeError, OSError) as e:
        print(f"[scrub-haiku] API call failed: {e}", file=sys.stderr)
        return 2

    content = data.get("content", [])
    if not content:
        print("[scrub-haiku] empty response from Haiku.", file=sys.stderr)
        return 2

    text = content[0].get("text", "").strip()

    if "VERDICT: CLEAN" in text:
        return 0
    if "VERDICT: LEAKS_FOUND" in text:
        print("[scrub-haiku] Haiku flagged leaks:", file=sys.stderr)
        for line in text.split("\n"):
            print(f"  {line}", file=sys.stderr)
        return 1

    print("[scrub-haiku] unexpected response shape from Haiku:", file=sys.stderr)
    print(text, file=sys.stderr)
    return 2


def get_diff(range_spec: str) -> str:
    try:
        r = subprocess.run(
            ["git", "diff", range_spec],
            capture_output=True, text=True, check=True,
        )
        return r.stdout
    except subprocess.CalledProcessError:
        return ""


def main() -> int:
    if os.environ.get("SCRUB_SKIP") == "1":
        return 0
    if os.environ.get("SCRUB_SKIP_HAIKU") == "1":
        print("[scrub-haiku] SCRUB_SKIP_HAIKU=1 — bypassing Haiku check.", file=sys.stderr)
        return 0

    args = sys.argv[1:]
    if "--help" in args or "-h" in args:
        print(__doc__)
        return 0

    if "--diff-range" in args:
        idx = args.index("--diff-range")
        if idx + 1 >= len(args):
            print("[scrub-haiku] --diff-range needs a value", file=sys.stderr)
            return 2
        diff = get_diff(args[idx + 1])
    else:
        diff = sys.stdin.read()

    if not diff.strip():
        return 0

    if len(diff) > MAX_DIFF_CHARS:
        diff = diff[:MAX_DIFF_CHARS]
        print(
            f"[scrub-haiku] diff truncated to ~{MAX_DIFF_CHARS // 4} tokens for Haiku call.",
            file=sys.stderr,
        )

    rc = call_haiku(diff)
    if rc == 2:
        # Setup / API error — don't block the push. Regex check already passed.
        print(
            "[scrub-haiku] Haiku check unavailable; relying on regex check only.",
            file=sys.stderr,
        )
        return 0
    return rc


if __name__ == "__main__":
    sys.exit(main())
