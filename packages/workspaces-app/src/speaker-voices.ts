/**
 * Where the reassign menu's voices come from.
 *
 * The doc does not know its own meeting's cast: a note carries the labels it
 * happens to mention, and the voice you need is often the one the note got
 * WRONG — so a roster built from the doc's own tags would be missing exactly
 * the entry a correction needs. The meetings API knows: it has the names a
 * person gave and the transcript that says who said what.
 *
 * The most recent meeting only. A doc can carry several, and a tag does not
 * record which one it came from; asking every meeting for its transcript
 * would be several requests to answer one tap, and offering a voice from a
 * meeting three weeks ago is not the correction anybody is reaching for.
 */

import { type RosterVoice, speakerRoster } from '@feedback/core';
import { api } from './doc-path.ts';

interface MeetingSummary {
  meetingId: string;
  startedAt?: number;
  speakers?: Record<string, string>;
}

/** The latest meeting's cast, with the meeting it came from. */
export interface DocSpeakers {
  meetingId: string;
  voices: RosterVoice[];
}

/**
 * The voices of this doc's latest meeting — and WHICH meeting, because a
 * rename after the meeting is addressed to it. Null if the doc has never
 * held one.
 */
export async function loadDocSpeakers(
  docId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DocSpeakers | null> {
  const listed = await fetchImpl(api(`docs/${encodeURIComponent(docId)}/meetings`));
  if (!listed.ok) throw new Error(`meetings ${listed.status}`);
  const body = (await listed.json()) as { meetings?: MeetingSummary[] };
  const meetings = body.meetings ?? [];
  if (meetings.length === 0) return null;
  // Latest by start, falling back to the order the index returned when a row
  // predates `startedAt` — an older record is still a usable roster.
  const latest = meetings.reduce((best, m) =>
    (m.startedAt ?? 0) >= (best.startedAt ?? 0) ? m : best,
  );
  const detail = await fetchImpl(
    api(`docs/${encodeURIComponent(docId)}/meetings/${encodeURIComponent(latest.meetingId)}`),
  );
  if (!detail.ok) throw new Error(`meeting ${detail.status}`);
  const record = (await detail.json()) as {
    speakers?: Record<string, string>;
    transcript?: Array<{ text: string; speaker?: string }>;
  };
  return {
    meetingId: latest.meetingId,
    voices: speakerRoster(record.transcript ?? [], record.speakers ?? latest.speakers ?? {}),
  };
}

/** The voices of this doc's latest meeting, or none if it has never had one. */
export async function loadDocVoices(
  docId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RosterVoice[]> {
  return (await loadDocSpeakers(docId, fetchImpl))?.voices ?? [];
}

/**
 * Name a voice on a meeting that already ended — the strip's fallback once
 * the audio socket (the live rename channel) is gone. True when the server
 * recorded it; false is a refusal the caller must surface, because a name
 * that only ever lands on the screen reads as saved.
 */
export async function postSpeakerName(
  args: { docId: string; meetingId: string; speaker: string; name: string },
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const res = await fetchImpl(
    api(
      `docs/${encodeURIComponent(args.docId)}/meetings/${encodeURIComponent(args.meetingId)}/speakers`,
    ),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ speaker: args.speaker, name: args.name }),
    },
  );
  return res.ok;
}
