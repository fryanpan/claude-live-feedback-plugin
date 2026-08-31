# Meeting assistant

**Goal:** a person opens a doc, presses one button, and talks. Words appear
live in a compact strip while they speak; meeting notes compose themselves
into the doc at the natural pauses in the conversation — and, when there are
none, at least every fifteen seconds. The transcript is
durable; the doc body stays the person's own writing plus the notes section.

Shipped 2026-08-28 (capture PR #408, notes PR #410). This doc is the summary
to read before touching the subsystem — the code's own header comments carry
the fine detail.

## Shape

```mermaid
flowchart LR
  Mic[Browser mic] -->|16kHz PCM16 frames| WS["WS /audio/&lt;docId&gt;"]
  WS --> Relay[MeetingRelay<br/>meeting-protocol.ts]
  Relay -->|audio| Engine[TranscriptionEngine<br/>AssemblyAI Universal Streaming]
  Engine -->|turns| Relay
  Relay -->|transcript frames| WS
  Relay -->|settled turns| Store[MeetingStore<br/>append-only JSONL]
  Relay -->|every turn| Notes[MeetingNotesSession<br/>pause + cadence composer]
  Notes -->|Yjs write| Doc[Doc "Meeting notes" section]
  Relay -.->|started/stopped only| SSE[Doc SSE channel]
```

- **The audio socket IS the meeting's lifecycle.** Every way the socket can
  end — clean stop, tab close, network drop — ends the meeting exactly once.
  `opening`/`ending` are real states because both ends of a meeting are round
  trips.
- **Nothing word-rate rides SSE.** Transcript frames return on the audio
  socket; only `meeting.started`/`meeting.stopped` broadcast to the doc
  channel. The SSE hub keeps 200 events for reconnect replay and a
  conversation emits that many words in about a minute — broadcasting
  partials would evict every real doc event.
- **The strip, not the doc.** Desktop: a bar along the bottom of the editor
  pane, reserved as a grid track so it can never cover prose. Mobile
  (≤720px): a stacked panel at the true bottom edge. The transcript never
  enters the doc body (tested); only composed notes do, through the same Yjs
  path every other writer uses.
- **Turns revise in place.** A `transcript` frame carries the WHOLE turn text
  and a `final` flag; a later frame with the same turn number replaces the
  earlier text, which is how a mis-heard word corrects on screen.
- **A capture says who is expected to be in the room, and pays for that.**
  `solo` is the default and the whole of the default: no diarization, no
  surcharge, one voice assumed. `conversation` is asked for, and it is the
  only thing that turns speaker labels on. The choice is made BEFORE the mic
  opens and cannot move while it runs — a streaming session's configuration
  is its connect URL — so the strip's switch is disabled for the length of a
  meeting and says to stop and start. Two ways in: the Board's "Record a
  conversation" button (the press IS the announcement — nothing else tells a
  server that two people sat down), which carries `mode=conversation` on the
  address beside `huddle=1`; and the strip's own "Detect multiple speakers"
  switch, for a doc already open. `ready` echoes back the mode the SERVER
  opened, so the strip reports the session being billed rather than the one
  it asked for, and the meeting record keeps it because it is what the
  meeting cost.
- **Who said it rides the same frame.** The engine's speaker label (`"A"`,
  `"B"`) travels as `speaker` on each transcript frame; the strip shows it as
  a muted tag at the head of the turn ("Speaker A"), and a tap on the tag
  names that voice for the meeting — every turn with the label updates, the
  strip sends `name_speaker` up the audio socket, the record keeps the name,
  and the notes composer reads it from then on AND the notes already written
  are rewritten to match ("A rename reaches backwards", below). Labels are
  per SESSION: the
  same letter is a different person next meeting, so the name map lives on
  the meeting's index line, never on the doc.

## Engine choice

Criteria (owner, 2026-08-27): latency first, accuracy second, cost/privacy
deferred; the word-ticker UX requires word-level streaming.

| Engine | WER | Word latency | Words | $/hr |
|---|---|---|---|---|
| **AssemblyAI Universal Streaming** (chosen) | 8.6% | ~300ms | immutable, word-level | 0.15 |
| Soniox U-3.5 Pro | 4.1–6.3% | ~150ms | phrase bursts | 0.45 |
| Deepgram | 15.6% | <300ms | mutable, word-level | 0.46 |
| OpenAI Realtime | unbenchmarked | — | phrase | ~1.02 |
| whisper.cpp (local) | ~7.4% | 1–2s chunks | chunk | 0 |

Only AssemblyAI and Deepgram do sub-300ms word-level; Deepgram carries ~2x
the errors. The engine sits behind the `TranscriptionEngine` interface
(`packages/server/src/transcribe.ts`) so a later switch is a new adapter,
not a rework.

**Speaker labels** (added 2026-08-29): `speaker_labels=true` on the same
streaming URL — supported on every streaming model, **+$0.12/hr** on top of
the $0.15 base (docs: streaming/label-speakers-and-separate-channels for the
parameter, assemblyai.com/pricing for both figures, re-checked 2026-08-30).
**Sent only for a `conversation` capture** (2026-08-30, owner: *"assume by
default that Bryan is alone"*): the parameter is absent — not `false` — on a
solo session, because an unpriced session is one that never asked.

**A meeting is a CHAIN of sessions, because a session ends at three hours.**
AssemblyAI closes one with code 3008 ("Session Expired: Maximum session
duration exceeded") and bills the full three hours
(streaming/common-session-errors-and-closures and the streaming API
reference, read 2026-08-30). There is no idle limit alongside it —
`inactivity_timeout` is optional and this adapter does not send one — so a
long QUIET session was never the risk; the wall was, and a solo working
session reaches it. A minute before the `expires_at` the engine gave in
`Begin`, the adapter opens the next session, waits for its `Begin`, moves
the audio across, and only then terminates the old one, whose flush still
delivers the sentence it was mid-way through. Two things it has to get
right, both tested: turn ids CONTINUE across the join, and a retired session
is TERMINATED rather than dropped (a socket merely closed leaves the session
open on their side, billed to the cap). Ids are the adapter's own, allocated
the first time a leg emits a given `turn_order` and then remembered per leg
— a fresh session counts from zero, and downstream a turn id is the identity
a transcript revises in place and the key the record is written under, so
the two legs must never name the same id. Allocating on first emission is
what makes that safe during the overlap: the old leg can still open a turn
while the new one is already carrying audio, and a base fixed at rollover
time would hand both of them the same number.
The two sockets overlap for one handshake and both are billed for it; that
is the price of not cutting a meeting in half at hour three.

**What a meeting costs.** Streaming is billed on the seconds the SOCKET IS
OPEN, not on the audio sent — silence in the room costs the same as speech,
and the meeting's length is the bill.

| | per hour | **per meeting-minute** |
|---|---|---|
| Universal-Streaming English (a `solo` capture) | $0.15 | $0.0025 |
| + speaker labels (a `conversation` capture) | $0.27 | **$0.0045** |

So labels add **$0.002 per meeting-minute** — $0.12 on a one-hour meeting,
against $0.15 the meeting already cost. Roughly a 1.8x transcription bill for
knowing who spoke, which is why the room has to be claimed rather than
assumed. The notes composer and task capture are separate Haiku
calls and are not in these numbers.

Each
`Turn` carries `speaker_label`; turns under ~1s of audio carry a placeholder
(`PENDING`/`UNKNOWN`) the engine adapter maps to "no speaker". A
`SpeakerRevision` arrives before `Termination` naming turns the whole-session
pass relabelled; the adapter re-emits those through `onTurn` as settled turns
with retained text, so the relay needs no second channel. A turn still
waiting on the pause tick takes the new label; notes ALREADY composed keep
the label they were composed with — those words are in the doc and the
revision has nowhere to land — but a person RENAMING a voice does reach
them, retroactively; see "A rename reaches backwards" below. The revision
can also take a label away (a
placeholder is "no speaker"), which the record writes as an explicit
`speaker: null` relabel line — an absent field would read as "says nothing
about the speaker" and leave an attribution the strip had already dropped.

**What diarization is actually proven by.** Every automated test drives the
MOCK engine, which returns labels a fixture chose. That covers the plumbing
end to end — label on the wire, in the record, in the composed notes, and the
rename that rewrites them (`meeting-e2e.test.ts`) — and it cannot show that
AssemblyAI separates two real voices, because no fixture can. The mock also diarizes ONLY when the open asked it to, which is what makes
the mode testable end to end: the same two-voice fixture comes back
unlabelled in solo mode, so the e2e proves the flag reached an engine rather
than proving the fixture has a `speaker` field. Run
`bun run scripts/diarize-check.ts` for the part no fixture can do: it speaks a two-voice script
through the real engine with two macOS `say` voices and prints the labels.
It needs a key, opens a metered session (~$0.001), and is deliberately not
part of any suite. As of 2026-08-30 the live half has NOT been run — no key
was reachable from the session that wrote it.

**Key wiring:** `ASSEMBLYAI_API_KEY` env, then Keychain
(`transcribe-assemblyai.ts` names the service). No key → the socket answers
`unavailable: not_configured` and the strip says so — a settled state, not
an error. `createServer` deliberately builds NO engine; only `bin.ts`
constructs a real one, so no test run ever opens a metered session.

## Persistence

Append-only under `<dataDir>/meetings/<safeDocId>/`: one
`<meetingId>.jsonl` of settled turns (`{turn, text, ts, speaker?}`; a later
`{turn, speaker, ts}` line with no text relabels a turn already written, and
`speaker: null` there un-labels it),
plus a `meetings.jsonl` index whose start/stop lines fold into one record
per meeting — and whose `{meetingId, speakers: {A: "Jordan"}}` lines fold
into the record's name map, last word wins. Nothing deletes; ids sanitized
`[^A-Za-z0-9._-] → _`.

## Notes composition

A tick triggers the composer, which sees the transcript so far plus doc title
and board task titles for context, and writes into the doc's "Meeting notes"
section via the Yjs fragment. The composer is an LLM call (Haiku) and
follows the same no-default seam as the engine: nothing that merely spins a
server up can reach an LLM.

**Two clocks fire a tick, and whichever comes first wins.**

- **A pause** — no new turn activity for `DEFAULT_NOTES_QUIET_MS` (4s).
  Partials count as speech in progress and defer it: every frame replaces the
  countdown.
- **The cadence ceiling** — `DEFAULT_NOTES_CADENCE_MS` (15s), started when the
  first unwritten sentence settles and **not** reset by speech. Added
  2026-08-30 (owner: *"waits too long to update notes"*), because the pause
  clock alone means a conversation where nobody stops for four seconds
  produces nothing until it ends. Measured on a scripted three-minute meeting
  (`scripts/notes-latency-check.ts`), sentence-settled to note-written went
  from a 43.0s median / 92.2s worst case to 8.7s / 15.0s, and the same script
  wrote 10 notes instead of 2.

**A tick is two Haiku calls** (compose + task capture), so the ceiling raises
the per-meeting LLM cost roughly in proportion to the extra ticks — five times
as many on the script above. Transcription is billed on socket-seconds and is
unchanged.

**A cadence tick carries settled turns only.** This engine's partials are
unformatted — punctuation and sentence casing arrive with `format_turns` when
the turn settles — so there is no finished sentence inside a partial to cut
at. A settled turn IS the unit of finished speech; the turn being spoken waits
for the next tick rather than being written mid-clause.

**The write is a MERGE, and a person can type in the section while it runs**
(owner, 2026-08-30: *"destroyed my notes"*). The old write deleted the whole
section and re-inserted the composed string, so every tick ate what he had
typed since the last one. Now (`meeting-notes-merge.ts`):

- The unit is an **item** — a top-level block, or one item of a list, because
  a bullet list is a single block and block granularity would hand the
  agent's whole list to the person who fixed one bullet.
- Ownership is a **ledger keyed by the Yjs element**, holding the markdown
  the agent left in it, held per doc in memory. An item is the agent's only
  if the agent wrote that element AND it still reads exactly as the agent
  left it. Both halves matter: text alone hands a person's element to the
  agent the moment they type a line matching one of its own, and element
  alone keeps calling a line the agent's after they rewrote it. Only agent
  items are ever deleted, and a person's item is never re-created — the same
  element stays in place, so its marks and anchors survive.
- **`previous` is the live section**, not the composer's own last reply, so
  the composer sees what the person wrote. The first tick of a session still
  composes from scratch — otherwise every meeting would continue the last
  one's notes. Human items are listed in the prompt as theirs to reproduce
  verbatim, and are gated on the same first-tick condition: on tick one they
  are the LAST meeting's lines, and "reproduce verbatim" would copy them in.
- **A changed version of a person's line becomes a suggestion**, not a
  rewrite: the redline marks in `suggest-ops.ts`, authored as "Meeting
  Assistant". The accepted state — what serializes to disk — stays his words
  until he accepts. One pending proposal per item; the marks are the
  registry, so the doc is where the duplicate check asks.
- **The stale-compose race** is caught with `basedOn`, the item list the
  compose read. An item missing from it arrived DURING the compose, so a
  collision with it is dropped rather than proposed; an item in it that has
  since left the doc is one he edited mid-compose, so anything the compose
  says that reads like it is dropped rather than inserted. `basedOn` holds
  KEYS — kind plus text — so turning a paragraph into a bullet without
  retyping it still counts as the edit it is. Nothing is lost — the composer
  returns the whole notes every tick.
- **A line the composer moved is not a new line.** Before an unmatched
  incoming entry is inserted, it is matched against the person's items that
  the diff did not line up with; an exact hit is the composer re-emitting
  their note somewhere else, and inserting it would leave two of it.
- **A ledger that claims nothing means "everything here is somebody
  else's"**, so a restarted server adds and stops replacing rather than
  claiming prose it has never seen.
- **An in-place agent edit has to tell the ledger.** The speaker rename below
  rewrites characters inside the agent's own lines rather than replacing
  them, so the ledger would stop recognising them and hand each one to the
  person. `reclaimAfterInPlaceEdit` snapshots what the ledger claimed before
  the edit and re-records exactly those elements after it — never a line the
  person had already made theirs.

### A rename reaches backwards (owner's call, 2026-08-29: "rewrite them")

Naming a voice mid-meeting fixes the notes ALREADY in the doc, not just the
ones still to come — a transcript where the same person is "Speaker B" above
the rename and by name below it was the thing to avoid. Three moving parts:

- `nameSpeaker` rewrites the session's `previous` — the composer's memory of
  what it wrote — so no later tick reintroduces the placeholder.
- A `NotesRelabel` goes to the sink, which calls `relabelNotesSection` on the
  doc. That is a **targeted in-place replacement**, not a section rewrite: it
  changes the exact token ("Speaker B") on word boundaries, only inside the
  notes section, carrying each site's marks. A rename is a two-word
  correction and costs two words.
- Both are queued on the **compose chain**, behind anything in flight. A
  compose that started before the rename read `previous` the old way and will
  return notes written the old way; the rewrite has to land after it.

**Why not `replaceNotesSection`.** It replaces the whole section from a
string the server composed, which would discard whatever the person had typed
inside the section since the last tick. Since the merge above, no tick
rewrites the section wholesale either — a rename must not become the one
remaining way for the note-taker to overwrite someone's writing. Everything
OUTSIDE the section is unreachable from this path however it is worded: the
tests fix a doc whose body says "Speaker B" three times and assert all three
survive.

Renaming an already-given name works the same way, because the rewrite reads
the OLD DISPLAY NAME (what the composer actually wrote), not the raw label —
"Devi" → "Devi Raman" replaces "Devi".

**Two voices with the same name refuse the rewrite.** Display text is the
only handle the notes give — composed prose carries no per-mention
attribution — so if both A and B are called "Alex", "Alex" in the notes does
not say which, and correcting A to "Sam" would silently reattribute B's
words. The session detects that (across every label SEEN, not just the named
ones — an unnamed B still reads as "Speaker B") and skips the retroactive
part, reporting it through `onError`. The forward mapping still holds: that
voice's later turns compose under the new name. Raised by review before
merge, not in the field.

## Task capture ("file a ticket for that")

Each pause tick ALSO runs a task-capture pass (`meeting-task-capture.ts`)
before the compose: a second Haiku call — same dedicated-key consent, off
switch `CW_MEETING_TASKS=0` — extracts explicit task requests and references
to tracked work from the new speech. Find-or-create is guarded
deterministically (a model-claimed reference must share words with the tick's
own transcript; a request that duplicates open work links the row instead of
twinning it), because a wrong link is worse than no link. The pass reads the
same speaker-prefixed transcript the composer does and may return a
`requester` for a request — guarded on the same law, so it must be a voice
that tick actually carried; the created row's body then says who asked,
which is the half of "who said what" a task can still answer a week later,
once the strip is gone.

**Each pass also reads the tail of the one before it**, marked as already
read — the boundary between two ticks falls where the room went quiet, which
is nowhere near where an ask ends. Measured live, both halves: "…that is the
real cost" / boundary / "can you file a ticket for that one?" filed a row
titled *"file a ticket for that one, a small spike would do"*, and "we should
file tickets for the next few things I mention" / boundary / the things
themselves lost the ask entirely. The window is the previous tick's TAIL —
180 characters, six turns, the newest line clipped rather than dropped — kept
raw so a voice named since then reads under its new name. Marking is what
stops a second filing: the prompt says those lines were read last pass and
that every item must draw part of itself from the new ones, and the board's
own find-or-create folds a re-file into a link to the row the previous pass
created. Both the guards and the model see exactly the same window, or the
reference guard would reject the very matches the overlap exists to enable.
Cost, measured on the capture model with `count_tokens` rather than estimated
(`scripts/capture-overlap-cost.ts`): **+92 input tokens per tick** at a full
window — 43 for the standing instruction, 49 for the speech.

New rows are
attributed to the `Meeting Assistant` agent actor and enter triage; a request
judged clear-and-doable goes to the chores band at `todo` and wakes the
board's lead through `ReadyWorkNudger.taskReady` — the composer never claims
`in-progress` itself. The composer receives the resolved links and writes
plain markdown links into the notes; the doc editor's `TaskLinkChips`
decoration (markdown-app) renders title + live status chip beside them,
refreshed on the board's `task.transitioned` SSE push, without ever touching
stored content.

## Load-bearing gotchas (each cost real debugging)

- **AssemblyAI `format_turns: true` ends every turn TWICE** at the same turn
  order (unformatted, then formatted). Settled means
  `end_of_turn && turn_is_formatted`. With formatting off, nothing ever
  reads as settled — a silent failure.
- **AssemblyAI auth is the bare key as the whole `Authorization` header** —
  no `Bearer` prefix.
- **A detached Yjs type reads as empty, and its children cannot be
  re-parented.** `parseMarkdownBlocks` hands back elements that belong to no
  document: serializing one returns nothing ("Invalid access: Add Yjs type to
  a document before reading data"), and moving a parsed `listItem` into a
  live list silently inserts nothing while every call reports success. Parse
  into a scratch `Y.Doc` to READ markdown, and build a `listItem` by hand
  (`listItem > paragraph > XmlText` + `insertTextWithMarks`) to WRITE one.
- **A speaker name is applied when a tick COMPOSES, not when it arrives** —
  the compose runs on the session's promise chain, so a name given right
  after the quiet timer fires still reaches that tick. Carried (failed)
  turns keep the raw label and are re-mapped on retry; mapping a display
  name twice would wrap it ("Speaker Jordan").
- **A pseudo-element tap target is eaten by a clip on ANY ancestor —
  including its own element.** Two review rounds were lost to this: the
  caption's `overflow: hidden` ate it, then the button's own `overflow`,
  added to give a long name an ellipsis, ate it again. It fails silently and
  measures 19px against the 36px floor. The target is now the button's own
  PADDING, which no ancestor property can clip away, and the button holds
  nothing that clips: the pill inside it carries every visual and the only
  overflow. Keep those two jobs on two elements. The caption still pads its
  clip box (and the mask is px-anchored to the window's top edge, so the two
  move together) because the clip box must still be at least as tall as the
  target.
- **A clipping inline-block's baseline is its BOTTOM MARGIN EDGE**, so the
  pill hung above the text with the line's descender space empty under it —
  the button was the size it was designed to be and still measured 34,
  sitting 4.3px above the clip. It also put the pill's top inside the mask's
  fade, so the label rendered washed out beside crisp words: one root cause,
  two symptoms. `vertical-align: middle` positions the box from its own
  margin box rather than from a baseline the overflow moves. Do not buy slack
  with more padding — at 430px the caption is two lines and a taller target
  reaches into the line above.
- **Assert the measured box, never the declarations.** The test for that
  floor passed through all three regressions in turn: it asserted the
  ingredients, then the box but not its clip, then the box and the clip but
  not the offset between them. It now computes the intersection of the button
  with the clip at both widths, and asserts the alignment its arithmetic
  assumes — a model whose premise is unasserted is the next silent pass.
- **A turn must be a block, or its tag strands.** Inline, a turn began where
  the last one ended and its tag landed at the end of the PREVIOUS visual
  line — above its own words, and on a phone that is the faded line being
  clipped away. A long turn still scrolls its own tag off the top, the same
  way its words scroll; that is the window being smaller than the turn.
- **Bun has ONE websocket handler per server.** Audio sockets are
  distinguished by `ws.data.kind`; the upgrade for `/audio/` sets it.
- **Audio frames must be COPIED, not viewed** — Bun reuses the receive
  buffer between messages.
- **Mic capture needs a secure context** (https or localhost). The strip
  detects plain-http and says so rather than hanging.
- **The `/audio/` upgrade checks Origin and refuses unknown docs** — CORS
  does not apply to websockets, and this socket spends money while open.

## Where things live

`packages/core/src/meeting.ts` (wire contract, incl. `CaptureMode`) ·
`packages/server/src/meeting-protocol.ts` (lifecycle) ·
`packages/server/src/transcribe-assemblyai.ts` (engine) ·
`packages/server/src/meetings.ts` (store) ·
`packages/server/src/meeting-notes.ts` + `meeting-notes-doc.ts` (composer +
doc sink; the two clocks live in `createPauseTicker`) · `packages/server/src/meeting-notes-merge.ts` (the merge that
keeps a person's writing) · `packages/markdown-app/src/meeting-strip.ts`
(UI).
