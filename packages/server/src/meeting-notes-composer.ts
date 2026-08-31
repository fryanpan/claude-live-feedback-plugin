/**
 * The real notes composer: one Haiku call per pause, in, the whole notes
 * section out.
 *
 * SAME CONSENT SEAM AS THE SUMMARIZER. What leaves the machine here is the
 * meeting transcript itself — the most sensitive content this server holds —
 * so the key is the same DEDICATED entry thread summaries use
 * (`claude-workspaces-summary-api-key` / CW_SUMMARY_API_KEY), and a generic
 * `ANTHROPIC_API_KEY` in the environment is deliberately not honoured.
 * Outbound Haiku use from this server was approved 2026-08-10; adding the
 * dedicated key is the operator's act of consent. No key → `null` → meetings
 * record transcripts and compose nothing, which the caller logs as the
 * configured-off state, not an error.
 *
 * FAILURE THROWS, UNLIKE THE SUMMARIZER'S NULL. A summary that fails leaves
 * a deterministic card line standing; failed notes have no fallback text —
 * what they have is the session's carry (`beginNotesSession`), which needs a
 * rejection to know the tick's words must ride the next one. So a refused
 * call, a cut reply, an empty reply: all throw, and none of them ever log
 * the key.
 */

import { readRenamedEnv } from '@feedback/core/env-names';
import type { NotesComposeInput, NotesComposer } from './meeting-notes.ts';
import { readKeychainPassword } from './share/keychain.ts';
import { resolveKeyFrom } from './summarize.ts';

export const NOTES_MODEL = 'claude-haiku-4-5-20251001';
const API_URL = 'https://api.anthropic.com/v1/messages';
/**
 * Whole-notes replies grow with the meeting, not the tick, so this sits well
 * above a long meeting's notes (~2 pages of bullets). A reply that still
 * hits it is refused rather than truncated — cut notes would REPLACE whole
 * ones, and the next tick retries with the same words carried.
 */
const MAX_TOKENS = 2_000;
const TIMEOUT_MS = 30_000;

/** The heading contract shared with `meeting-notes-doc.ts`'s replacer. */
const HEADING_LINE = '## Meeting notes';

/**
 * Prompt building is pure and exported: what the transcript is asked to
 * become is behaviour worth pinning without a network in the test.
 */
export function buildNotesPrompt(input: NotesComposeInput): { system: string; user: string } {
  const system = [
    'You are the live note-taker for a working meeting. You receive the notes',
    'as they currently stand and the speech newly transcribed since the last',
    'update. Return the COMPLETE notes as they should now read.',
    '',
    'Rules:',
    `- Start with the exact heading "${HEADING_LINE}".`,
    '- Keep notes short and structured: grouped bullets, with bold labels or',
    '  ### subheadings only when the meeting has clear strands — decisions,',
    '  action items (with owner when one was named), open questions, key',
    '  points. Never a transcript restated.',
    '- REVISE rather than append: fold the new speech into the existing',
    '  structure, and correct earlier notes the new speech overturns.',
    '- SOME LINES OF THE CURRENT NOTES WERE WRITTEN BY A PERSON IN THE',
    '  MEETING, and are listed under "Written by a person". They are theirs:',
    '  reproduce each one character for character, in the place it sits, and',
    '  keep the wording, the formatting and the structure they chose. If you',
    '  think one should read differently, return your version of that line in',
    '  its place and nothing else will change: it reaches them as a suggestion',
    '  they can accept or reject, never as a replacement. Never delete one,',
    '  and never merge one into a note of your own.',
    '- Only what was said: never invent names, numbers, or decisions the',
    '  transcript does not contain. Transcription is imperfect — where a word',
    '  is garbled, prefer the reading that fits the project context.',
    '- Transcript lines may be prefixed with who said them. Use that to name',
    '  the owner of an action item or the side of a disagreement; a label like',
    '  "Speaker B" is a voice nobody has named yet — keep it as written, never',
    '  guess who it is.',
    '- Output markdown only: no preamble, no code fences, nothing after the',
    '  notes.',
  ].join('\n');

  const parts: string[] = [];
  const ctx = input.context;
  const ctxLines: string[] = [];
  if (ctx?.docTitle) ctxLines.push(`- Meeting doc: ${ctx.docTitle}`);
  if (ctx?.repoRoot) ctxLines.push(`- Repository: ${ctx.repoRoot}`);
  if (ctx?.docPaths?.length) ctxLines.push(`- Project docs: ${ctx.docPaths.join(', ')}`);
  if (ctx?.taskTitles?.length) {
    ctxLines.push('- Open board tasks (the work likely under discussion):');
    for (const title of ctx.taskTitles) ctxLines.push(`  - ${title}`);
  }
  if (ctxLines.length > 0) parts.push(`Project context:\n${ctxLines.join('\n')}`);

  if (input.taskLinks?.length) {
    parts.push(
      [
        'Board tasks captured from this speech. Where a note covers one, cite',
        'it as a markdown link — [its title](its url), or your own words as',
        'the label when the note reads better that way. Keep links already in',
        'the notes.',
        ...input.taskLinks.map((l) => `- [${l.title}](${l.url}) — ${l.status}`),
      ].join('\n'),
    );
  }

  parts.push(
    `Current notes:\n${input.previous ?? '(none yet — this is the first update of the meeting)'}`,
  );
  if (input.humanNotes?.length) {
    parts.push(
      ['Written by a person — reproduce verbatim:', ...input.humanNotes.map((n) => `- ${n}`)].join(
        '\n',
      ),
    );
  }
  parts.push(
    `New transcript since the last update:\n${input.tick.turns
      .map((t) => `- ${t.speaker ? `${t.speaker}: ` : ''}${t.text}`)
      .join('\n')}`,
  );
  return { system, user: parts.join('\n\n') };
}

/**
 * A reply the doc can hold: fences stripped (models wrap markdown in
 * markdown), and the heading restored when the model forgot it — without it
 * the section replacer could never find this write again.
 */
export function sanitizeNotesReply(raw: string): string {
  let text = raw.trim();
  const fenced = text.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/);
  if (fenced?.[1] !== undefined) text = fenced[1].trim();
  if (!/^#{1,6}\s/.test(text)) text = `${HEADING_LINE}\n\n${text}`;
  return text;
}

export interface HaikuNotesComposerOpts {
  /** Tests: a key (or `null` for the explicit no-key state) without Keychain. */
  apiKey?: string | null;
  /** Tests: the HTTP seam. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** Printed once per process, because the transcript leaving the machine must
 *  never be the silent case. */
let announcedOn = false;

/**
 * Construct the real composer, or `null` when the operator has not opted in
 * (no dedicated key) or has opted out (`CW_MEETING_NOTES=0`).
 */
export function createHaikuNotesComposer(opts: HaikuNotesComposerOpts = {}): NotesComposer | null {
  if (readRenamedEnv(process.env, 'CW_MEETING_NOTES') === '0') return null;
  const key = resolveKeyFrom(opts.apiKey, readKeychainPassword);
  if (!key) return null;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  return {
    name: 'haiku',
    async compose(input: NotesComposeInput): Promise<string> {
      if (!announcedOn) {
        announcedOn = true;
        console.log(
          '[meeting-notes] live notes ON: meeting transcript text is sent to ' +
            'api.anthropic.com. Turn off with CW_MEETING_NOTES=0.',
        );
      }
      const { system, user } = buildNotesPrompt(input);
      const ctl = new AbortController();
      const timeout = setTimeout(() => ctl.abort(), TIMEOUT_MS);
      try {
        const res = await fetchImpl(API_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: NOTES_MODEL,
            max_tokens: MAX_TOKENS,
            system,
            messages: [{ role: 'user', content: user }],
          }),
          signal: ctl.signal,
        });
        // The status is safe to surface; the key never is.
        if (!res.ok) throw new Error(`notes compose HTTP ${res.status}`);
        const body = (await res.json()) as {
          content?: Array<{ text?: string }>;
          stop_reason?: string | null;
        };
        if (body.stop_reason === 'max_tokens') {
          throw new Error('notes compose hit max_tokens; refusing a truncated section');
        }
        const text = body.content?.map((b) => b.text ?? '').join('') ?? '';
        if (!text.trim()) throw new Error('notes compose returned an empty reply');
        return sanitizeNotesReply(text);
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
