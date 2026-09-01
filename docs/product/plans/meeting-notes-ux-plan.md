# Meeting notes prototype — UX plan

Seeded from Bryan's feedback list on the meeting-notes prototype task. The raw list is preserved at the bottom, unedited. Everything above it is the planning layer: what each item actually is, what it costs, and the order I think we should do them in.

Comment anywhere. Where I have made a call you disagree with, say so on the line — I would rather re-order this than build the wrong half first.

# Proposed workstreams

## A. Transcription and notetaking feel reliable and effortless enough

**Bryan** can talk through a meeting and watch usable notes appear at the end of the doc, keeping everything he wrote himself, **so that** the notetaker feels like an expert tech writer taking high quality notes, with project understanding, rather than something he has to supervise.

**Solution:** make the notetaker append-only and aware of concurrent human edits, move the live text out of the header into a clearly-provisional block at the insertion point, and drop the colour blocks.

### Problems

Notetaking does not feel reliable or effortless yet.  Needs work!

- Live text living in the header draws eye away from where polished note are being generated
- Notes got lost when I stopped and restarted recording (recording replaces all existing notes)
- Notes got inserted in the top in the original Meeting notes section, not at the end of the doc
- Transcription speed is slow -- transcribe faster when an idea or pause happens, but keep it high quality(endpoint detection in the speech to text model might be helpful here)
- Color blocks are not useful at the moment

### Acceptance Criteria

1. **Better + reliable transcript insert**
  1. For now, notetaker always insert at the end of the docUnless the topic being discussed clearly belongs elsewhere and notetaker can then revise an older note
  2. Notetaker should be aware of synchronous human edits and take those into account
    1. Notetaker should not rewrite human edits, and should offer suggestions instead
  3. Show provisional text in a clearly-provisional block at the end of the doc
  4. Have a transition where a settled chunk splits off and gets processed while remainder continues to stream
  5. Reduce transcription delay when an idea or pause happense by changing settings and using endpoint detection if available
2. **Colour blocks come out** entirely; speaker tags stay but only appear in multi-speaker sessions.
3. **Bullet fixes**
  1. Bullet indent level should start to the right of body text
  2. Single bullets should be indentable too
  3. If I hit enter and split a numbered list and then delete, the list should coalesce back into sequential numbering

## B. Actions actually fire and increase productivity during meeting

Human participants have easy ways to ask for agents to help organize, plan, or do work during a meeting.  Or to answer questions to improve understanding.  So that they feel like they have a significant productivity multiplier DURING the meeting.

The set of triggers and actions that help a team (or Bryan) be more productive will vary and grow over time.

**Solution:** two separable halves — detect the ask even when it spans two ticks of speech, and know whether a lead agent is attached and able to answer within about a minute, saying so plainly when none is. A silent no-op is what made this feel broken.

### Problems

For actions to increase productivity, they need to be little to no effort for the human participants.  But they also need to add significant value. The set of actions will incre

- Actions other than transcribing did not fire at all — plan, research and create-a-task each did nothing
  - Asked to create a task to count to 10 and sum the numbers, and asked for a todo about scheduled tasks. Neither became a task
- No lead agent was connected to answer comments, and nothing told us that
- A meeting can silently have nobody home

### Acceptance Criteria

1. **Spoken actions fire, and there's also a quick 1-2 tap interface to trigger these from iPad**These basic actions ideally can trigger just from understanding requests in the transcript.  As a fallback that may also work better, also support having quick UX interactions
  1. Plan Next Steps — the lead agent uses full project context plus the notes so far and writes a plan into the doc
    1. Available as an option floating at the bottom of the screen at any time -- triggers lead agent to review notes and write out plan for next steps with inline linked tasks
  2. Ask Clarifying Questionse.g. to get more product details or engineering details
    1. Available as an option floating at the bottom of the screen
    2. Lead agent reviews meeting notes (and raw transcript) so far and in the meeting notes, adds comments with questions(may use review items or decision items where useful)
  3. Actions from a snippet of text (from clicking, you select a sentence automatically, or can drag select)
    1. Research — the agent writes a placeholder section immediately, then fills it with what it finds on the referenced topic
    2. Create a task or a todo — it lands on the board as a real row, not as a note about one
      1. Should trigger if a todo or task comes up during conversation
  4. An ask that spans two ticks of speech is recognised as one request
2. **A meeting knows whether an agent is attached**
  1. Attached means able to answer within about a minute, not merely connected
  2. When none is attached, the meeting says so plainly instead of silently doing nothing
  3. Still to decide: a banner in the doc, or refusing to start the recording
3. **Make a mockup and iterate before implementing**

## C. Comments and review items are easy to find

**Bryan** can find an agent's questions and answer each one where it applies **so that** a request to plan comes back as questions in context, not a wall of twelve in a single comment.

**Solution:** anchor each question inline to the text it is about, mark threads that carry an open review item, and show a count of comments off-screen above and below. The anchoring is the root-cause fix — an agent piles questions into one comment when it has nowhere better to put them.

### Problems

- Review items are hard to see inside comment threads
- An agent answered a request to plan with a dozen questions in one comment, instead of asking each one where it applied
- No information scent for comments above or below the current scroll point

### Acceptance Criteria

1. **Questions attach to the text they are about**
  1. An agent with several questions files them inline, each anchored to the sentence it applies to
  2. This is the root-cause fix — a wall of twelve questions is what an agent produces when it has nowhere better to put themAgent already has tools to do this, but should just have instructions to make sure it puts questions in the right place
2. **An open review item is visible without opening the thread**
  1. A thread carrying one is marked as such where the thread sits
3. **The margin shows what is off-screen**
  1. A count of comments above and below the current viewport
4. **Make a mockup and iterate before implementing**

## D. Start-recording stops asking what it does not need

**Bryan** can start recording without answering questions that have no answer **so that** beginning a meeting is one tap when it is just him.

**Solution:** drop the consent step in a solo session, and drop the engine choice when a meeting bot is the source — subject to confirming whether we transcribe the vendor's raw audio ourselves or take their transcript.

### Problems

- Asked for consent when it was just me
- Offered an engine choice when the audio was coming from a meeting bot

### Acceptance Criteria

1. **No consent step in a solo session**
2. **No engine choice when the source is a bot**
  1. Depends on one fact I will confirm before touching the screen: whether we take raw streaming audio from the bot vendor and transcribe it ourselves, or take the vendor's transcript. If it is the vendor's, the choice is meaningless there and disappears

## Order I would work them in

A, then B, then C, then D.

A is first because everything else is judged inside a document that is currently mangling itself, and because the provisional-text mockup needs your eyes before anything is built. B is second because a meeting where nothing happens when you ask is the failure you hit hardest. C third: it is real, but it degrades to "annoying" rather than "broken". D is small and subtractive and can ride along. The old E, faster notes after a pause, is gone as a separate item — you folded it into A, where the transcription-delay problem and its acceptance criterion now live.

**Say if you want a different order** — in particular, B before A is defensible if the agent-not-answering case is what stops you using it.

## What I need from you

1. Agree or change the order above.
  1. Agree
2. The provisional-text mockup: I will build it next and put it in front of you

  before any of A is implemented.
  1. Yes, thank you
3. One open question left, in B: when no lead agent is available, is the right behaviour a banner in the doc or refusing to start the recording?
  1. Show a clear warning banner, but don't block the recording or meetingThe lead agent can come help when reconnected

## Original feedback, unedited

**List of UX feedback to address in the meeting notes prototype:**

- Bullets in each color segment show up one level higher than the body text (i.e. indented left)
- When I have only one bullet, I can't indent right but I want to
- In the doc linked on the ticket, after we'd written out Pain Points, I paused for a while, did some editing. And then new recordings started appearing at the top instead of at the bottom
  - New content should always appear at the bottom, unless it's something that's an edit to existing content
- **Better transcription feedback**
  - **Different location**
    - Having the live text up top is distracting, cause I have to look in two places at once. Can we have the provisional text somewhere closer to where the final output will be?
    - Try a provisional live text box where we're about to insert new edits and make it part of the doc instead of the header. But make it clearly provisional (show me a mockup of this). Make this the default option (and also provide the other option)
    - When that chunk of text gets converted, have a smooth transition
      - Split off the chunk that's being handled and show that it's being processed
      - Transition remaining unhandled text into a new chunk that continues getting real-time streaming feedback
  - **Faster response time to notes**
    - Is there a way to get faster from a pause in the speech or end of a thought and turn it into notes? e.g. via endpoint detection?
- **Recording/note taking bugs**
  - **Buggy when I stopped recording then restarted**
    - Replaced my existing meeting notes up in the Meeting notes section
    - But didn't replace the Pain Points
    - Expected instead that it would continue taking notes at the end of the doc (or wherever was appropriate)
  - **"Just so everyone knows"**
    - Started getting played repeatedly every 15-30s or so, and I wasn't getting any notes (but live stream seemed to be active) (around 9:16AM)
- **During "start recording", UX improvements:**
  - No need to ask for consent if it's just me
  - If the source is Zoom/Google, then there are no engine choices, I think? Unless we're getting raw streaming audio from the bot vendor and processing it ourselves?
- **Agent wasn't available or connected to answer questions?**
  - Would be helpful to make sure the setup always has the lead agent available in a form where it can handle requests in under a minute
  - And if there's no lead agent connected, warn us
- **Review Items Hidden**
  - Review Items are hard to see inside the comment threads
  - If there are review items, please find a way to highlight that there are open questions in the comment thread
- **Comments hidden / misplaced**
  - When an agent wrote back a big long string reply to my request to plan, it put in a dozen questions or so in a single comment, instead of asking in context of what that question was about
  - Put comments inline in the doc so far attached to the text that they apply to
  - And the comment margin on the right should show a preview of how many comments are offscreen above or below what we can show on the current page
- **Speaker tags appeared in a single-person huddle**
  - These are not needed
- **Color blocks are not helpful**
  - It's not clear what the colors mean and they're quite fickle. Let's leave the colors out for now, and just have Speaker tags for multi-speaker sessions
- **Actions other than transcribing are not working reliably yet**
  - Can we try at a minimum to get these actions triggering properly
    - Help us make a plan for how to do something (lead agent uses full project context and meeting notes so far to create a plan)
    - Help us research (any request for research) (Usually on a specifically referenced topic - agent does research and fills it into a section in the doc. Writes a placeholder to start)
    - Add a todo or a task to create a task
      - I asked to create a task to count to 10 and provide sum of all numbers counted
      - Asked to create a todo item to have scheduled tasks -- neither one turned into a task
