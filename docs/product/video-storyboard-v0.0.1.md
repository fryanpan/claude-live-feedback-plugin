# Video walkthrough storyboard — v0.0.1 announce

**Format:** Loom screen recording, Bryan's voiceover, 2-3 min total (~90s active + breathing room).
**Status:** strawman for Wed sync confirmation. Voice-pass with Writing Assistant before record.
**Goal:** show the canonical loop in one clean run. Earn the README's opening claim ("the loop most human/AI tools don't close") with a 90-second existence proof.

## Pre-record setup (5 min, one-time)

- Two windows side-by-side or quick alt-tab between:
  - **Browser** at `http://mac-mini.<private-network>:8788/review/<docId>?as=bryan` — pick a real doc with a paragraph that's worth commenting on. Suggest the README draft itself, or a doc with a small visible imperfection (typo, missing comma, awkward phrasing).
  - **Terminal** with a Claude Code session active, `--channels plugin:live-feedback@claude-live-feedback` on, sized so the channel-event line is readable.
- Loom set to record both windows (camera off; this is screen-only).

## Beat-by-beat

| Beat | ~Time | What Bryan does on screen | What Bryan says (script) |
|---|---|---|---|
| **1. Frame the problem** | 0:00–0:15 | Show the doc in the editor, scroll once, settle on a paragraph. | "When I review a doc with Claude, the loop is usually stuck in chat — alt-tab, paste text, describe what I meant, hope they pick the right line. This plugin closes that loop." |
| **2. Comment** | 0:15–0:30 | Highlight a sentence. Comment pill appears. Click it, type a one-line comment, post. | "I point at the line, leave a comment. Same surface I'm reading on." |
| **3. Channel event** | 0:30–0:45 | Cut to terminal. The `<channel source="live-feedback">` event line is visible. Pause for ~1s so the viewer can read it. | "Claude gets it as a channel event — same way it picks up GitHub mentions or CI failures. No polling, no inbox." |
| **4. Edit lands** | 0:45–1:15 | Cut back to browser. The agent's edit appears in the doc within a few seconds. Anchor highlight pulses on the changed range. | "And the edit shows up live. Anchors auto-shift, so my comment still points at the right spot. Whole loop is sub-second to a few seconds." _Voice-pass note (delivery time, not script time): "sub-second to a few seconds" reads honest in print but may feel stiff aloud. If it lands flat in the take, two natural alts that keep the honest band: "Whole loop is fast — fraction of a second to a few seconds" or trade precision for cadence: "Whole loop runs in a second or two."_ |
| **5. Close on the framing** | 1:15–1:30 | Static shot of the editor with the resolved comment + edit visible. | "Three surfaces — markdown, mockups, dev servers — all using this same loop. Repo's at github.com/fryanpan/claude-live-feedback-plugin if you want to try it." |

**Total active ~90s.** Loom usually stretches 10-15% with natural pacing. Aim to land 1:45–2:00.

## Voice notes (from `user_voice_and_values`)

- Don't say "synchronous human-AI pair-review" out loud — that's the README's framing, the video should *show* not *name*. The voiceover is descriptive of the action.
- "No polling, no inbox" is the strongest line — keep it.
- Avoid "leverage", "seamless", "delight", "magical", "powerful." These are the hype words that drift in by default; cut them on a re-record if they slip.
- Closing line is the only call-to-action. One repo URL. No "and don't forget to subscribe."

## Variations Bryan can pick from

- **Skip beat 1 (the framing)** if the README does the heavy lifting and you want a 60-second pure-demo. Open straight on the highlight-and-comment.
- **Replace doc with mockup** if the markdown surface feels too word-heavy. The mockup widget's element-anchored comments demo more visually. Tradeoff: less obvious that text auto-shifts under edits.
- **Add a side-by-side agent reasoning trace** if you want to show *why* Claude chose the edit it did. Adds 30s, makes the loop feel less black-box / more legible.

## Asks before recording

1. Pick the doc / surface for beats 1-2 (default: README draft itself). Wed sync.
2. Decide on opening framing line — Bryan's draft or the strawman above. Wed sync.
3. Writing Assistant voice-pass on the script (this doc). Pre-record.

## Distribution after recording

- Loom URL goes into the README's `## Watch the loop` section (new — currently absent in `README.draft.md`, will add post-recording).
- Optional: the README also gets a single static screenshot from the recording (beat 4, the "edit lands" moment) for GitHub README rendering since GitHub doesn't preview Loom inline.
