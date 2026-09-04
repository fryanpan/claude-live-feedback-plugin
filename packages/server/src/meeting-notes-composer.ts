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
import type { NotesComposeInput, NotesComposer, NotesTurn } from './meeting-notes.ts';
import { DEFAULT_NOTES_INSTRUCTIONS } from './notes-prompt-store.ts';
import { readKeychainPassword } from './share/keychain.ts';
import { resolveKeyFrom } from './summarize.ts';

export const NOTES_MODEL = 'claude-haiku-4-5-20251001';
const API_URL = 'https://api.anthropic.com/v1/messages';
/**
 * A reply that hits this is refused rather than truncated — cut notes would
 * REPLACE whole ones, and the next tick retries with the same words carried,
 * so nothing said is lost.
 *
 * IT IS NOT AS FAR ABOVE A LONG MEETING AS THIS COMMENT USED TO CLAIM. It
 * said the ceiling sat "well above a long meeting's notes (~2 pages of
 * bullets)"; `bun run notes:eval` measured otherwise. Whole-notes replies
 * grow with the MEETING rather than the tick, so the reply length climbs all
 * meeting and the ticks that hit the ceiling are the late ones. Across the
 * eval corpus — eight fifteen-minute excerpts — about a tenth of ticks were
 * refused this way, all of them in the second half of the longer meetings.
 *
 * A real hour-long meeting is four times the excerpt, so raising the number
 * only moves where the wall is: the shape of the fix is a compose that
 * returns a CHANGE rather than the whole notes, which is a different design
 * and not this constant. Left as measured rather than nudged, so the eval
 * keeps reporting the refusals instead of hiding them one meeting longer.
 */
const MAX_TOKENS = 2_000;
const TIMEOUT_MS = 30_000;

/** The heading contract shared with `meeting-notes-doc.ts`'s replacer. */
const HEADING_LINE = '## Meeting notes';

/**
 * Prompt building is pure and exported: what the transcript is asked to
 * become is behaviour worth pinning without a network in the test.
 *
 * `instructions` is the system prompt — the note-taking rules, which now come
 * from a store rather than from a literal here (`notes-prompt-store.ts`).
 * They default to the stored default, so every existing caller and every test
 * that built a prompt without one still gets the words it always got.
 */
export function buildNotesPrompt(
  input: NotesComposeInput,
  instructions: string = DEFAULT_NOTES_INSTRUCTIONS,
): { system: string; user: string } {
  const system = instructions;

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

  if (input.docLinks?.length) {
    parts.push(
      [
        'Material somebody in this meeting asked to have pulled in, already',
        'found. Cite it in the note that asked for it, as a markdown link.',
        'Do not summarize what is inside it — you have not read it, and the',
        'link is the answer.',
        ...input.docLinks.map((l) => `- [${l.title}](${l.url})${l.when ? ` — ${l.when}` : ''}`),
      ].join('\n'),
    );
  }

  if (input.references?.length) {
    parts.push(
      [
        'Named in this speech, and already on the board. Where a note covers',
        'one, write its name as a markdown link — [its title](its url) — the',
        'first time that note mentions it. Do not add one to a note that is',
        'not about it, and do not link the same thing twice in one note.',
        ...input.references.map(
          (r) => `- [${r.title}](${r.url}) — ${r.kind}${r.when ? `, met ${r.when}` : ''}`,
        ),
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
      .map((t) => `- ${speakerPrefix(t)}${t.text}`)
      .join('\n')}`,
  );
  return { system, user: parts.join('\n\n') };
}

/**
 * "Devi (B): " — the name to write and the label to tag with, in the one
 * place the composer reads them from. A turn the session never mapped a
 * label onto keeps the bare name; a turn with no voice at all keeps none.
 */
function speakerPrefix(turn: NotesTurn): string {
  if (!turn.speaker) return '';
  return turn.speakerLabel ? `${turn.speaker} (${turn.speakerLabel}): ` : `${turn.speaker}: `;
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
  /**
   * The note-taking instructions for this tick — `createNotesPromptStore`'s
   * `read` in the server, which re-reads the operator's file every call.
   * Absent, the built-in default: a composer constructed without a data dir
   * still composes, it just cannot be retuned without a deploy.
   */
  instructions?: () => string;
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
      const { system, user } = buildNotesPrompt(input, opts.instructions?.());
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
