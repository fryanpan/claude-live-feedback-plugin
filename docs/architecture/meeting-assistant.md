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
- **A room capture announces itself, into its own microphone.** A
  `conversation` start speaks a fixed sentence out loud once the mic is open
  and the engine is receiving — so the announcement is in the captured audio
  rather than in a moment before the recording that nothing can show
  afterwards. One tap (`I'll say it`) hands the sentence to the person
  instead, and a device that cannot speak falls back to the same place. Solo
  announces nothing. See "The room is told" below.
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

**And capped.** `max_speakers` (1–10) rides beside it as a hard cap on how
many labels the session may ever hand out; past it, extra speakers merge into
the closest existing label (same doc page, read 2026-08-30). Absent, the count
is UNBOUNDED, and an unbounded diarizer in a room where two people share one
far-field microphone is free to answer a change of posture with a new letter.
The room's size is the browser's to know — nothing on the server can hear the
room — so it rides the `start` frame as `speakers`, clamped rather than
refused (an out-of-range value makes the engine refuse the whole session,
which reads as "transcription is broken"), and defaults to **2**. The docs
suggest a little headroom above the expected count; we do not take it,
because the failures are not symmetrical: a third voice merged into the
closest label costs one misattributed turn, an invented Speaker C costs the
reader their belief in the labels. `?speakers=3` on the doc address is how a
room that really holds three says so. A solo capture sends neither parameter.

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
waiting on the pause tick takes the new label; a turn whose words are
ALREADY in the doc is a correction, and reaches them — see "A late
correction lands on the mentions it can prove" below. A person RENAMING a
voice reaches them too, by a different route: through the tag rewrite and
the text sweep; see "A rename reaches backwards". The revision
can also take a label away (a
placeholder is "no speaker"), which the record writes as an explicit
`speaker: null` relabel line — an absent field would read as "says nothing
about the speaker" and leave an attribution the strip had already dropped.

**What the room's microphone does to all this.** Echo cancellation, noise
suppression and automatic gain control are tuned for one near-field talker:
AGC renormalises level continuously and noise suppression gates the quieter
part of the spectrum, so both act on exactly the cues — relative loudness,
timbre, near talker against far — a diarizer uses to tell two voices apart.
They are now one config, `ROOM_AUDIO_DEFAULT` in `meeting-audio.ts`, applied
only to a `conversation` (solo capture is untouched) and overridable from the
address: `?mic=ec1-ns0-agc0`, alongside `?speakers=N`. Both are facts about
the ROOM rather than one-shot gestures, so unlike `huddle=1` and `mode=` they
survive the reload.

**The default turns gain control off, and the number is why.** Scoring is
`scripts/room-labels-check.ts`, which scores a run against the script that was
actually read and prints its scoring settings beside every figure — a
diarization accuracy number moves by tens of points on those settings alone,
so one without them is not a number. Four ways in: `--doc <docId>` scores a
meeting already in the append-only record (no key, no cost, no audio needed);
`--audio` sends a file through the real engine; `--synthetic` builds a
two-voice fixture with `say` and ffmpeg — two distances, a shared reverb tail,
overlapping turns; and `--ami` scores an excerpt of a real meeting. `--mock`
runs the whole path with no key and no bill, and measures nothing.

`--ami` is what made the microphone matrix possible at all. The browser
applies these processors BEFORE the audio exists and this server keeps no
audio, so no recording of ours can be re-scored under other settings — the
matrix would have cost one recording per combination from a person. The AMI
Meeting Corpus (CC BY 4.0) publishes unprocessed far-field audio, and its
`Array1-01` channel is a SINGLE element of the array on the table: one
microphone, people around it, which is this subsystem's case. So the
processors can be approximated on top of it offline and the same seconds
scored under each. The excerpt is range-fetched into a cache outside the repo
— the channel is already 16 kHz mono PCM16, the meeting wire's own format, so
a byte offset is a time offset and 4.8 MB arrives instead of 40 MB.

Measured 2026-08-31, ES2002a, 120-second windows, through the real engine with
`max_speakers` set to the number of people in the window. The figure is
**reference words both transcribed AND attributed to the person who said
them, over every word said in the window** — the only one on the card that
does not move with how much a run attempted. Scored
`similarity=jaccard-words threshold=0.5 alignment=monotonic-dp-span
mapping=optimal-assignment unlabelled=excluded mixed=counted-wrong`:

| window | ec1-ns0-agc0 | ec1-ns1-agc0 | ec1-ns0-agc1 | ec1-ns1-agc1 |
|---|---|---|---|---|
| two people (590s–710s), 262 words | 16.4% | **34.4%** | 13.4% | 16.4% |
| four people (900s–1020s), 400 words | 27.3% | 29.5% | 31.8% | **49.0%** |
| speakers labelled, two-person window | 2 of 2 | 2 of 2 | 2 of 2 | 2 of 2 |
| speakers labelled, four-person window | 3 of 4 | 2 of 4 | 2 of 4 | 3 of 4 |

**Why that figure and not attribution accuracy.** Each setting produces a
different transcript and therefore covers a different amount of the script, so
a percentage over the covered part compares two numbers with different
denominators. It is not a small effect here: on the two-person window,
coverage ran from 66.0% (`ns`) to 86.3% (`agc`), and `agc` — the setting that
covered the MOST — attributed the least. Ranking on the covered-part figure
would have preferred whichever setting attempted least. The scorer now prints
coverage on every card and refuses the comparison out loud when two runs
differ by more than five points.

**Noise suppression on wins all four pairings** — both windows, gain control
either way. That one is neither close nor split.

**Gain control is split, and it appears to depend on how many people are in
the room.** On two voices it costs (13.4% against 16.4%) and cancels the whole
of noise suppression's gain (16.4% against 34.4%); on four it helps (31.8%
against 27.3%, and the best row of the eight). A mechanism fits both halves:
telling people apart on ONE microphone leans on how loud each of them is, so
removing that difference costs when two voices are already separable and pays
when four voices are unequal enough that the quiet ones are lost outright.

So `ROOM_AUDIO_DEFAULT` is `ec1-ns1-agc0`, chosen for the room this product is
FOR — two people with a device on the table — and not by a majority of the
eight numbers. A bigger room wants `?mic=ec1-ns1-agc1`, which is why the knob
is on the address. Solo keeps all three; it was measured by nothing here, and
the two defaults are separate constants so that moving one cannot move the
other.

**Echo cancellation is untested and stays on.** It cancels what the device's
own speaker is playing, and an AMI recording has no far-end signal to cancel;
no run here says anything about it either way. The honest reading of the table
is four rows about two processors.

**What the AMI numbers are and are not.** They are the real engine on real
far-field audio with human reference annotations. They are NOT the browser:
`afftdn` and `dynaudnorm` are ffmpeg approximations of WebRTC's processors,
doing the same job by a different algorithm, and the report labels every such
run `EMULATED`. Two windows of one meeting is a small sample; the four-person case is harder
than the product's, and it is the half that disagrees about gain control, so
the split above rests on one window each way. Bryan's own two-minute
recording is what confirms the direction on the case we actually ship; moving
the default back is one line.

Repeats matter more than they look. `--repeat n` runs the same audio n times,
prints every run and their median, and warns when the spread WITHIN one
setting is wide enough to swallow the gaps BETWEEN settings. Measured over 20
runs, each setting's own runs agreed to within 0.1 points of attribution — the
engine is near-deterministic on identical bytes — with the largest single
disagreement being one transcribed word, and one `ns` pair differing by 1.6
points of coverage. That was worth establishing: the first pass at this matrix
printed identical scores for two settings and read them as run-to-run noise. They were identical because the emulation had silently not applied
(zsh does not word-split an unquoted parameter, so `ns agc` arrived as one
unknown key, and the script dropped it while still printing `EMULATED`).
`emulate` now refuses a key it cannot apply.

**What the synthetic fixture showed.** `--synthetic` builds 22.5 seconds of
two macOS voices at two distances with a shared reverb tail and 150 ms of
overlap. Through the real engine with `max_speakers=2` it came back as three
run-on turns, all labelled A: **one voice where there were two.** That is a
result about the fixture as much as the engine — two TTS voices over a
synthetic tail are not a room — and it is the run that exposed a scorer bug
worth naming, because the harness scored that failure as "turn attribution
100.0%". One-line-per-turn alignment had matched each turn to its best single
line and dropped the rest. Alignment is now many-to-one, a turn spanning two
people is MIXED and never correct, and a person who never gets a label is
reported as NEVER DISTINGUISHED.

**That two real voices separate is now shown.** On the two-person AMI window,
every setting produced exactly 2 labels for 2 people, each mapping to a
different person, with nothing invented — on one far-field microphone. What
the attribution percentages say is where the remaining error is: 6 of 10
aligned turns ran across both speakers. The engine finds the people; it merges
across the change.

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
part of any suite. The live half HAS now been run (2026-08-31), by
`room-labels-check.ts` rather than by this script: see the AMI table above —
two real voices on one far-field microphone came back as two labels for two
people.

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
  Recall -->|bot.* status| Hook["POST /recall/status"]
  Hook --> API
  API -->|EngineTurn| Notes[MeetingNotesSession]
  API -->|settled turns| Store[MeetingStore]
  API -.->|meeting.bot| SSE[Doc SSE channel]
```

**Both callbacks come in on a hostname of their own** (2026-08-31).
`CW_RECALL_CALLBACK_HOST` names a dedicated first-level address
(`recall.<domain>`) pointed at the same tunnel with **no Cloudflare Access
application in front of it**, and both the websocket origin and the status
webhook URL are derived from it. It classifies its own host kind that serves
exactly `GET /recall/<token>` and `POST /recall/status` — each only while its
own credential is configured (the per-bot token, and `RECALL_WEBHOOK_SECRET`)
— and answers **404 to everything else**, including to a caller holding a
valid operator Access token.

This replaced two Access exemptions on the OPERATOR's hostname, which is the
address a person opens the product on; that hostname now has no bypasses at
all. With them gone, a deployment still deriving its callback URL from
`CW_PUBLIC_BASE_URL` would look configured while every callback was refused,
so meeting bots report themselves **not configured** when the address this
server would hand Recall is one of its own Access-gated hostnames. See
`packages/server/src/middleware/recall-callback-gate.ts`,
`unreachableCallbackReason` in `packages/server/src/recall.ts`, and the
"operator's own hostname" section of docs/product/sharing.md.

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
**Recall dials this server**, and this server binds to localhost behind a
Cloudflare Tunnel, so it has to be told the address something in front of it
answers on. That is `CW_RECALL_CALLBACK_HOST` — a hostname, and everything the
vendor is given is DERIVED from it (`recall.example.com` →
`wss://recall.example.com/recall/<token>` and
`https://recall.example.com/recall/status`) rather than configured separately:
two settings naming one host is two things to get wrong, and nothing reports
the disagreement — just a bot that records into a hostname nobody is listening
on. Unset, the derivation falls back to `CW_PUBLIC_BASE_URL`, the single
source of every link the server hands a human — but that hostname is
Access-gated with no exemptions, so bots there report themselves not
configured rather than bill for callbacks that will be refused. A fallback
base that is plain `http` disables bots rather than stream a meeting's audio
in cleartext; the callback host builds `wss://` by construction.

The status webhook URL is printed at boot for exactly one reason: this server
never calls it. It is configured at the vendor, workspace-wide, so the boot
log is the only place the right value is ever stated.
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
  the older name fails. It is also **not supported in `eu-central-1`**
  (docs.recall.ai/docs/assemblyai, FAQ), so `RECALL_REGION` and this provider
  are not independent choices: an EU region needs a different provider, not
  just a different key.
- **The AssemblyAI key goes in Recall's Transcription dashboard, per region.**
  Recall's regions are isolated, so the key is entered separately for each one
  (docs.recall.ai/docs/assemblyai, Setup). It is never in a request body and
  never in this repo.
- **Deriving the right URL is necessary and NOT sufficient — the hostname has
  to be one Access does not front.** `route()` classifies the request's Host
  and runs the Access verifier before any path match (`server.ts`, the
  `classifyHost` block), and Recall's backend can present no Access JWT, no
  share cookie and no proxied-trusted identity. Bryan's answer (2026-08-31)
  was a hostname whose whole surface is the two vendor paths, rather than two
  exemptions on the hostname that serves the product. Both paths already carry
  their own credential — a 128-bit per-bot token, and the Svix signature — so
  the unauthenticated surface is those credentials, not the API.

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

### A late correction lands on the mentions it can prove

The engine changes its mind about who spoke. A `SpeakerRevision` arrives
before `Termination` naming turns the whole-session pass relabelled, and
until now it reached only the turns still waiting on a tick — words already
composed kept the voice they were composed with, so a meeting could end with
its transcript and its notes disagreeing.

**A rename and a revision are different facts, and only one of them is about
a voice.** "B is Devi" is true of every mention of B, which is why the label
in the href was enough for it. "Turn 12 was not B after all" is true of one
turn, and `speaker:B` cannot say which of B's sentences a mention came from.

**So the href also carries the turns behind the mention** —
`[@Devi](speaker:B?t=10,12)`. Stamped by the deterministic pass, never by the
composer: the model's job is to say which voice, and everything a later
correction has to trust is supplied by code. A tag arriving WITHOUT
provenance is stamped with the tick's turns for that voice; one that already
has some keeps them, because the composer returns the whole notes every tick
and restamping would move a mention's provenance forward to words it was
never written from. Past `MAX_SPEAKER_TAG_TURNS` (12) nothing is stamped: a
mention that could have come from thirty turns is not one a revision can
place, and saying so is cheaper than pretending.

Then, per mention, every turn behind it is asked what it is attributed to
now — a revised turn answers with its new label, an untouched one with the
label the mention already carries:

- **all agree on another voice** → the mention MOVES. Not a guess: every turn
  that could have produced those words belongs to that voice now.
- **all agree on nobody** → the claim comes off and the words stay, the same
  remedy `normalizeSpeakerTags` gives a voice the meeting never carried.
- **they disagree** → the mention is marked `unsure=1` and the session says so
  through `onError`. It belongs to one of two voices and the notes do not
  record which; a coin flip would put a name against words somebody else
  said, and silence would hide that the meeting no longer stands behind the
  name already there. The chip draws it — the warning colour and a "?" — so
  the doubt is visible to a reader and not only to a reader of the raw `.md`.
- **no provenance** → untouched. That is every tag written before this
  existed and, deliberately, every mention a PERSON has reassigned:
  `applyReassign` writes a bare `speaker:<label>`, so a human answer is never
  revisited by a machine pass. It also makes tapping the voice a mention
  already claims a real edit rather than a no-op, which is how somebody
  settles an unsure one.

Three things the plumbing has to get right, each tested:

- **The correction rides the compose chain**, behind anything in flight —
  same reason as the rename. That compose read the old labels.
- **One chain step per BATCH.** The engine sends a single `SpeakerRevision`
  and the adapter re-emits it turn by turn in a synchronous loop. Applied one
  at a time, a two-turn mention would be moved by the first revision and then
  found disagreeing with itself by the second.
- **A turn that has fallen back into `carry`** — its compose failed — leaves
  the batch and takes the new label into its retry. Correcting words nobody
  has read is nothing.

**In the doc the walk is scoped to the items the LEDGER still claims**, which
a rename is not. What a voice is called is true wherever it is written; a
machine's second thoughts about who spoke do not get to edit a sentence a
person has taken over. The same boundary keeps this off an EARLIER meeting's
leftovers in the same doc, whose turn numbers start again from the beginning
and could otherwise collide with this meeting's.

What this still cannot do: a turn the revision gives a label to for the FIRST
time (a `PENDING` placeholder resolving) composed as untagged prose, and there
is no mention to move — the notes gain no attribution they did not have.

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

Three more intents ride the SAME capture call — no router, no second pass, per
the 2026-08-30 decision *"One call per tick carries every intent"*. One reply,
one `items` array, a `kind` per intent, rows parsed independently so a
malformed one never costs the others. The module is still called
`meeting-task-capture.ts`; its name predates most of what it carries.

**They are not symmetrical, and that is the design.** A LOOKUP only reads, so
a wrong one costs a link nobody wanted. A RESEARCH ask SPENDS — an agent goes
away and burns tokens on a report — so it is never acted on from speech
alone. A CORRECTION does neither: it *changes something already written*, so
it is the only intent whose guard cannot be finished in the capture pass at
all.

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

- **The row is never set moving.** Dispatch works `todo` rows; this one stays
  at `triage`, unvetted until a person places it, the way every other
  agent-filed row is. It is filed asking for no band — but note that the
  store fills `chores` in anyway (`opts.goal ?? CHORES_GOAL_ID`), so the
  absent band is *not* what protects it. An earlier draft of this section
  claimed it was, and the integration test against the real store said
  otherwise.
- **An open review item holds the row.** `ready-gate.ts` reports
  `awaiting-answer` for a row carrying an unanswered item, so it stays held
  even once somebody triages it.

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
2. **By when** — "last week", "yesterday", "Tuesday", "this morning", "the
   last meeting", against the docs that carry a past meeting, newest inside
   the window.

**Recency is its own path because a past meeting has no title.** A
`MeetingRecord` carries times and no subject; the readable name of one is the
doc it was held on. So "last week's notes" has nothing to match against —
"notes" matches every doc on the board and "week" is a stopword — and time is
the only thing spoken that identifies it. An ambiguous title match falls
THROUGH to recency rather than failing, because two docs that score alike are
exactly what a spoken "yesterday" was there to separate.

**Two things about the windows themselves**, both found in review rather than
in writing. Each part of a day is its own window — morning, afternoon and
evening do not collapse into "today" — because the resolver answers with the
NEWEST meeting inside a window, so a single all-day window would answer "what
did we say this morning", asked after lunch, with the lunch meeting. And every
boundary is a calendar operation (`setDate`, `setHours`), never a multiple of
86,400,000 ms: a local day is 23 or 25 hours twice a year, and on those two
days fixed arithmetic lands "yesterday" at 01:00 or 23:00 of the wrong date,
putting a meeting held near midnight into the day next door.

**What the link may say about *when*** is not free either. A doc found by
recency may be labelled in the speaker's own frame ("last week") — the window
is what selected it. A doc found by NAME gets a plain date, because a doc
that matched on its title may not be from last week at all, and echoing the
phrase would put a date in the notes that nothing checked.

The composer gets these as a second link block beside the task links
(`docLinks` on `NotesComposeInput`), told to cite them where the note asked
and explicitly NOT to summarize what is inside — it has not read them.

### "No, I said Thursday" — a correction of a note already written

Correcting the note-taker out loud is how a person naturally fixes a note.
Before this, it added a second note and the doc held both, disagreeing.

**Why it is not left to the composer.** The composer already revises — it
receives the whole notes and returns the whole notes, and its prompt tells it
to "correct earlier notes the new speech overturns". What it cannot be is
*relied on*: the output is a section rewritten from a model's reading, so the
same ask lands as a fix on one tick and as an extra bullet on the next, and
either way the merge reconciles a section that changed everywhere. A person
saying two words wants two words changed. So a correction is a **targeted,
in-place replacement** — the same mechanic as the speaker rename above, for
the same reason.

**The two halves are vouched by different things, and that is the design.**

| half | vouched by | why not the other one |
|---|---|---|
| the corrected words ("Thursday") | the transcript window | they were just spoken; `correctionSpokenOnTick` can ask |
| the mistaken words ("Tuesday") | the **notes** | by the time anybody corrects a mishearing, the tick that carried it is usually outside the ~180-char overlap window |

Vouching the mistaken half against the notes is *stronger* than a transcript
check, not weaker: the phrase must sit in exactly one note, and that
resolution is what makes the correction land on something real. A phrase the
model invented matches nothing and is dropped.

**More than one match is a drop.** Three notes saying "Tuesday" and a person
saying "no, Thursday" is not a correction anybody can execute — fix the newest
and two stale ones remain and the choice looks arbitrary; fix all three and
the edit is wider than the words asked for. Ambiguity drops, the way every
other reading in this pipeline drops what it cannot prove.

**Whose note it is decides the verb.** Ownership is the merge ledger's: the
agent may revise only an item it wrote *that still reads as it left it*.

- **an agent note** → rewritten in place, under `reclaimAfterInPlaceEdit`, so
  the ledger learns the line's new wording and the note-taker keeps owning it.
  Without the wrapper the correction would hand every line it fixed to the
  person and the notes would freeze at the correction.
- **a person's note** — one they wrote, or one the agent wrote and they have
  since edited — → a **redline suggestion** on the phrase, the same
  `suggestOps` path the composer uses when it wants different words in
  somebody's line. Accepting it is their move. One pending proposal per item:
  somebody who has not answered the last one does not collect a fresh copy
  every tick.
- **both carry the phrase** → the agent's own note wins, and theirs is left
  alone. Not a tiebreak so much as the definition: the note the correction is
  about is the one the assistant wrote from the mishearing.

**A site inside a speaker tag is refused outright.** Rewriting the text of
`[@Devi](speaker:B)` while its href still names voice B would leave the tag
claiming B is called something B is not. Attribution moves by the reassign
gesture, never by a correction of the words around it — the same law
`attributesToNewVoice` holds the composer to from the other side. The words
*beside* the tag in the same note are still fair game.

The refusal keys on the `speaker:` scheme, so it holds for a tag carrying its
provenance (`speaker:B?t=10,12`, and the unsure form) exactly as it does for a
bare one — and a revision beside such a tag leaves the whole href, query and
all, as it found it. That matters in one direction in particular: the turn
list is what [a late correction](#a-late-correction-lands-on-the-mentions-it-can-prove)
reads to decide which mentions move, so a correction that truncated it would
leave the mention looking untouched and quietly unmovable.

**Ordering inside the tick is load-bearing.** The correction reaches the doc
**after the capture pass and before the section is read** for the compose. The
note it fixes was written on an earlier tick and is already in the doc, so
correcting first means this tick's compose reads the corrected words as
`previous` — and the merge never has to reconcile a note the composer echoed
back in its old wording.

**A correction and a self-correction are different things.** Somebody who
changes their mind ("actually, let's do Thursday") is speaking, and the
composer revises the notes for it as it always has. The prompt rule spends
most of its tokens on that distinction, because it is the one that decides
whether this intent is useful or a nuisance.

### Cost

The three intents are prompt text on a call that was already being made.
Measured with `count_tokens` on the capture model
(`scripts/intent-prompt-cost.ts`, on a fixture tick carrying all three), the
prompt goes **501 → 649 → 735 → 888 input tokens**: **+148 for research, +86
for lookup, +153 for correction — +387 per tick.** At ~200 ticks per
meeting-hour and $1/MTok that is **≈ $0.077 per meeting-hour**, taking the
measured $0.84 to about **$0.92**.

Roughly two to three times the decision's ~58-tokens-per-intent figure,
because each rule carries the example phrasings that teach an ask nobody
states explicitly — which is the feature. Correction is the priciest of the
three for the same reason it is the most likely to misfire: most of its rule
is the line separating a correction from somebody changing their mind. Output
is unchanged on the ticks that carry none of them, which is most of them.

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

## The room is told, and the telling is in the recording

Shipped 2026-08-30. **In-person captures only** — a Zoom or Meet bot gets its
consent from the platform's own recording banner, and a second announcement
over the top of that one would be noise.

A `conversation` capture is by definition the one with other people in it, so
it says so out loud. Bryan's decision was the **hybrid**: the device speaks by
default, and one tap hands the sentence to the person instead. Both are on the
strip as start buttons — `Start` and `I'll say it` — and the second appears
only while a `conversation` capture is idle, because a solo capture has nobody
to tell and a running one has already told them.

**The order is the whole feature, and it is the opposite of the intuitive
one.** The microphone opens FIRST and the sentence is spoken into it:

```mermaid
sequenceDiagram
  participant P as Person
  participant S as Strip
  participant M as Mic
  participant R as Relay
  P->>S: tap Start (conversation)
  S->>S: announcer.prime() — SYNCHRONOUS, spends the gesture
  S->>M: getUserMedia + AudioWorklet
  M-->>S: frames
  S->>R: start {mode}
  R-->>S: ready (engine is receiving)
  S->>S: speechSynthesis.speak(RECORDING_ANNOUNCEMENT)
  Note over M,R: the sentence is spoken INTO an open mic —<br/>it rides the same frames as everything else
  S->>R: announced {by: "device"} — only now
```

Announcing before the mic opened would leave the sentence in a moment nothing
recorded, which is exactly the thing an announcement cannot be: the point is to
be able to show it afterwards, in the transcript. So the `ready` frame is the
trigger — `ready` means the engine is receiving, and everything from there is
in the transcript.

**Not at socket-open, and that is a deliberate trade.** The relay buffers audio
that arrives while the engine handshake is out (`conn.pending`, 256 chunks), so
speaking at socket-open would land in the recording too, and land *earlier* —
anything said in the room during the handshake is captured ahead of the
announcement, which is a real if small ordering cost. What it would buy in
exchange is the risk of telling a room it is being recorded when it is not:
before `ready`, the socket can still answer `unavailable` — no key configured,
or another tab already holding this doc — and a false announcement to a room is
worse than a few hundred milliseconds of ordering. So the claim here is that
the announcement is IN the captured audio, never that it is the first thing in
it.

**Why there is a prime step.** On iOS Safari — Bryan's main device —
`speechSynthesis.speak()` is ignored unless it is reached from inside a user
gesture's own task. The announcement cannot be spoken there, because it has to
wait for `getUserMedia`, by which point the gesture is spent. So the tap spends
its gesture on one silent utterance, which unlocks the queue, and the real
sentence rides that unlock later. Same trick an `AudioContext` needs, same
reason.

**The sentence is a constant and is not localized.** `RECORDING_ANNOUNCEMENT`
in `packages/core/src/meeting.ts`. Fixed because it is the thing anyone would
later be asked to show, and deliberately passive about who is recording — the
same words are correct in the device's mouth and in a person's, and a sentence
that only worked in one would need a second sentence for the other.

**The claim is never on the `start` frame**, and this is the one thing here
that a review caught rather than the design getting right first time. A
capture that announced its intention when the microphone opened would leave
`announced: 'device'` standing on a meeting somebody stopped four words into
the sentence — the record asserting the room was told, about a room that heard
half a sentence. So `announced` is its own frame, sent after the fact:
`device` only once the browser reports the utterance FINISHED, `spoken` the
moment the sentence goes on screen (which is the whole of what `spoken` ever
claims). A meeting that ends before either leaves the field absent, and that
is the correct answer rather than a gap.

**What the record claims, and what it does not.** `announced` on the meeting
record is `'device'`, `'spoken'`, or ABSENT.

| value | what it means |
|---|---|
| `device` | the browser reported the utterance finished |
| `spoken` | the sentence was PUT ON SCREEN for a person to read |
| absent | nothing is claimed — a solo capture, a meeting stopped mid-sentence, or a client too old to say |

`spoken` is the weaker claim and the code never treats it as more: the client
knows it displayed the sentence and cannot know anybody read it. Absent is
never a quiet default either — `parseAnnouncedBy` answers `undefined` for
anything it does not recognise, because the permissive direction would write a
consent record out of a typo.

**A device that cannot speak falls back and CORRECTS the record.** No synthesis
engine, a refused gesture, and an utterance that is accepted and then never
fires `end` or `error` (a real browser bug, hence the 12s timeout in
`meeting-announce.ts`) are indistinguishable from the strip and all end the
same way: the sentence goes on screen for a person, and the `announced` frame
that goes up says `spoken` instead. A record claiming the device announced it
when the device said nothing is worse than one that claims less. The index
folds `announced` last-word-wins, the same rule the speaker names fold under,
so a `device` that is later corrected to `spoken` reads as `spoken`.

**The sentence a person has to READ holds the caption line.** The strip has
one line, and a partial transcript normally takes it — which for the `spoken`
path means any noise in the room can wipe the sentence out from under somebody
mid-read, a moment after it appeared. So the `I'll say it` prompt is a
*dismissible button* that holds the line: transcript turns accumulate but are
not drawn until a SETTLED turn arrives (a whole utterance finished — the
earliest evidence the sentence has been said) or the prompt is tapped away.
Nothing is lost while it holds; the rolling window draws as soon as the line
comes back. The device's own caption does NOT hold, because it is a courtesy
for something the room is already hearing.

**Every terminal path silences the announcement, not just Stop.** A relay
error, an `unavailable`, a server-side stop and a dropped socket all end a
recording as finally as the button does, and each one cancels the announcer
and bumps the generation. Without that the device carries on saying "this
conversation is being recorded" into a room where it is not, and the
sentence's late resolution writes a claim onto a meeting that failed.

Cancelling reaches an utterance that has started; it cannot reach one that has
not. Suspending echo cancellation is itself a promise, so a stop can land in
the window between the suspension and `speak()` — and there the announcement
has to check for the terminal event rather than be told about it. That check
is the reason the generation is read twice in one function.

**The SERVER's mode decides whether there is a room.** `ready` echoes the mode
that was actually opened, and the announcement is reconciled against that
echo rather than against the request — otherwise an old server answering
`solo` would announce a session the strip has just relabelled solo, and the
inverse mismatch would skip an announcement a room is owed.

**The store refuses a claim a solo meeting cannot have made.** `setAnnounced`
is a no-op when the meeting's mode is `solo`. The frame is client-controlled
and this record is the evidence, so the invariant lives where the record is
written rather than being trusted of whatever opened the socket.

**The strip says REC at every width while live**, not only on the phone. A
pulsing dot was enough while the strip reported only to the person holding the
device; it announces itself to a room now, and somebody who was told they are
being recorded has to be able to look over and see that they still are.

### What this is NOT proven by

The mock engine returns a fixture's words, so no automated test can show that
a real room hears the announcement or that AssemblyAI transcribes a device
speaking through its own microphone. What the suites prove is the mechanism:
the ordering (`meeting-strip.test.ts` — speech happens only after the mic is
open and the `start` frame is away, and audio keeps reaching the socket
throughout the sentence), every fallback path, and what the record ends up
saying — including the two cases it must refuse to claim anything for, a
solo capture and a meeting stopped mid-sentence (`meetings.test.ts`,
`meeting-socket.test.ts`).

**Echo cancellation is the known hazard, and it is hedged rather than solved.**
`MEETING_CONSTRAINTS` asks for `echoCancellation: true`, and echo cancellation
exists precisely to remove the device's own speaker output from the captured
signal — which is the one moment that has to work the other way round. So the
strip suspends it for the length of the sentence (`setEchoCancellation` on the
live track) and restores it after. That is a hedge, not a proof: whether a
given browser's canceller reaches speech-synthesis output depends on whether
synthesis shares the render path it uses as its reference, and
`applyConstraints` can refuse outright (Safari has refused `echoCancellation`
on a live track). Every failure is swallowed — an announcement must never be
blocked by a hedge.

The suspension is bound to the **microphone instance** it was taken out on,
not to whichever capture the strip currently holds. Cancelling speech does not
settle its promise — the utterance can hang until its timeout — so the restore
half of an abandoned announcement can run after a second meeting has started
and is mid-sentence itself. Restoring cancellation there would silently defeat
the suspension in exactly the case it exists for. Bound to the instance, a
stale restore lands on a stopped track and does nothing.

**So `device` on the record means what it says and no more:** the browser
reported the utterance finished. It is not evidence that the sentence reached
the transcript, and nothing in the code treats it as such.

**What stays unverified as of 2026-08-30:** nobody has run this in a real room
with a live engine. The two things to check when someone does are that the
announcement is audible over a conversation, and that it appears in the
transcript at all. If it does not, the constraint suspension is the first place
to look, and the next step up is synthesizing the sentence into the audio graph
itself rather than through the speaker — a bigger change, and not one worth
making before the cheap hedge has been measured.

## Where things live

`packages/core/src/meeting.ts` (wire contract, incl. `CaptureMode` and
`RECORDING_ANNOUNCEMENT`) ·
`packages/server/src/meeting-protocol.ts` (lifecycle) ·
`packages/server/src/transcribe-assemblyai.ts` (engine) ·
`packages/server/src/meetings.ts` (store) ·
`packages/server/src/meeting-lookup.ts` (what a "pull that in" ask points
at) · `packages/server/src/meeting-notes.ts` + `meeting-notes-doc.ts` (composer +
doc sink; the two clocks live in `createPauseTicker`) · `packages/server/src/meeting-notes-merge.ts` (the merge that
keeps a person's writing, and the ownership ledger everything else asks) ·
`packages/server/src/meeting-notes-correction.ts` (which note a spoken
correction lands on, and whether it may) ·
`packages/core/src/speaker-tags.ts` (the tag grammar, its provenance, and the
late correction) + `speaker-roster.ts` (the meeting's cast) ·
`packages/markdown-app/src/speaker-reassign.ts` +
`speaker-reassign-menu.ts` (correcting one mention) ·
`packages/markdown-app/src/meeting-strip.ts`
(UI) · `packages/markdown-app/src/meeting-audio.ts` (capture + the room's
microphone config) · `packages/markdown-app/src/meeting-announce.ts` (speech
synthesis and every way it fails) · `packages/server/src/recall.ts` (vendor
client) · `recall-turns.ts` (frames → turns, naming) · `recall-status.ts` +
`recall-webhook-auth.ts` (bot state, signatures) · `recall-meeting.ts` (the
bot lifecycle) · `packages/core/src/meeting-bot.ts` (wire contract) ·
`packages/markdown-app/src/meeting-bot-row.ts` (UI) ·
`packages/core/src/meeting-timing.ts` +
`packages/markdown-app/src/meeting-timing-client.ts` (the `?timing=1`
latency measurement) · `scripts/room-labels-check.ts` +
`room-labels-score.ts` + `ami-truth.ts` (the room measurement, its
arithmetic, and the AMI corpus reference it scores against).
