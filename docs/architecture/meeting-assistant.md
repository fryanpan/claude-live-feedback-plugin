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
them, retroactively, through both the tag rewrite and the text sweep; see
"A rename reaches backwards" below. The revision
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

## The bot path (Recall.ai) — Zoom and Google Meet

Added 2026-08-30. The microphone hears the room Bryan is in; a bot joins the
call everyone else is on. Everything after the words is the same pipeline:
same `MeetingStore` record, same `beginNotesSession`, same
`meeting.started` / `meeting.stopped` broadcasts. A bot meeting is not a
second kind of meeting — it is the same meeting with a different way of
hearing.

```mermaid
flowchart LR
  Doc["Doc: paste a meeting link"] -->|POST /api/docs/&lt;id&gt;/meeting-bot| API[RecallMeetingRelay]
  API -->|POST /api/v1/bot| Recall[Recall.ai]
  Recall -->|joins| Call["Zoom / Meet call"]
  Call --> Recall
  Recall -->|per-participant audio| AAI["AssemblyAI v3 streaming<br/>(inside Recall)"]
  AAI -->|transcript.data + partial_data| WS["WS /recall/&lt;token&gt;<br/>Recall dials US"]
  WS --> API
  Recall -->|bot.* status| Hook["POST /api/recall/status"]
  Hook --> API
  API -->|EngineTurn| Notes[MeetingNotesSession]
  API -->|settled turns| Store[MeetingStore]
  API -.->|meeting.bot| SSE[Doc SSE channel]
```

**What streams, and why not the audio.** Recall can forward raw per-participant
PCM (`audio_separate_raw.data`, 16 kHz mono S16LE), which would drop straight
into the existing engine seam. It is not what this uses. Instead Recall runs
**AssemblyAI Universal Streaming itself** —
`recording_config.transcript.provider.assembly_ai_v3_streaming`, with
`format_turns: true` and
`diarization.use_separate_streams_when_available: true` — and sends back
`transcript.data` / `transcript.partial_data` carrying the platform's own
`participant.name`. Same engine, same formatted-final contract, and the
per-track audio plumbing is the vendor's problem rather than a base64 decode
and N sockets on this server's critical path. `audio_separate_raw` is also
documented as "limited support"; the transcript stream is not.

**Diarization is off on this path, and that is the saving.** The microphone
path pays AssemblyAI's `speaker_labels` surcharge to guess which voice is
which. A bot does not have to guess: the platform already knows who is
speaking and says so on every event. So the $0.12/hr label surcharge is gone.

**What a bot meeting costs.**

| | per meeting-hour |
|---|---|
| Microphone, with speaker labels (today) | $0.27 |
| Bot: AssemblyAI, separate streams | $0.15 × speaking participants |
| Bot: AssemblyAI, one mixed stream (`RECALL_SEPARATE_STREAMS=0`) | $0.15 |
| Recall's own per-bot-hour fee | account pricing — not in the API docs |
| Notes + capture (Haiku, unchanged) | $0.84 |

AssemblyAI bills per streaming SESSION-second, so separate streams multiply by
the number of people who actually speak: a two-person call is about what the
microphone costs today, a four-person call about twice. The mixed-stream mode
is a flat $0.15 and attributes turns by correlating Recall's own speech
events, which is worse over crosstalk. Accuracy is the default; the cheap mode
is opt-out, because someone asking for "who said what" asked for the accurate
one.

**Names, not labels.** The pipeline's `speaker` is an opaque LABEL that
`speakerDisplayName` renders as "Speaker A" until a person names it. Putting
"Rowan Pike" in that field directly would render "Speaker Rowan Pike"
everywhere. So a bot meeting synthesises a label per participant (`p7`) and
NAMES it immediately with the platform's name — which means the record's name
map, the composer's display logic and the retroactive-rename machinery all
work unchanged, and a person can still correct a name the platform got wrong.
Two participants with the same display name are disambiguated at that seam
("Alex Yun (2)"), because composed notes carry no per-mention attribution and
the notes session correctly REFUSES to rewrite a name that means two voices.

**Turn numbers are invented here.** AssemblyAI's own stream carries
`turn_order`; Recall's does not. `recall-turns.ts` allocates them: a partial
opens a participant's turn, a final settles it, and a final on an
already-settled turn opens a NEW one **unless its words normalise to the same
string AND it arrives within two seconds** — which is the `format_turns`
double-final arriving as two indistinguishable events. Both halves of that
clause are load-bearing. Without the same-words half, the punctuated pass
becomes a duplicate turn. Without the two-second window, "Yes." said twice in
one conversation becomes one turn and the second answer is deleted outright.
Merging two different sentences would lose one, which is worse than a
duplicated punctuation pass; deleting a repeated one is the same loss wearing
a different hat.

The record takes the SECOND of a folded pair: a later transcript line with
words for a turn already written revises it in place (see Persistence), so
the durable transcript reads the punctuated way rather than keeping the rough
first draft forever.

**The first word starts the meeting; a terminal state ends it.** Not the
`bot.in_call_recording` webhook. The status channel and the word channel are
independent and either can be late; waiting for the report would drop the
opening sentences with no meeting to record them into. Conversely the vendor
socket dropping is NOT the end — Recall reconnects, and the call is still
going. This is the exact opposite of the microphone path's "the socket IS the
meeting", and the difference is that a bot's socket is a delivery route rather
than the meeting itself.

**Zoom's consent banner is Zoom's.** Native recording permission is not a
create-time flag: the bot joins, and
`POST /api/v1/bot/{id}/request_recording_permission/` asks the host — which is
what makes Zoom's own banner fire, so the room is told it is being recorded by
Zoom rather than by us. Asked once, Zoom only. The answer arrives as
`bot.recording_permission_allowed` / `_denied`, and
`automatic_leave.recording_permission_denied_timeout` stops a refused bot from
sitting in the call billing.

**Config.** `CLAUDE_WORKSPACES_RECALL_API_KEY` env, then Keychain
(`claude-workspaces-recall-api-key`) — the same order and the same reasoning
as the AssemblyAI key. `RECALL_REGION` picks the API host and a key is only
valid in its own region (a mismatch is a 401, which the client's error names).
`RECALL_PUBLIC_WS_BASE` is the one value that cannot be inferred: **Recall
dials this server**, and this server binds to localhost behind Tailscale, so
bots stay disabled until it names a publicly reachable `wss://` origin.
`RECALL_WEBHOOK_SECRET` verifies status webhooks (Svix HMAC); Recall publishes
no static IPs to allowlist, so that signature is the only proof available.
Retention is `{type: "timed", hours: 24}` by default — short, per the owner's
call. See `.env.example`.

**The AssemblyAI key for this path lives in Recall's dashboard**, per region,
not in this repo and not in the create-bot body. The Keychain key still serves
the browser-microphone path. Two places hold an AssemblyAI credential and they
are for two different paths.

**What is NOT here, deliberately.** No live word ticker for a bot meeting: a
bot's words have no socket back to the browser (the strip's words come down the
socket that sent the audio), and pushing them over the doc's SSE channel would
evict every real doc event from its 200-event replay buffer within a minute.
What a viewer sees is the bot's state and the notes composing themselves.
Calendar auto-join is also not here, and it is not a single config call: it
needs a Google/Outlook OAuth app, per-user OAuth consent, `POST /calendars`,
and a `calendar.sync_events` webhook consumer before any bot is scheduled.

**Load-bearing gotchas on this path**

- **A server restart loses a bot meeting's stream.** The per-bot token map is
  in memory, so a restarted process refuses the vendor's reconnect. `dispose`
  therefore takes every bot OUT of its call rather than leaving one recording
  into a socket nothing will accept — visible, rather than silently billing
  two vendors for nothing.
- **The `/recall/<token>` upgrade does NOT check Origin**, unlike `/audio/`
  and `/y/`. The caller is a vendor backend; there is no origin, and requiring
  one would refuse every real connection. The 128-bit per-bot token in the
  path is the authentication, and it is forgotten when that bot's meeting ends.
- **`assembly_ai_v3_streaming`, never `assembly_ai_streaming`** — the docs say
  the older name fails.

## Persistence

Append-only under `<dataDir>/meetings/<safeDocId>/`: one
`<meetingId>.jsonl` of settled turns (`{turn, text, ts, speaker?}`; a later
`{turn, speaker, ts}` line with no text relabels a turn already written, and
`speaker: null` there un-labels it; a later line WITH text revises the words
and REPLACES the turn on read, keeping the position it first settled in —
that is how the bot path's double final, rough then punctuated, lands as one
turn reading the punctuated way),
plus a `meetings.jsonl` index whose start/stop lines fold into one record
per meeting — and whose `{meetingId, speakers: {A: "Jordan"}}` lines fold
into the record's name map, last word wins. Nothing deletes; ids sanitized
`[^A-Za-z0-9._-] → _`.

**What the vendor keeps: nothing, and a 3-day floor under everything else.**
The account (owner, 2026-08-31, Workspace → Settings → Data Controls) is
opted out of model training with a 3-day TTL on audio and transcripts. The
opt-out is what makes Streaming — the only thing this subsystem uses — ZERO
retention of audio and transcripts, leaving just logging/billing metadata.
The TTL caps AssemblyAI's ASYNC side at 3 days instead of the 30-day default,
which is belt and braces here: this repo makes no `POST /v2/transcript` call,
and on 2026-08-31 the account listed zero stored transcripts. Both are
ACCOUNT settings, not session parameters, so no code here can set or assert
them — `bun run scripts/assemblyai-retention-sweep.ts` is how you re-check
what is actually stored, and deletes anything found (`--delete`); the
mechanics it has to get right are in
`packages/server/src/assemblyai-retention.ts`.

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

**Two voices with the same name narrow the rewrite, they no longer refuse
it.** Display text used to be the only handle the notes gave, so if both A
and B were called "Alex", "Alex" in the notes did not say which and
correcting A to "Sam" would have silently reattributed B's words; the session
detected that and skipped the retroactive part entirely. Tagged mentions have
their own handle — the label in the href — so the tag rewrite runs
unconditionally and only the UNTAGGED text sweep is skipped when the display
name is ambiguous (`rewriteUntagged: false` on the relabel). The session
still reports through `onError`, now saying the rename reached only tagged
mentions. The forward mapping always held: that voice's later turns compose
under the new name.

### Speaker tags: attribution the notes can carry

A tag is a markdown link whose href names the voice —
`[@Devi](speaker:B)` — so the visible half is the name and the durable half
is the LABEL (`packages/core/src/speaker-tags.ts`). The shape was chosen
because a meeting doc is a live Yjs doc that flushes to a `.md` on disk: a
link is ordinary markdown and an ordinary Yjs `link` mark, so attribution
survives the round trip and rides through an edit the way bold does. A mark
invented for this would have been lost on the first flush.

- **The composer proposes, the server disposes.** Tags come back from an LLM,
  so every composed section passes `normalizeSpeakerTags` before it reaches a
  doc: a tag naming a label the meeting never carried is unwrapped to plain
  words (and reported), and a tag naming a real one is re-rendered from the
  name map rather than trusted to spell it. Same law the task capture's
  `requester` is held to — a model-claimed attribution must name something
  the tick's own transcript contained. Lines a PERSON wrote are passed
  through byte for byte, because the merge recognises them by exact text.
- **A rename is keyed on the label, never the spelling.**
  `retagSpeakerInNotes` walks the notes section's `Y.XmlText` nodes and
  rewrites the text of every run whose link href is `speaker:<label>`,
  in place, marks preserved — which is what makes two voices called Alex
  separable where the display-text sweep could not tell them apart. It runs
  AFTER the untagged sweep, and that order is load-bearing: an extension
  rename ("Devi" → "Devi Raman") leaves the old name inside the new one, so a
  sweep running second would find "Devi" inside the "@Devi Raman" the retag
  had just written and make it "@Devi Raman Raman". Sweeping first, the retag
  that follows canonicalises every tag for the voice and finds most of them
  already right. Contiguous delta ops sharing the tag's href are coalesced
  into one run before replacement, because a tag with an inner mark — half
  its name bolded — reaches Yjs as several ops and would otherwise be
  rewritten once per op.
- **A name loses its brackets on the way into a tag.** A display name is free
  text somebody typed, and a tag is a link: "Sam [PM]" written between the
  brackets produces `[@Sam [PM]](speaker:C)`, which no longer parses as a tag
  at all — the finder cannot see it, so every later rename silently reaches
  nothing and the attribution is frozen on that spelling. `speakerTagText`
  removes `[`, `]` and `\` for the tag only; the roster and the strip still
  show the name as typed. Removed rather than backslash-escaped because
  escaping is only safe if every writer escapes, and one of the writers is
  the doc serializer, which wraps EVERY link's text in brackets and escapes
  none of it — a pre-existing bug worth fixing on its own, but not one this
  feature should depend on. A name that cannot break the syntax is safe
  whichever path writes it. Found in the browser, reassigning a mention to a
  seeded "Sam [PM]"; the unit tests had only ever used plain names.
- **A suggestion may not re-attribute a person's note.** `canSuggestOn`
  refuses a rewrite that introduces a speaker label the target did not
  already carry, so the composer cannot attach a line someone typed to a
  voice in the room.
- **The editor renders a tag as a quiet chip, not a link.** Tiptap blanks an
  href whose scheme is not in `protocols`, so the Link extension is
  configured with `speaker`; `safeLinkHref` refuses the scheme, so a tag
  never navigates. Clicking one opens the reassign menu instead.
- **Correcting a tag is one mention, always** (owner's call, 2026-08-31:
  *"reassigning should just affect the one item being reassigned"*).
  `speaker-reassign.ts` rewrites the link mark under the finger and nothing
  else — not the turn, not that voice's other notes. The larger gestures
  ("…and every other note from this turn", reaching back into the
  transcript) are each a different promise about scope, and the narrow one is
  the promise nobody has to think about before tapping. The menu offers the
  voices from `speakerRoster` — the meeting's cast, each with the last thing
  it said, because "Speaker A" identifies nobody — plus *Nobody — this is not
  a quote*, which takes the claim off and leaves the words. It is a popover
  on a pointer and a bottom sheet under 560px.
- **The correction is an ordinary document edit**, dispatched through the
  editor the person is already in: same Yjs sync, same undo, same ~1s flush
  to the `.md`. Nothing about it reaches the server as a special verb, and a
  correction made a week after the meeting works exactly like one made
  during it — which is why the menu is mounted whatever the doc, rather than
  alongside the strip.

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

## Acting on speech, not only recording it

Two more intents ride the SAME capture call — no router, no second pass, per
the 2026-08-30 decision *"One call per tick carries every intent"*. One reply,
one `items` array, a `kind` per intent, rows parsed independently so a
malformed one never costs the others. The module is still called
`meeting-task-capture.ts`; its name predates half of what it carries.

**They are not symmetrical, and that is the design.** A LOOKUP only reads, so
a wrong one costs a link nobody wanted. A RESEARCH ask SPENDS — an agent goes
away and burns tokens on a report — so it is never acted on from speech
alone.

### "Go look into that" — research, confirmed before it is spent

The ask this catches almost never contains the word *research*: it is "go
look into that", "dig into why it does that", "find out what it would take".
So the prompt teaches the shape rather than the word, and the guard is the
transcript, not the model: `phraseSpokenOnTick` requires the returned topic's
significant words to have actually been said (two of them, or its only one),
which is the `requestMatchesCandidate` threshold and holds for the same
reason. A topic with no significant words at all — "that thing" — is dropped
rather than let through on an empty match.

What lands is **a row in triage plus a decision review item**, and the
confirmation is enforced rather than promised:

- **Triage is not a band.** Dispatch runs goal bands in priority order and
  never reaches triage, so nothing can pick the row up even before anybody
  answers. The row is deliberately filed with no `goal` — a band would make
  it dispatchable the moment the item was answered *either way*.
- **An open review item holds the row.** `ready-gate.ts` reports
  `awaiting-answer` for a row carrying an unanswered item.

Answering it needs no new machinery: `decision.answered` already wakes the
board's lead through `ReadyWorkNudger.reviewAnswered`. A second ask for the
same topic — in the same tick or a later one — links the row rather than
filing a second card, on the board's own find-or-create.

`addReviewItem` emits no store event by design, so the caller owes the item
two steps this module cannot reach: `taskProjection.ensureWorkspace` and
`announceTaskReview`. That is the `onReviewFiled` callback, and it is the
contract `proposeAllowRule` (allow-rules.ts) already honours. Filing through
the store rather than the HTTP route also means the item skips the LLM
quality gate, exactly as an allow-rule proposal does.

### "Pull in last week's notes" — lookup

Resolution lives in `meeting-lookup.ts`, and reaches docs and past meetings,
not only board rows:

1. **By title** — the board's docs (huddles included: a huddle IS a doc,
   filed on the board like any other) and its task rows, in ONE pool through
   `resolveByTitle`, the matcher voice navigation already uses. One pool so
   its spoken kind word ("the DOC about x") can narrow.
2. **By when** — "last week", "yesterday", "Tuesday", "the last meeting",
   against the docs that carry a past meeting, newest inside the window.

**Recency is its own path because a past meeting has no title.** A
`MeetingRecord` carries times and no subject; the readable name of one is the
doc it was held on. So "last week's notes" has nothing to match against —
"notes" matches every doc on the board and "week" is a stopword — and time is
the only thing spoken that identifies it. An ambiguous title match falls
THROUGH to recency rather than failing, because two docs that score alike are
exactly what a spoken "yesterday" was there to separate.

**What the link may say about *when*** is not free either. A doc found by
recency may be labelled in the speaker's own frame ("last week") — the window
is what selected it. A doc found by NAME gets a plain date, because a doc
that matched on its title may not be from last week at all, and echoing the
phrase would put a date in the notes that nothing checked.

The composer gets these as a second link block beside the task links
(`docLinks` on `NotesComposeInput`), told to cite them where the note asked
and explicitly NOT to summarize what is inside — it has not read them.

### Cost

Both intents are prompt text on a call that was already being made.
Measured with `count_tokens` on the capture model
(`scripts/intent-prompt-cost.ts`), the system prompt goes **482 → 630 → 716
input tokens**: **+148 for research, +86 for lookup, +234 per tick**. At ~200
ticks per meeting-hour and $1/MTok that is **≈ $0.047 per meeting-hour**,
taking the measured $0.84 to about **$0.89**. Roughly twice the decision's
~58-tokens-per-intent figure, because both rules carry the example phrasings
that teach an ask nobody states explicitly — which is the feature. Output is
unchanged on the ticks that carry neither, which is most of them.

## Measuring the latency (`?timing=1`)

**How long a spoken word takes to become a word on the screen, and which hop
spent it.** Off by default and costing nothing when off: without the flag the
server allocates no ledger, reads no clock per audio chunk, and the wire is
what it always was. Add `?timing=1` to a doc's address, start a meeting, and
talk; a readout appears under the strip with the running p50/p95 and a CSV
button. Nothing is sent anywhere — the samples live in the tab until someone
downloads them, and no transcript text, doc id or path enters a sample, a
column, or Sentry.

The eight legs, in the order the time is spent: **capture** (waiting for the
100ms frame carrying the word to close, uniform 0–100 by construction) ·
**uplink** · **queue** (held on the server before the engine had a session —
zero except at the very start of a meeting) · **vendor** · **serverOut** ·
**downlink** · **render** · **paint**. They sum to **total**, spoken to
painted.

- **The correlation key is the AUDIO OFFSET, never the text.** Audio goes up
  as raw PCM with no sequence number in it, so there is nothing in a frame to
  echo back — but every `Turn` reports its words with `start`/`end` in
  milliseconds of the engine's stream, and the server knows how many bytes it
  had forwarded when it forwarded each chunk. A word's offset therefore names
  the chunk that carried it arithmetically, with nothing added to the wire.
  Correlating on text would break on the one thing this pipeline exists to do:
  revise a word after it is already on screen.
- **The ledger is written BEFORE the chunk is forwarded.** An engine may
  answer inside the very `send` that fed it, and a turn arriving then would
  resolve to the PREVIOUS chunk — understating the vendor by a whole frame.
  The server suite drives a synchronous engine precisely to hold that line.
- **Two clocks, and what survives them.** The browser and the server are
  synced by an NTP-style `timing_ping`/`timing_pong` exchange (a burst at the
  start, then a drip; lowest round trip wins). An error in the estimate moves
  time BETWEEN uplink and downlink and cancels in their sum, so `total`, the
  vendor leg and every server-internal leg are exact regardless — only the
  up/down SPLIT is indicative. Read it that way.
- **The headline is PARTIALS.** A partial is the newest word reaching the
  screen, which is the experience being measured; a final arrives after the
  engine has decided the turn ended and re-punctuated it, so it is slower by
  construction and is counted separately.
- **Paint is a frame after rAF, not rAF.** `requestAnimationFrame` runs
  BEFORE style, layout and paint, so marking inside it would time the work up
  to the frame and call it painted.
- **A handshake long enough to drop audio turns the measurement OFF.** The
  relay's opening buffer is bounded, and the two sides count frames
  independently — the browser numbers what it sent, the ledger what we
  forwarded. One dropped frame and every later ordinal names different audio,
  so from that point the relay attaches no blocks at all. The readout going
  quiet on a pathological start is the design; a plausible wrong number would
  not be.
- **What it does NOT separate.** The vendor leg is one number: the network
  round trip to AssemblyAI is inside it, and nothing the vendor sends carries
  a wall clock to subtract. Microphone and device input latency are before the
  first mark and are not in `total` at all.

Code: `packages/core/src/meeting-timing.ts` (the arithmetic, shared) ·
`packages/markdown-app/src/meeting-timing-client.ts` (the browser marks, the
readout, the CSV).

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
`packages/server/src/meeting-lookup.ts` (what a "pull that in" ask points
at) · `packages/server/src/meeting-notes.ts` + `meeting-notes-doc.ts` (composer +
doc sink; the two clocks live in `createPauseTicker`) · `packages/server/src/meeting-notes-merge.ts` (the merge that
keeps a person's writing) · `packages/markdown-app/src/meeting-strip.ts`
(UI) · `packages/server/src/recall.ts` (vendor client) ·
`recall-turns.ts` (frames → turns, naming) · `recall-status.ts` +
`recall-webhook-auth.ts` (bot state, signatures) · `recall-meeting.ts` (the
bot lifecycle) · `packages/core/src/meeting-bot.ts` (wire contract) ·
`packages/markdown-app/src/meeting-bot-row.ts` (UI) ·
`packages/core/src/meeting-timing.ts` +
`packages/markdown-app/src/meeting-timing-client.ts` (the `?timing=1`
latency measurement).
